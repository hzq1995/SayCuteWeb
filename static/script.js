// 全局变量
let messages = [];
let isGenerating = false;
let currentMode = localStorage.getItem('chatMode') || 'team'; // 'normal' | 'team' 模式记忆

// DOM 元素
const messagesContainer = document.getElementById('messages');
const messageInput = document.getElementById('messageInput');
const sendButton = document.getElementById('sendButton');
const newChatBtn = document.getElementById('newChatBtn');
const statusIndicator = document.getElementById('status');
const modelInfo = document.getElementById('modelInfo');

// Markdown 渲染配置
marked.setOptions({
    gfm: true,
    breaks: true,
});

function renderMath(element) {
    // KaTeX auto-render（若 CDN 加载失败则跳过）
    if (typeof renderMathInElement !== 'function' || !element) return;
    try {
        renderMathInElement(element, {
            delimiters: [
                { left: '$$', right: '$$', display: true },
                { left: '$', right: '$', display: false },
                { left: '\\(', right: '\\)', display: false },
                { left: '\\[', right: '\\]', display: true },
            ],
            throwOnError: false,
        });
    } catch (e) {
        console.warn('KaTeX render failed:', e);
    }
}

function highlightCodeBlocks(element) {
    if (!element) return;
    const codeBlocks = element.querySelectorAll('pre code');
    codeBlocks.forEach((codeBlock) => {
        const className = codeBlock.className || '';
        const languageClass = className.split(' ').find((item) => item.startsWith('language-'));
        if (languageClass && codeBlock.parentElement) {
            codeBlock.parentElement.setAttribute('data-lang', languageClass.replace('language-', '').toUpperCase());
        }

        if (window.hljs && typeof window.hljs.highlightElement === 'function') {
            window.hljs.highlightElement(codeBlock);
        }
    });
}

function renderMarkdownWithMath(element, markdownText) {
    element.innerHTML = marked.parse(markdownText || '');
    renderMath(element);
    highlightCodeBlocks(element);
}

function escapeHtml(text) {
    const value = String(text ?? '');
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function appendToolLog(toolsWrap, toolsContent, event) {
    if (!toolsWrap || !toolsContent || !event) return;

    toolsWrap.style.display = 'block';

    const item = document.createElement('div');
    item.className = `tool-log-item ${event.type || 'event'}`;

    const title = document.createElement('div');
    title.className = 'tool-log-title';

    if (event.type === 'request') {
        title.textContent = `调用工具：${event.tool || 'unknown'}`;
    } else if (event.type === 'result') {
        title.textContent = `工具返回：${event.tool || 'unknown'}`;
    } else {
        title.textContent = `工具事件：${event.tool || 'unknown'}`;
    }

    const payload = document.createElement('pre');
    payload.className = 'tool-log-payload';

    const body = event.type === 'request'
        ? (event.arguments ?? {})
        : (event.result ?? event);
    payload.innerHTML = escapeHtml(JSON.stringify(body, null, 2));

    item.appendChild(title);
    item.appendChild(payload);
    toolsContent.appendChild(item);
}

function extractThinking(rawText) {
    // 解析 <think>...</think> 或 <thinking>...</thinking>
    // 返回：{ thinking, answer }
    const text = rawText || '';
    const tagRegex = /<(think|thinking)>([\s\S]*?)<\/(think|thinking)>/gi;

    let thinking = '';
    let answer = text;
    let match;
    let consumed = '';
    while ((match = tagRegex.exec(text)) !== null) {
        thinking += (thinking ? '\n' : '') + (match[2] || '').trim();
        consumed += match[0];
    }
    if (consumed) {
        answer = text.replace(tagRegex, '').trim();
    }
    return { thinking: thinking.trim(), answer };
}

// 初始化
document.addEventListener('DOMContentLoaded', () => {
    checkHealth();
    setupEventListeners();
    messageInput.focus();
    greetOnFirstLoad();
});

function greetOnFirstLoad() {
    if (messages.length > 0 || isGenerating) {
        return;
    }
    messageInput.value = '你好。';
    sendMessage();
}

// 设置事件监听器
function setupEventListeners() {
    // 发送按钮
    sendButton.addEventListener('click', sendMessage);
    
    // 回车发送，Shift+回车换行
    messageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });
    
    // 自动调整输入框高度
    messageInput.addEventListener('input', autoResize);
    
    // 新对话按钮
    if (newChatBtn) {
        newChatBtn.addEventListener('click', clearChat);
    }

    // 模式切换 Tab
    const tabNormal = document.getElementById('tabNormal');
    const tabTeam   = document.getElementById('tabTeam');
    if (tabNormal && tabTeam) {
        // 根据记忆设置初始状态
        if (currentMode === 'normal') {
            tabNormal.classList.add('active');
            tabTeam.classList.remove('active');
        } else {
            tabTeam.classList.add('active');
            tabNormal.classList.remove('active');
        }

        tabNormal.addEventListener('click', () => {
            if (currentMode === 'normal') return;
            currentMode = 'normal';
            localStorage.setItem('chatMode', 'normal');
            tabNormal.classList.add('active');
            tabTeam.classList.remove('active');
        });
        tabTeam.addEventListener('click', () => {
            if (currentMode === 'team') return;
            currentMode = 'team';
            localStorage.setItem('chatMode', 'team');
            tabTeam.classList.add('active');
            tabNormal.classList.remove('active');
        });
    }
}

