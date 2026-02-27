from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import StreamingResponse, FileResponse
from pydantic import BaseModel
import json
import ollama
from typing import List, Dict, Any, AsyncGenerator
from contextlib import asynccontextmanager

from config import OLLAMA_HOST, MODEL_NAME, PORT, MAX_TOOL_ROUNDS, TEAM_MEMBERS, TEAM_LEADER
from tools import TOOLS, dispatch_tool

# 导出只包含 python_exec 的工具列表（给普通角色使用）
PYTHON_ONLY_TOOLS = [t for t in TOOLS if t.get("function", {}).get("name") == "python_exec"]

@asynccontextmanager
async def lifespan(app: FastAPI):
    print(f"[config] OLLAMA_HOST = {OLLAMA_HOST}")
    print(f"[config] MODEL_NAME  = {MODEL_NAME}")
    print(f"[config] PORT        = {PORT}")
    yield

app = FastAPI(title="ChatGPT-like Web Interface", lifespan=lifespan)

# 配置 CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ──────────────────────────────────────────────────────────────
# Pydantic 模型
# ──────────────────────────────────────────────────────────────
class Message(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    messages: List[Message]
    temperature: float = 0.7
    max_tokens: int = 10240
    stream: bool = True


# ──────────────────────────────────────────────────────────────
# 核心流式循环（供所有模式复用）
# ──────────────────────────────────────────────────────────────
async def _streaming_loop(
    client: ollama.AsyncClient,
    conversation: List[Dict[str, Any]],
    temperature: float,
    max_tokens: int,
    tools: List[Dict[str, Any]] | None = None,
) -> AsyncGenerator[Dict[str, Any], None]:
    """
    处理多轮流式调用（含工具调用），逐个 yield event dict：
      {"type": "thinking", "text": "..."}
      {"type": "content",  "text": "..."}
      {"type": "tool_request", "tool": "...", "args": {...}}
      {"type": "tool_result",  "tool": "...", "result": {...}}
    """
    ctx: List[Dict[str, Any]] = list(conversation)

    for _ in range(MAX_TOOL_ROUNDS):
        stream_response = await client.chat(
            model=MODEL_NAME,
            messages=ctx,
            stream=True,
            tools=TOOLS if tools is None else tools,
            options={"temperature": temperature, "num_predict": max_tokens},
        )

        collected_content: List[str] = []
        collected_thinking: List[str] = []
        collected_tool_calls: List[Dict[str, Any]] = []

        async for chunk in stream_response:
            msg = chunk.get("message") or {}
            thinking = msg.get("thinking")
            content = msg.get("content")
            tool_calls = msg.get("tool_calls") or []

            if isinstance(thinking, str) and thinking:
                collected_thinking.append(thinking)
                yield {"type": "thinking", "text": thinking}
            if isinstance(content, str) and content:
                collected_content.append(content)
                yield {"type": "content", "text": content}
            if tool_calls:
                collected_tool_calls = tool_calls

        # 整理本轮 assistant 消息并追加到上下文
        assistant_msg: Dict[str, Any] = {"role": "assistant"}
        full_content = "".join(collected_content).strip()
        full_thinking = "".join(collected_thinking).strip()
        if full_content:
            assistant_msg["content"] = full_content
        if full_thinking:
            assistant_msg["thinking"] = full_thinking
        if collected_tool_calls:
            assistant_msg["tool_calls"] = collected_tool_calls
        if assistant_msg.keys() - {"role"}:
            ctx.append(assistant_msg)

        # 无工具调用：本轮正常结束
        if not collected_tool_calls:
            return

        # 执行工具并追加结果
        for tool_call in collected_tool_calls:
            function_data = tool_call.get("function") or {}
            tool_name = function_data.get("name", "")
            args = function_data.get("arguments") or {}

            yield {"type": "tool_request", "tool": tool_name, "args": args}

            tool_result = dispatch_tool(tool_name, function_data.get("arguments"))

            yield {"type": "tool_result", "tool": tool_name, "result": tool_result}

            tool_msg: Dict[str, Any] = {
                "role": "tool",
                "name": tool_name,
                "content": json.dumps(tool_result, ensure_ascii=False),
            }
            tool_call_id = tool_call.get("id")
            if tool_call_id:
                tool_msg["tool_call_id"] = tool_call_id
            ctx.append(tool_msg)

    # 超出轮次上限
    yield {"type": "content", "text": "工具调用轮次达到上限，请缩小问题范围后重试。"}


def _sse_from_event(event: Dict[str, Any]) -> str:
    """将 _streaming_loop event 转换为 SSE 字符串（含双换行）。"""
    if event["type"] == "thinking":
        return f"data: {json.dumps({'choices': [{'delta': {'thinking': event['text']}}]})}\n\n"
    if event["type"] == "content":
        return f"data: {json.dumps({'choices': [{'delta': {'content': event['text']}}]})}\n\n"
    if event["type"] == "tool_request":
        return f"data: {json.dumps({'tool_event': {'type': 'request', 'tool': event['tool'], 'arguments': event['args']}}, ensure_ascii=False)}\n\n"
    if event["type"] == "tool_result":
        return f"data: {json.dumps({'tool_event': {'type': 'result', 'tool': event['tool'], 'result': event['result']}}, ensure_ascii=False)}\n\n"
    return ""


# ──────────────────────────────────────────────────────────────
# 路由：普通聊天
# ──────────────────────────────────────────────────────────────
@app.post("/api/chat")
async def chat(request: ChatRequest):
    """普通单 Agent 聊天，支持流式响应。"""
    outgoing = [{"role": m.role, "content": m.content} for m in request.messages]

    if request.stream:
        async def generate():
            try:
                client = ollama.AsyncClient(host=OLLAMA_HOST)
                async for event in _streaming_loop(client, outgoing, request.temperature, request.max_tokens, tools=PYTHON_ONLY_TOOLS):
                    sse = _sse_from_event(event)
                    if sse:
                        yield sse
                yield "data: [DONE]\n\n"
            except Exception as e:
                yield f"data: {json.dumps({'error': str(e)})}\n\n"

        return StreamingResponse(generate(), media_type="text/event-stream")

    # 非流式：收集全部内容后返回
    try:
        client = ollama.AsyncClient(host=OLLAMA_HOST)
        full_content, full_thinking = "", ""
        async for event in _streaming_loop(client, outgoing, request.temperature, request.max_tokens, tools=PYTHON_ONLY_TOOLS):
            if event["type"] == "content":
                full_content += event["text"]
            elif event["type"] == "thinking":
                full_thinking += event["text"]
        return {
            "choices": [{"message": {"role": "assistant", "content": full_content, "thinking": full_thinking}}]
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ──────────────────────────────────────────────────────────────
# 路由：团队聊天
# ──────────────────────────────────────────────────────────────
@app.post("/api/chat/team")
async def chat_team(request: ChatRequest):
    """团队多 Agent 聊天：Rex / Nova / Vera 顺序回答 → Sage 综合总结。"""
    outgoing = [{"role": m.role, "content": m.content} for m in request.messages]

    async def generate():
        try:
            client = ollama.AsyncClient(host=OLLAMA_HOST)
            member_answers: Dict[str, str] = {}

            # ── 三位成员依次回答（不使用工具，专注回答） ──────────────────────────────
            for member in TEAM_MEMBERS:
                member_system = member["system_prompt"]
                member_ctx = [
                    {"role": "system", "content": member_system},
                    *outgoing,
                ]
                meta = {k: member[k] for k in ("id", "name", "display_name", "avatar")}
                yield f"data: {json.dumps({'team_event': {'type': 'member_start', **meta}}, ensure_ascii=False)}\n\n"

                full_content = ""
                async for event in _streaming_loop(client, member_ctx, request.temperature, request.max_tokens, tools=PYTHON_ONLY_TOOLS):
                    sse = _sse_from_event(event)
                    if sse:
                        yield sse
                    if event["type"] == "content":
                        full_content += event["text"]

                member_answers[member["id"]] = full_content
                yield f"data: {json.dumps({'team_event': {'type': 'member_end', 'id': member['id']}}, ensure_ascii=False)}\n\n"

            # ── 组长综合总结 ────────────────────────────────────
            original_question = outgoing[-1]["content"] if outgoing else ""
            member_sections = "\n\n".join(
                f"<{m['id']}>\n{member_answers.get(m['id'], '（无回答）')}\n</{m['id']}>"
                for m in TEAM_MEMBERS
            )
            # 组长的用户消息：包含原始问题 + 成员参考（作为内部背景）
            # 提示词明确告诉组长：仅作参考，不需在回复中提及
            leader_user_msg = (
                f"问题：{original_question}\n\n"
                f"背景参考（内部分析，仅供参考）：\n{member_sections}"
            )
            leader_system = TEAM_LEADER["system_prompt"]
            leader_ctx = [
                {"role": "system", "content": leader_system},
                {"role": "user", "content": leader_user_msg},
            ]
            leader_meta = {k: TEAM_LEADER[k] for k in ("id", "name", "display_name", "avatar")}
            yield f"data: {json.dumps({'team_event': {'type': 'leader_start', **leader_meta}}, ensure_ascii=False)}\n\n"

            leader_answer = ""
            async for event in _streaming_loop(client, leader_ctx, request.temperature, request.max_tokens, tools=PYTHON_ONLY_TOOLS):
                sse = _sse_from_event(event)
                if sse:
                    yield sse
                if event["type"] == "content":
                    leader_answer += event["text"]

            yield f"data: {json.dumps({'team_event': {'type': 'leader_end', 'id': TEAM_LEADER['id']}}, ensure_ascii=False)}\n\n"

            yield "data: [DONE]\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")


# ──────────────────────────────────────────────────────────────
# 路由：健康检查 / 静态文件
# ──────────────────────────────────────────────────────────────
@app.get("/api/health")
async def health_check():
    """健康检查接口"""
    try:
        client = ollama.AsyncClient(host=OLLAMA_HOST)
        await client.list()
        ollama_status = "ok"
    except Exception:
        ollama_status = "unreachable"
    return {"status": "ok", "ollama_status": ollama_status, "model": MODEL_NAME}


app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
async def read_root():
    return FileResponse("static/index.html")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=PORT)
