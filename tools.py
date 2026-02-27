"""
tools.py — 工具定义、执行与记忆管理
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List

from config import (
    PYTHON_TOOL_TIMEOUT_SECONDS,
    PYTHON_TOOL_MAX_OUTPUT_CHARS,
    MAX_MEMORY_CHARS,
    MEMORY_FILE as _MEMORY_FILE,
)
MEMORY_FILE = Path(_MEMORY_FILE)

# ──────────────────────────────────────────────────────────────
# 记忆管理（单条字符串，覆盖写入）
# ──────────────────────────────────────────────────────────────

def load_memories() -> str:
    """从 MEMORY_FILE 读取记忆并返回字符串，无内容时返回空字符串。"""
    if MEMORY_FILE.exists():
        try:
            data = json.loads(MEMORY_FILE.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return str(data.get("content", ""))
        except Exception:
            pass
    return ""


def _save_memories(content: str) -> None:
    """将记忆字符串保存到 MEMORY_FILE。"""
    MEMORY_FILE.write_text(
        json.dumps({"content": content}, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def get_memory_system_prompt() -> str:
    """实时读取记忆文件并返回系统提示文本。"""
    content = load_memories()
    if not content:
        return ""
    return (
        "以下是你记录的关于用户的偏好与最近行为的记忆，请结合这些信息个性化你的回答：\n"
        + content
    )


# ──────────────────────────────────────────────────────────────
# 工具：memory_tool
# ──────────────────────────────────────────────────────────────
def run_memory_tool(content: str | None = None) -> Dict[str, Any]:
    """覆盖写入全部记忆内容。content 超过 MAX_MEMORY_CHARS 时自动截断。"""
    if not content:
        return {"ok": False, "error": "需要提供 content"}
    if len(content) > MAX_MEMORY_CHARS:
        content = content[:MAX_MEMORY_CHARS]
    _save_memories(content)
    return {"ok": True, "content": content}


# ──────────────────────────────────────────────────────────────
# 工具：python_exec
# ──────────────────────────────────────────────────────────────
def _truncate_text(text: str, max_chars: int = PYTHON_TOOL_MAX_OUTPUT_CHARS) -> str:
    if len(text) <= max_chars:
        return text
    half = max_chars // 2
    return f"{text[:half]}\n...<truncated>...\n{text[-half:]}"


def run_python_tool(code: str) -> Dict[str, Any]:
    code = (code or "").strip()
    if not code:
        return {"ok": False, "error": "code is empty"}
    try:
        completed = subprocess.run(
            [sys.executable, "-c", code],
            capture_output=True,
            text=True,
            timeout=PYTHON_TOOL_TIMEOUT_SECONDS,
        )
        return {
            "ok": completed.returncode == 0,
            "returncode": completed.returncode,
            "stdout": _truncate_text(completed.stdout or ""),
            "stderr": _truncate_text(completed.stderr or ""),
        }
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"python execution timed out after {PYTHON_TOOL_TIMEOUT_SECONDS}s"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ──────────────────────────────────────────────────────────────
# 工具注册表
# ──────────────────────────────────────────────────────────────
TOOLS: List[Dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "python_exec",
            "description": "执行一段 Python 代码并返回 stdout/stderr/返回码。适合计算、数据处理和验证中间结果。",
            "parameters": {
                "type": "object",
                "properties": {
                    "code": {
                        "type": "string",
                        "description": "要执行的 Python 代码"
                    }
                },
                "required": ["code"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "memory_tool",
            "description": (
                "覆盖写入关于用户的长期记忆（偏好、习惯、近期行为摘要）。"
                "每次调用都会用新内容完整替换旧记忆，请将所有需要保留的信息一次性写入。"
                f"内容限制为 {MAX_MEMORY_CHARS} 字符，超过部分自动截断。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "content": {
                        "type": "string",
                        "description": f"要保存的全部记忆内容，不超过 {MAX_MEMORY_CHARS} 字符"
                    }
                },
                "required": ["content"]
            }
        }
    },
]


# ──────────────────────────────────────────────────────────────
# 工具参数规范化
# ──────────────────────────────────────────────────────────────
def _normalize_tool_arguments(raw_args: Any) -> Dict[str, Any]:
    if isinstance(raw_args, dict):
        return raw_args
    if isinstance(raw_args, str):
        try:
            parsed = json.loads(raw_args)
            if isinstance(parsed, dict):
                return parsed
            return {"code": raw_args}
        except Exception:
            return {"code": raw_args}
    return {}


# ──────────────────────────────────────────────────────────────
# 统一工具调度入口
# ──────────────────────────────────────────────────────────────
def dispatch_tool(tool_name: str, raw_args: Any) -> Dict[str, Any]:
    """根据工具名称调度执行，统一返回结果字典。"""
    args = _normalize_tool_arguments(raw_args)

    if tool_name == "python_exec":
        return run_python_tool(str(args.get("code", "")))

    if tool_name == "memory_tool":
        return run_memory_tool(content=args.get("content"))

    return {"ok": False, "error": f"unknown tool: {tool_name}"}