// 自动调整输入框高度
function autoResize() {
    messageInput.style.height = 'auto';
    messageInput.style.height = Math.min(messageInput.scrollHeight, 200) + 'px';
}

// 检查服务健康状态
async function checkHealth() {
    try {
        const response = await fetch('/api/health');
        const data = await response.json();
        
        // 更新模型名称（无条件更新）
        modelInfo.textContent = data.model || 'Unknown';
        
        if (data.status === 'ok' && data.ollama_status === 'ok') {
            updateStatus('connected', '已连接');
        } else {
            updateStatus('error', 'Ollama 未就绪');
        }
    } catch (error) {
        modelInfo.textContent = 'Error';
        updateStatus('error', '连接失败');
        console.error('Health check failed:', error);
    }
}

// 更新状态指示器
function updateStatus(state, text) {
    statusIndicator.className = `status-indicator ${state}`;
    statusIndicator.querySelector('.status-text').textContent = text;
}

// 发送消息
async function sendMessage() {
    const content = messageInput.value.trim();
    
    if (!content || isGenerating) {
        return;
    }
    
    // 添加用户消息
    addMessage('user', content);
    messages.push({ role: 'user', content: content });
    
    // 清空输入框
    messageInput.value = '';
    messageInput.style.height = 'auto';
    
    // 禁用发送按钮
    isGenerating = true;
    sendButton.disabled = true;
    
    // 根据当前模式选择响应流
    if (currentMode === 'team') {
        try {
            await streamTeamResponse();
        } catch (error) {
            const errDiv = addMessage('assistant', '');
            showError(errDiv, error.message);
        } finally {
            isGenerating = false;
            sendButton.disabled = false;
            messageInput.focus();
        }
    } else {
        // 普通模式：显示加载动画占位泡
        const assistantMessageDiv = addMessage('assistant', '', true);
        try {
            await streamChatResponse(assistantMessageDiv);
        } catch (error) {
            showError(assistantMessageDiv, error.message);
        } finally {
            isGenerating = false;
            sendButton.disabled = false;
            messageInput.focus();
        }
    }
}

