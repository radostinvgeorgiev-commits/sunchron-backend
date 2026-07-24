const state = {
    sessionId: createSessionId(),
    serverOnline: false,
    opensearchStatus: 'unknown',
    lastActions: [],
    chatBusy: false,
    speakingButton: null
};

const elements = {
    chatMessages: document.getElementById('chatMessages'),
    chatInput: document.getElementById('chatInput'),
    sendBtn: document.getElementById('sendBtn'),
    newChatBtn: document.getElementById('newChatBtn'),
    toggleStatusBtn: document.getElementById('toggleStatusBtn'),
    closeContextBtn: document.getElementById('closeContextBtn'),
    statusPanel: document.getElementById('statusPanel'),
    agentStatusDot: document.getElementById('agentStatusDot'),
    agentStatusText: document.getElementById('agentStatusText'),
    sessionIdDisplay: document.getElementById('sessionIdDisplay'),
    serverStatusDisplay: document.getElementById('serverStatusDisplay'),
    opensearchStatusDisplay: document.getElementById('opensearchStatusDisplay'),
    actionsLog: document.getElementById('actionsLog')
};

function createSessionId() {
    return 'sess-' + Math.random().toString(36).slice(2, 11);
}

function init() {
    updateSessionDisplay();

    elements.sendBtn.addEventListener('click', sendMessage);
    elements.chatInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            sendMessage();
        }
    });
    elements.newChatBtn.addEventListener('click', startNewChat);
    elements.toggleStatusBtn.addEventListener('click', openStatus);
    elements.closeContextBtn.addEventListener('click', closeStatus);
    elements.chatMessages.addEventListener('click', handleMessageAction);

    checkHealth();
    checkOpenSearch();
    setInterval(checkHealth, 10000);
    setInterval(checkOpenSearch, 20000);

    showWelcomeMessage();
}

function updateSessionDisplay() {
    elements.sessionIdDisplay.textContent = state.sessionId;
}

function showWelcomeMessage() {
    appendMessage(
        'agent',
        'Здравей! Аз съм Synchron-X. Напиши ми въпрос и ще ти отговоря.'
    );
}

function startNewChat() {
    if (state.chatBusy) return;
    state.sessionId = createSessionId();
    state.lastActions = [];
    elements.chatMessages.replaceChildren();
    updateSessionDisplay();
    renderActionsLog();
    showWelcomeMessage();
    logAction('Започнат е нов разговор');
    elements.chatInput.focus();
}

function openStatus() {
    elements.statusPanel.classList.add('mobile-visible');
}

function closeStatus() {
    elements.statusPanel.classList.remove('mobile-visible');
}

function showTypingIndicator() {
    const div = document.createElement('div');
    div.className = 'message typing';
    div.id = 'typingIndicator';
    div.innerHTML = `
        <span class="thinking-avatar" aria-hidden="true">
            <i class="fa-solid fa-atom"></i>
        </span>
        <span class="thinking-label">Synchron-X мисли</span>
        <span class="thinking-dots" aria-hidden="true">
            <span></span><span></span><span></span>
        </span>
    `;
    elements.chatMessages.appendChild(div);
    scrollChatToBottom();
}

function removeTypingIndicator() {
    document.getElementById('typingIndicator')?.remove();
}

function setChatBusy(isBusy) {
    state.chatBusy = isBusy;
    elements.sendBtn.disabled = isBusy;
    elements.chatInput.disabled = isBusy;
    elements.newChatBtn.disabled = isBusy;
}

function renderAgentText(element, text) {
    element.dataset.rawText = text;
    if (typeof marked !== 'undefined') {
        element.innerHTML = marked.parse(text);
    } else {
        element.textContent = text;
    }
}

