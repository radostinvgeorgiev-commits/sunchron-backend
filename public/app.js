// State Management
const state = {
    sessionId: 'sess-' + Math.random().toString(36).substr(2, 9),
    agentOnline: false,
    opensearchStatus: 'unknown',
    intent: 'general',
    lastActions: [],
    chatBusy: false
};

// DOM Elements
const elements = {
    chatMessages: document.getElementById('chatMessages'),
    chatInput: document.getElementById('chatInput'),
    sendBtn: document.getElementById('sendBtn'),
    agentStatusDot: document.getElementById('agentStatusDot'),
    agentStatusText: document.getElementById('agentStatusText'),
    sessionIdDisplay: document.getElementById('sessionIdDisplay'),
    intentDisplay: document.getElementById('intentDisplay'),
    opensearchStatusDisplay: document.getElementById('opensearchStatusDisplay'),
    actionsLog: document.getElementById('actionsLog'),
    serverTimeDisplay: document.getElementById('serverTimeDisplay')
};

function init() {
    if (elements.sessionIdDisplay) elements.sessionIdDisplay.textContent = state.sessionId;

    elements.sendBtn.addEventListener('click', sendMessage);
    elements.chatInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendMessage();
    });

    document.querySelectorAll('.action-btn').forEach(btn => {
        btn.addEventListener('click', (e) => handleActionClick(e.currentTarget.id));
    });

    checkHealth();
    checkOpenSearch();
    setInterval(checkHealth, 5000);
    setInterval(checkOpenSearch, 10000);

    appendMessage('agent', 'Здравей! Аз съм Synchron-X. Как мога да помогна?');
}

function showTypingIndicator() {
    const div = document.createElement('div');
    div.className = 'message typing';
    div.id = 'typingIndicator';
    div.innerHTML = `
        <div class="typing-dot"></div>
        <div class="typing-dot"></div>
        <div class="typing-dot"></div>
    `;
    elements.chatMessages.appendChild(div);
    elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
}

function removeTypingIndicator() {
    const indicator = document.getElementById('typingIndicator');
    if (indicator) indicator.remove();
}

function setChatBusy(isBusy) {
    state.chatBusy = isBusy;
    elements.sendBtn.disabled = isBusy;
    elements.chatInput.disabled = isBusy;
}

function renderAgentText(element, text) {
    if (typeof marked !== 'undefined') {
        element.innerHTML = marked.parse(text);
    } else {
        element.textContent = text;
    }
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
    logAction('User sent message');
    showTypingIndicator();
    setChatBusy(true);

    let responseBubble = null;

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
        responseBubble = document.createElement('div');
        responseBubble.className = 'message agent';
        elements.chatMessages.appendChild(responseBubble);

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

                if (parsed.event === 'token' && typeof parsed.data?.token === 'string') {
                    fullText += parsed.data.token;
                    renderAgentText(responseBubble, fullText);
                } else if (parsed.event === 'error') {
                    throw new Error(parsed.data?.message || 'AI агентът върна грешка.');
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
            elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
        }

        streamBuffer += decoder.decode();
        if (streamBuffer.trim()) {
            streamBuffer += '\n\n';
            processEvents();
        }

        if (!completed || !fullText.trim()) {
            throw new Error('AI отговорът приключи неочаквано.');
        }
    } catch (error) {
        console.error(error);
        const message = `❌ ${error?.message || 'Сървърна грешка. Моля, опитайте по-късно.'}`;

        if (responseBubble) {
            responseBubble.textContent = message;
        } else {
            appendMessage('agent', message);
        }
    } finally {
        removeTypingIndicator();
        setChatBusy(false);
        elements.chatInput.focus();
    }
}

function appendMessage(role, text) {
    const div = document.createElement('div');
    div.className = `message ${role}`;

    if (role === 'agent') {
        renderAgentText(div, text);
    } else {
        div.textContent = text;
    }

    elements.chatMessages.appendChild(div);
    elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
}

async function checkHealth() {
    try {
        const res = await fetch('/health');
        setAgentStatus(res.ok);
    } catch {
        setAgentStatus(false);
    }
}

async function checkOpenSearch() {
    try {
        const res = await fetch('/opensearch-status');
        if (res.ok) {
            const data = await res.json();
            updateOpenSearchUI(data.status);
            if (elements.serverTimeDisplay) {
                elements.serverTimeDisplay.textContent = new Date().toLocaleTimeString();
            }
        } else {
            updateOpenSearchUI('error');
        }
    } catch {
        updateOpenSearchUI('unreachable');
    }
}

function setAgentStatus(isOnline) {
    state.agentOnline = isOnline;
    elements.agentStatusDot.className = isOnline ? 'online' : 'offline';
    elements.agentStatusText.textContent = isOnline ? 'Server Online' : 'Server Offline';
}

function updateOpenSearchUI(status) {
    state.opensearchStatus = status;
    const display = elements.opensearchStatusDisplay;
    if (!display) return;

    display.textContent = status;
    display.className = 'context-value';
    if (status === 'green') display.classList.add('status-green');
    else if (status === 'red' || status === 'error') display.classList.add('status-red');
    else display.classList.add('status-yellow');
}

function handleActionClick(actionId) {
    logAction(`Clicked: ${actionId}`);

    switch (actionId) {
        case 'actionTalk':
            elements.chatInput.focus();
            break;
        case 'actionReserve':
            state.intent = 'reservation';
            updateContextDisplay();
            appendMessage('agent', '📅 Стартирам процес за резервация. Моля, въведете дати и брой гости.');
            break;
        case 'actionHotel':
            state.intent = 'search_hotel';
            updateContextDisplay();
            appendMessage('agent', '🏨 В кой град търсите хотел?');
            break;
        case 'actionLocation':
            state.intent = 'location_info';
            updateContextDisplay();
            appendMessage('agent', '📍 Споделете коя локация ви интересува.');
            break;
        case 'actionAdmin':
            alert('Admin panel access denied (Demo Mode)');
            break;
    }
}

function logAction(actionName) {
    const time = new Date().toLocaleTimeString();
    const entry = `[${time}] ${actionName}`;
    state.lastActions.unshift(entry);
    if (state.lastActions.length > 5) state.lastActions.pop();

    if (elements.actionsLog) {
        elements.actionsLog.innerHTML = state.lastActions
            .map(a => `<li>${a}</li>`)
            .join('');
    }
}

function updateContextDisplay() {
    if (elements.intentDisplay) elements.intentDisplay.textContent = state.intent;
}

window.addEventListener('load', init);