// 流式接收聊天响应
async function streamChatResponse(messageDiv) {
    const contentDiv = messageDiv.querySelector('.message-content');
    const toolsWrap = messageDiv.querySelector('.tools');
    const toolsContent = messageDiv.querySelector('.tools-content');
    const thoughtsWrap = messageDiv.querySelector('.thoughts');
    const thoughtsContent = messageDiv.querySelector('.thoughts-content');
    const answerContent = messageDiv.querySelector('.answer-content');
    
    const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            messages: messages,
            stream: true
        })
    });
    
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullRaw = '';
    let fullThinking = '';
    let fullAnswer = '';
    let sawThinkingDelta = false;
    
    // 移除加载动画（保留思考/答案容器结构）
    if (answerContent) {
        answerContent.innerHTML = '';
    } else {
        contentDiv.innerHTML = '';
    }
    
    try {
        while (true) {
            const { done, value } = await reader.read();
            
            if (done) {
                break;
            }
            
            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split('\n');
            
            for (const line of lines) {
                if (!line.trim() || !line.startsWith('data: ')) {
                    continue;
                }
                
                const data = line.slice(6); // 移除 "data: " 前缀
                
                if (data.trim() === '[DONE]') {
                    break;
                }
                
                try {
                    const parsed = JSON.parse(data);
                    
                    if (parsed.error) {
                        throw new Error(parsed.error);
                    }

                    if (parsed.tool_event) {
                        appendToolLog(toolsWrap, toolsContent, parsed.tool_event);
                        scrollToBottom();
                        continue;
                    }
                    
                    if (parsed.choices && parsed.choices[0].delta.content) {
                        const content = parsed.choices[0].delta.content;
                        fullRaw += content;
                        fullAnswer += content;
                    }

                    if (parsed.choices && parsed.choices[0].delta.thinking) {
                        const thinking = parsed.choices[0].delta.thinking;
                        sawThinkingDelta = true;
                        fullThinking += thinking;
                    }

                    if (sawThinkingDelta) {
                        // 优先使用后端透传的 thinking 字段
                        if (thoughtsWrap && thoughtsContent) {
                            if (fullThinking.trim()) {
                                thoughtsWrap.style.display = 'block';
                                renderMarkdownWithMath(thoughtsContent, fullThinking);
                            } else {
                                thoughtsWrap.style.display = 'none';
                                thoughtsContent.innerHTML = '';
                            }
                        }

                        const target = answerContent || contentDiv;
                        renderMarkdownWithMath(target, fullAnswer);
                    } else {
                        // 兼容：模型把思考写在 <think> 标签里
                        const parts = extractThinking(fullRaw);
                        if (thoughtsWrap && thoughtsContent) {
                            if (parts.thinking) {
                                thoughtsWrap.style.display = 'block';
                                renderMarkdownWithMath(thoughtsContent, parts.thinking);
                            } else {
                                thoughtsWrap.style.display = 'none';
                                thoughtsContent.innerHTML = '';
                            }
                        }

                        const target = answerContent || contentDiv;
                        renderMarkdownWithMath(target, parts.answer);
                    }

                    scrollToBottom();
                } catch (e) {
                    // 忽略解析错误，可能是不完整的 JSON
                    if (!data.includes('[DONE]')) {
                        console.warn('Parse error:', e, data);
                    }
                }
            }
        }
    } catch (error) {
        throw error;
    }
    
    // 保存完整的助手回复
    if (fullRaw || fullAnswer) {
        if (sawThinkingDelta) {
            messages.push({ role: 'assistant', content: fullAnswer });
        } else {
            // 只保存最终答案（不包含思考标签）以便后续上下文更干净
            const parts = extractThinking(fullRaw);
            messages.push({ role: 'assistant', content: parts.answer || fullRaw });
        }
    }

    // 完成后自动折叠本轮思考
    const finalThinking = sawThinkingDelta
        ? fullThinking
        : extractThinking(fullRaw).thinking;
    if (thoughtsWrap && finalThinking && finalThinking.trim()) {
        thoughtsWrap.classList.add('collapsed');
        const toggleBtn = thoughtsWrap.querySelector('.thoughts-toggle');
        if (toggleBtn) {
            toggleBtn.textContent = '展开';
        }
    }

    // 完成后自动折叠本轮工具日志
    if (toolsWrap && toolsContent && toolsContent.children.length > 0) {
        toolsWrap.classList.add('collapsed');
        const toggleBtn = toolsWrap.querySelector('.tools-toggle');
        if (toggleBtn) {
            toggleBtn.textContent = '展开';
        }
    }
}