function createAssistantTurn(text = '', showActions = true) {
    const turn = document.createElement('div');
    turn.className = 'assistant-turn';

    const message = document.createElement('div');
    message.className = 'message agent';
    renderAgentText(message, text);

    const actions = document.createElement('div');
    actions.className = 'message-actions';
    actions.hidden = !showActions;
    actions.innerHTML = `
        <button type="button" data-action="copy" title="Копирай" aria-label="Копирай">
            <i class="fa-regular fa-copy"></i>
        </button>
        <button type="button" data-action="speak" title="Прочети на глас" aria-label="Прочети на глас">
            <i class="fa-solid fa-volume-high"></i>
        </button>
        <button type="button" data-action="like" title="Добър отговор" aria-label="Добър отговор">
            <i class="fa-regular fa-thumbs-up"></i>
        </button>
        <button type="button" data-action="dislike" title="Лош отговор" aria-label="Лош отговор">
            <i class="fa-regular fa-thumbs-down"></i>
        </button>
    `;

    turn.append(message, actions);
    elements.chatMessages.appendChild(turn);
    return { turn, message, actions };
}

async function handleMessageAction(event) {
    const button = event.target.closest('button[data-action]');
    if (!button) return;

    const turn = button.closest('.assistant-turn');
    const message = turn?.querySelector('.message.agent');
    const text = message?.dataset.rawText || message?.innerText || '';
    if (!text) return;

    const action = button.dataset.action;

    if (action === 'copy') {
        await copyText(text);
        const icon = button.querySelector('i');
        icon.className = 'fa-solid fa-check';
        button.classList.add('active');
        setTimeout(() => {
            icon.className = 'fa-regular fa-copy';
            button.classList.remove('active');
        }, 1400);
        return;
    }

    if (action === 'speak') {
        speakText(text, button);
        return;
    }

    if (action === 'like' || action === 'dislike') {
        const otherAction = action === 'like' ? 'dislike' : 'like';
        const otherButton = turn.querySelector(
            `button[data-action="${otherAction}"]`
        );
        otherButton?.classList.remove('active');
        button.classList.toggle('active');
    }
}

async function copyText(text) {
    if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
}

function speakText(text, button) {
    if (!('speechSynthesis' in window)) return;

    if (state.speakingButton === button && window.speechSynthesis.speaking) {
        window.speechSynthesis.cancel();
        button.classList.remove('active');
        state.speakingButton = null;
        return;
    }

    window.speechSynthesis.cancel();
    state.speakingButton?.classList.remove('active');

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'bg-BG';
    utterance.rate = 1;
    button.classList.add('active');
    state.speakingButton = button;

    const finish = () => {
        button.classList.remove('active');
        if (state.speakingButton === button) state.speakingButton = null;
    };

    utterance.onend = finish;
    utterance.onerror = finish;
    window.speechSynthesis.speak(utterance);
}

function parseSseEvent(rawEvent) {
    const lines = rawEvent.split('\n');
    let eventName = 'message';
    const dataLines = [];

    for (const line of lines) {
        if (!line || line.startsWith(':')) continue;
        if (line.startsWith('event:')) {
            eventName = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trimStart());
        }
    }

    if (dataLines.length === 0) return null;

    try {
        return {
            event: eventName,
            data: JSON.parse(dataLines.join('\n'))
        };
    } catch {
        throw new Error('Получен е повреден поток от сървъра.');
    }
}