// 添加消息到界面
function addMessage(role, content, showTyping = false) {
    // 移除欢迎消息
    const welcomeMsg = messagesContainer.querySelector('.welcome-message');
    if (welcomeMsg) {
        welcomeMsg.remove();
    }
    
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${role}`;
    
    const wrapper = document.createElement('div');
    wrapper.className = 'message-wrapper';
    
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = role === 'user' ? '😺' : '🧸';
    
    const body = document.createElement('div');
    body.className = 'message-body';
    
    const header = document.createElement('div');
    header.className = 'message-header';
    header.textContent = role === 'user' ? '你' : 'AI 助手';
    
    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    
    if (showTyping) {
        contentDiv.innerHTML = '<div class="typing-indicator"><span></span><span></span><span></span></div>';
    } else {
        // 初始渲染也支持公式
        renderMarkdownWithMath(contentDiv, content);
    }

    // 助手消息增加“思考过程”区域
    if (role === 'assistant') {
        const tools = document.createElement('div');
        tools.className = 'tools';
        tools.style.display = 'none';

        const toolsHeader = document.createElement('div');
        toolsHeader.className = 'tools-header';
        toolsHeader.innerHTML = '<span>工具调用过程</span><button class="tools-toggle" type="button">收起</button>';

        const toolsContent = document.createElement('div');
        toolsContent.className = 'tools-content';

        toolsHeader.querySelector('.tools-toggle').addEventListener('click', () => {
            const isCollapsed = tools.classList.toggle('collapsed');
            toolsHeader.querySelector('.tools-toggle').textContent = isCollapsed ? '展开' : '收起';
        });

        tools.appendChild(toolsHeader);
        tools.appendChild(toolsContent);

        const thoughts = document.createElement('div');
        thoughts.className = 'thoughts';
        thoughts.style.display = 'none';

        const thoughtsHeader = document.createElement('div');
        thoughtsHeader.className = 'thoughts-header';
        thoughtsHeader.innerHTML = '<span>思考过程</span><button class="thoughts-toggle" type="button">收起</button>';

        const thoughtsContent = document.createElement('div');
        thoughtsContent.className = 'thoughts-content';

        thoughtsHeader.querySelector('.thoughts-toggle').addEventListener('click', () => {
            const isCollapsed = thoughts.classList.toggle('collapsed');
            thoughtsHeader.querySelector('.thoughts-toggle').textContent = isCollapsed ? '展开' : '收起';
        });

        thoughts.appendChild(thoughtsHeader);
        thoughts.appendChild(thoughtsContent);

        const answer = document.createElement('div');
        answer.className = 'answer-content';

        // 如果不是打字中，尝试从内容中拆出思考/答案
        if (!showTyping) {
            const parts = extractThinking(content);
            if (parts.thinking) {
                thoughts.style.display = 'block';
                renderMarkdownWithMath(thoughtsContent, parts.thinking);
            }
            renderMarkdownWithMath(answer, parts.answer);
        } else {
            // 保留加载动画，后续流式会替换为真正内容
            answer.innerHTML = '<div class="typing-indicator"><span></span><span></span><span></span></div>';
        }

        // 用新的结构替代原 contentDiv（流式时也能更新）
        contentDiv.innerHTML = '';
        contentDiv.appendChild(tools);
        contentDiv.appendChild(thoughts);
        contentDiv.appendChild(answer);
    }
    
    body.appendChild(header);
    body.appendChild(contentDiv);
    wrapper.appendChild(avatar);
    wrapper.appendChild(body);
    messageDiv.appendChild(wrapper);
    messagesContainer.appendChild(messageDiv);
    
    scrollToBottom();
    
    return messageDiv;
}

// 显示错误
function showError(messageDiv, errorMessage) {
    const contentDiv = messageDiv.querySelector('.message-content');
    contentDiv.innerHTML = `<div class="error-message">❌ 错误: ${errorMessage}</div>`;
}

// 清空对话
function clearChat() {
    if (messages.length === 0) {
        messages = [];
        messagesContainer.innerHTML = `
            <div class="welcome-message">
                <div class="welcome-icon">🧸</div>
                <h2>你好！我能帮你什么？</h2>
                <p>我会尽力帮你解答问题</p>
            </div>
        `;
        messageInput.focus();
        return;
    }
    
    if (confirm('确定要开始新对话吗？')) {
        messages = [];
        messagesContainer.innerHTML = `
            <div class="welcome-message">
                <div class="welcome-icon">🧸</div>
                <h2>你好！我能帮你什么？</h2>
                <p>我会尽力帮你解答问题</p>
            </div>
        `;
        messageInput.focus();
    }
}

// 滚动到底部
function scrollToBottom() {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// 每30秒检查一次健康状态
setInterval(checkHealth, 30000);

// ──────────────────────────────────────────────────────────────
// 团队模式：流式响应消费
// ──────────────────────────────────────────────────────────────

async function streamTeamResponse() {
    const response = await fetch('/api/chat/team', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: messages, stream: true }),
    });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    // DOM refs for current active section
    let teamBlock         = null;
    let currentAnswerContent  = null;
    let currentThoughtsWrap   = null;
    let currentThoughtsContent = null;
    let currentToolsWrap  = null;
    let currentToolsContent   = null;
    let isLeader          = false;

    // Leader DOM refs
    let leaderMessageDiv      = null;
    let leaderAnswerContent   = null;
    let leaderThoughtsWrap    = null;
    let leaderThoughtsContent = null;
    let leaderToolsWrap       = null;
    let leaderToolsContent    = null;

    // Per-section text buffers
    let fullAnswer   = '';
    let fullThinking = '';
    let sawThinkingDelta = false;

    let leaderFullAnswer   = '';
    let leaderFullThinking = '';

    function resetBuffers() {
        fullAnswer = ''; fullThinking = ''; sawThinkingDelta = false;
    }

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const lines = decoder.decode(value, { stream: true }).split('\n');

            for (const line of lines) {
                if (!line.trim() || !line.startsWith('data: ')) continue;
                const data = line.slice(6);
                if (data.trim() === '[DONE]') break;

                try {
                    const parsed = JSON.parse(data);
                    if (parsed.error) throw new Error(parsed.error);

                    // ── 团队事件 ──────────────────────────────────
                    if (parsed.team_event) {
                        const evt = parsed.team_event;

                        if (evt.type === 'member_start') {
                            if (!teamBlock) teamBlock = _createTeamBlock();
                            resetBuffers();
                            isLeader = false;
                            const s = _addTeamMemberSection(teamBlock, evt);
                            currentAnswerContent   = s.answerContent;
                            currentThoughtsWrap    = s.thoughtsWrap;
                            currentThoughtsContent = s.thoughtsContent;
                            currentToolsWrap       = s.toolsWrap;
                            currentToolsContent    = s.toolsContent;

                        } else if (evt.type === 'member_end') {
                            _collapseThoughtsAndTools(currentThoughtsWrap, currentToolsWrap, fullThinking);

                        } else if (evt.type === 'leader_start') {
                            resetBuffers();
                            isLeader = true;
                            leaderMessageDiv      = _addTeamLeaderBubble(evt);
                            leaderAnswerContent   = leaderMessageDiv.querySelector('.answer-content');
                            leaderThoughtsWrap    = leaderMessageDiv.querySelector('.thoughts');
                            leaderThoughtsContent = leaderMessageDiv.querySelector('.thoughts-content');
                            leaderToolsWrap       = leaderMessageDiv.querySelector('.tools');
                            leaderToolsContent    = leaderMessageDiv.querySelector('.tools-content');
                        }

                        scrollToBottom();
                        continue;
                    }

                    // ── 工具事件 ──────────────────────────────────
                    if (parsed.tool_event) {
                        const tw = isLeader ? leaderToolsWrap  : currentToolsWrap;
                        const tc = isLeader ? leaderToolsContent : currentToolsContent;
                        appendToolLog(tw, tc, parsed.tool_event);
                        scrollToBottom();
                        continue;
                    }

                    // ── 内容增量 ──────────────────────────────────
                    if (!parsed.choices) continue;
                    const delta = parsed.choices[0].delta;

                    if (isLeader) {
                        if (delta.thinking) leaderFullThinking += delta.thinking;
                        if (delta.content)  leaderFullAnswer   += delta.content;
                        if (leaderThoughtsWrap && leaderFullThinking.trim()) {
                            leaderThoughtsWrap.style.display = 'block';
                            renderMarkdownWithMath(leaderThoughtsContent, leaderFullThinking);
                        }
                        if (leaderAnswerContent) renderMarkdownWithMath(leaderAnswerContent, leaderFullAnswer);
                    } else {
                        if (delta.thinking) { sawThinkingDelta = true; fullThinking += delta.thinking; }
                        if (delta.content)  fullAnswer += delta.content;
                        if (currentThoughtsWrap && fullThinking.trim()) {
                            currentThoughtsWrap.style.display = 'block';
                            renderMarkdownWithMath(currentThoughtsContent, fullThinking);
                        }
                        if (currentAnswerContent) renderMarkdownWithMath(currentAnswerContent, fullAnswer);
                    }

                    scrollToBottom();
                } catch (e) {
                    if (!data.includes('[DONE]')) console.warn('Team parse error:', e, data);
                }
            }
        }
    } catch (error) {
        throw error;
    }

    // 组长思考/工具折叠
    if (leaderMessageDiv) {
        _collapseThoughtsAndTools(leaderThoughtsWrap, leaderToolsWrap, leaderFullThinking);
    }

    // 将组长答案存入历史（保持对话连贯性）
    if (leaderFullAnswer) {
        messages.push({ role: 'assistant', content: leaderFullAnswer });
    }
}

// ──────────────────────────────────────────────────────────────
// 团队模式：DOM 工厂函数（前缀 _ 表示内部辅助）
// ──────────────────────────────────────────────────────────────

function _collapseThoughtsAndTools(thoughtsWrap, toolsWrap, thinkingText) {
    if (thoughtsWrap && thinkingText && thinkingText.trim()) {
        thoughtsWrap.classList.add('collapsed');
        const btn = thoughtsWrap.querySelector('.thoughts-toggle');
        if (btn) btn.textContent = '展开';
    }
    if (toolsWrap) {
        const tc = toolsWrap.querySelector('.tools-content');
        if (tc && tc.children.length > 0) {
            toolsWrap.classList.add('collapsed');
            const btn = toolsWrap.querySelector('.tools-toggle');
            if (btn) btn.textContent = '展开';
        }
    }
}

/** 创建包裹三位成员的 .team-block 容器（含外层 .message wrapper）。 */
function _createTeamBlock() {
    const welcome = messagesContainer.querySelector('.welcome-message');
    if (welcome) welcome.remove();

    const messageDiv = document.createElement('div');
    messageDiv.className = 'message assistant';

    const wrapper = document.createElement('div');
    wrapper.className = 'message-wrapper';

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = '👥';

    const body = document.createElement('div');
    body.className = 'message-body';

    const teamBlock = document.createElement('div');
    teamBlock.className = 'team-block';

    body.appendChild(teamBlock);
    wrapper.appendChild(avatar);
    wrapper.appendChild(body);
    messageDiv.appendChild(wrapper);
    messagesContainer.appendChild(messageDiv);
    scrollToBottom();

    return teamBlock;
}

/** 共用的 tools + thoughts + answer-content 块生成器。*/
function _makeContentBlock() {
    const tools = document.createElement('div');
    tools.className = 'tools';
    tools.style.display = 'none';
    const toolsHeader = document.createElement('div');
    toolsHeader.className = 'tools-header';
    toolsHeader.innerHTML = '<span>工具调用过程</span><button class="tools-toggle" type="button">收起</button>';
    const toolsContent = document.createElement('div');
    toolsContent.className = 'tools-content';
    toolsHeader.querySelector('.tools-toggle').addEventListener('click', () => {
        const collapsed = tools.classList.toggle('collapsed');
        toolsHeader.querySelector('.tools-toggle').textContent = collapsed ? '展开' : '收起';
    });
    tools.appendChild(toolsHeader);
    tools.appendChild(toolsContent);

    const thoughts = document.createElement('div');
    thoughts.className = 'thoughts';
    thoughts.style.display = 'none';
    const thoughtsHeader = document.createElement('div');
    thoughtsHeader.className = 'thoughts-header';
    thoughtsHeader.innerHTML = '<span>思考过程</span><button class="thoughts-toggle" type="button">收起</button>';
    const thoughtsContent = document.createElement('div');
    thoughtsContent.className = 'thoughts-content';
    thoughtsHeader.querySelector('.thoughts-toggle').addEventListener('click', () => {
        const collapsed = thoughts.classList.toggle('collapsed');
        thoughtsHeader.querySelector('.thoughts-toggle').textContent = collapsed ? '展开' : '收起';
    });
    thoughts.appendChild(thoughtsHeader);
    thoughts.appendChild(thoughtsContent);

    const answerContent = document.createElement('div');
    answerContent.className = 'answer-content';

    return { tools, toolsContent, thoughts, thoughtsContent, answerContent };
}

/** 在 teamBlock 内追加单个成员区块（含名称标签）。 */
function _addTeamMemberSection(teamBlock, memberInfo) {
    const section = document.createElement('div');
    section.className = 'team-member-section';

    const tag = document.createElement('div');
    tag.className = 'member-tag';
    tag.textContent = `${memberInfo.avatar} ${memberInfo.display_name}`;

    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';

    const { tools, toolsContent, thoughts, thoughtsContent, answerContent } = _makeContentBlock();
    contentDiv.appendChild(tools);
    contentDiv.appendChild(thoughts);
    contentDiv.appendChild(answerContent);

    section.appendChild(tag);
    section.appendChild(contentDiv);
    teamBlock.appendChild(section);
    scrollToBottom();

    return {
        section,
        toolsWrap: tools, toolsContent,
        thoughtsWrap: thoughts, thoughtsContent,
        answerContent,
    };
}

/** 创建组长独立气泡（金色边框）。 */
function _addTeamLeaderBubble(leaderInfo) {
    const welcome = messagesContainer.querySelector('.welcome-message');
    if (welcome) welcome.remove();

    const messageDiv = document.createElement('div');
    messageDiv.className = 'message assistant team-leader';

    const wrapper = document.createElement('div');
    wrapper.className = 'message-wrapper';

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = leaderInfo.avatar;

    const body = document.createElement('div');
    body.className = 'message-body';

    const tag = document.createElement('div');
    tag.className = 'member-tag leader';
    tag.textContent = `${leaderInfo.avatar} ${leaderInfo.display_name}`;

    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';

    const { tools, toolsContent, thoughts, thoughtsContent, answerContent } = _makeContentBlock();
    contentDiv.appendChild(tools);
    contentDiv.appendChild(thoughts);
    contentDiv.appendChild(answerContent);

    body.appendChild(tag);
    body.appendChild(contentDiv);
    wrapper.appendChild(avatar);
    wrapper.appendChild(body);
    messageDiv.appendChild(wrapper);
    messagesContainer.appendChild(messageDiv);
    scrollToBottom();

    return messageDiv;
}