async function sendMessage() {
    const text = elements.chatInput.value.trim();
    if (!text || state.chatBusy) return;

    appendMessage('user', text);
    elements.chatInput.value = '';
    logAction('Изпратено съобщение');
    showTypingIndicator();
    setChatBusy(true);

    let responseBubble = null;
    let responseActions = null;

    try {
        const response = await fetch('/chat/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sessionId: state.sessionId,
                message: text
            })
        });

        if (!response.ok) {
            const contentType = response.headers.get('content-type') || '';
            let errorMessage = `HTTP ${response.status}`;

            if (contentType.includes('application/json')) {
                const data = await response.json().catch(() => null);
                if (data?.error) errorMessage = data.error;
            }

            throw new Error(errorMessage);
        }

        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('text/event-stream')) {
            throw new Error('Сървърът върна неочакван формат.');
        }

        removeTypingIndicator();
        const assistantTurn = createAssistantTurn('', false);
        responseBubble = assistantTurn.message;
        responseActions = assistantTurn.actions;

        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let streamBuffer = '';
        let fullText = '';
        let completed = false;

        const processEvents = () => {
            streamBuffer = streamBuffer.replace(/\r\n/g, '\n');
            const events = streamBuffer.split('\n\n');
            streamBuffer = events.pop() || '';

            for (const rawEvent of events) {
                const parsed = parseSseEvent(rawEvent);
                if (!parsed) continue;

                if (
                    parsed.event === 'token' &&
                    typeof parsed.data?.token === 'string'
                ) {
                    fullText += parsed.data.token;
                    renderAgentText(responseBubble, fullText);
                } else if (parsed.event === 'error') {
                    throw new Error(
                        parsed.data?.message || 'AI агентът върна грешка.'
                    );
                } else if (parsed.event === 'done') {
                    completed = true;
                }
            }
        };

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            streamBuffer += decoder.decode(value, { stream: true });
            processEvents();
            scrollChatToBottom();
        }

        streamBuffer += decoder.decode();
        if (streamBuffer.trim()) {
            streamBuffer += '\n\n';
            processEvents();
        }

        if (!completed || !fullText.trim()) {
            throw new Error('AI отговорът приключи неочаквано.');
        }

        responseActions.hidden = false;
        logAction('Получен AI отговор');
    } catch (error) {
        console.error(error);
        const message =
            `❌ ${error?.message || 'Сървърна грешка. Опитай отново.'}`;

        if (responseBubble) {
            responseBubble.textContent = message;
            responseBubble.dataset.rawText = message;
            if (responseActions) responseActions.hidden = true;
        } else {
            appendMessage('agent', message);
        }
        logAction('Грешка при AI отговор');
    } finally {
        removeTypingIndicator();
        setChatBusy(false);
        elements.chatInput.focus();
        scrollChatToBottom();
    }
}

function appendMessage(role, text) {
    if (role === 'agent') {
        const assistantTurn = createAssistantTurn(text, true);
        scrollChatToBottom();
        return assistantTurn.message;
    }

    const div = document.createElement('div');
    div.className = `message ${role}`;
    div.textContent = text;

    elements.chatMessages.appendChild(div);
    scrollChatToBottom();
    return div;
}

function scrollChatToBottom() {
    elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
}

async function checkHealth() {
    try {
        const response = await fetch('/health', { cache: 'no-store' });
        setServerStatus(response.ok);
    } catch {
        setServerStatus(false);
    }
}

async function checkOpenSearch() {
    try {
        const response = await fetch('/opensearch-status', { cache: 'no-store' });
        if (response.ok) {
            const data = await response.json();
            updateOpenSearchUI(data.status);
        } else {
            updateOpenSearchUI('error');
        }
    } catch {
        updateOpenSearchUI('unreachable');
    }
}

function setServerStatus(isOnline) {
    state.serverOnline = isOnline;
    elements.agentStatusDot.className = isOnline ? 'online' : 'offline';
    elements.agentStatusText.textContent = isOnline
        ? 'Сървър онлайн'
        : 'Сървър офлайн';
    elements.serverStatusDisplay.textContent = isOnline ? 'Онлайн' : 'Офлайн';
    elements.serverStatusDisplay.className =
        `context-value ${isOnline ? 'status-green' : 'status-red'}`;
}

function updateOpenSearchUI(status) {
    state.opensearchStatus = status;
    elements.opensearchStatusDisplay.textContent = status;
    elements.opensearchStatusDisplay.className = 'context-value';

    if (status === 'green') {
        elements.opensearchStatusDisplay.classList.add('status-green');
    } else if (status === 'red' || status === 'error' || status === 'unreachable') {
        elements.opensearchStatusDisplay.classList.add('status-red');
    } else {
        elements.opensearchStatusDisplay.classList.add('status-yellow');
    }
}

function logAction(actionName) {
    const time = new Date().toLocaleTimeString('bg-BG', {
        hour: '2-digit',
        minute: '2-digit'
    });
    state.lastActions.unshift(`[${time}] ${actionName}`);
    if (state.lastActions.length > 5) state.lastActions.pop();
    renderActionsLog();
}

function renderActionsLog() {
    elements.actionsLog.replaceChildren();

    if (state.lastActions.length === 0) {
        const item = document.createElement('li');
        item.textContent = 'Няма скорошни действия';
        elements.actionsLog.appendChild(item);
        return;
    }

    for (const action of state.lastActions) {
        const item = document.createElement('li');
        item.textContent = action;
        elements.actionsLog.appendChild(item);
    }
}

window.addEventListener('load', init);
