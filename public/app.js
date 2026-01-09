// State Management
const state = {
    sessionId: 'sess-' + Math.random().toString(36).substr(2, 9),
    agentOnline: false,
    opensearchStatus: 'unknown',
    intent: 'general',
    lastActions: []
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

// --- Initialization ---
function init() {
    // Set static displays
    if (elements.sessionIdDisplay) elements.sessionIdDisplay.textContent = state.sessionId;
    
    // Add Event Listeners
    elements.sendBtn.addEventListener('click', sendMessage);
    elements.chatInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendMessage();
    });

    // Action Buttons
    document.querySelectorAll('.action-btn').forEach(btn => {
        btn.addEventListener('click', (e) => handleActionClick(e.currentTarget.id));
    });

    // Start Polling
    checkHealth();
    checkOpenSearch();
    setInterval(checkHealth, 5000); // Every 5 sec
    setInterval(checkOpenSearch, 10000); // Every 10 sec

    // Welcome Message
    appendMessage('agent', 'Здравей! Аз съм Synchron-X. Как мога да помогна?');
}

// --- Chat Logic ---
// Helper for Typing Indicator
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

async function sendMessage() {
    const text = elements.chatInput.value.trim();
    if (!text) return;

    // UI Updates
    appendMessage('user', text);
    elements.chatInput.value = '';
    logAction('User sent message');

    // Show Typing Indicator
    showTypingIndicator();

    // API Call (Streaming Support)
    try {
        const response = await fetch('/chat/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                sessionId: state.sessionId, 
                message: text 
            })
        });

        // If JSON response (Cache Hit or Error), handle normally
        const contentType = response.headers.get("content-type");
        if (contentType && contentType.includes("application/json")) {
             removeTypingIndicator();
             const data = await response.json();
             if (data.reply) {
                appendMessage('agent', data.reply);
             } else {
                appendMessage('agent', '⚠️ Error: ' + (data.error || 'Unknown'));
             }
             return;
        }

        // Handle Stream
        removeTypingIndicator();
        
        // Creaet empty message bubble
        const div = document.createElement('div');
        div.className = 'message agent';
        elements.chatMessages.appendChild(div);
        
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullText = "";

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            const chunk = decoder.decode(value, { stream: true });
            fullText += chunk;
            
            // Render partial
            if (typeof marked !== 'undefined') {
                div.innerHTML = marked.parse(fullText);
            } else {
                div.textContent = fullText;
            }
            elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
        }

    } catch (error) {
        removeTypingIndicator();
        console.error(error);
        appendMessage('agent', '❌ Сървърна грешка. Моля, опитайте по-късно.');
    }
}

function appendMessage(role, text) {
    const div = document.createElement('div');
    div.className = `message ${role}`;
    
    if (role === 'agent' && typeof marked !== 'undefined') {
        div.innerHTML = marked.parse(text);
    } else {
        div.textContent = text;
    }
    
    elements.chatMessages.appendChild(div);
    elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
}

// --- Status & Monitoring ---
async function checkHealth() {
    try {
        const res = await fetch('/health');
        if (res.ok) {
            setAgentStatus(true);
            const data = await res.json();
            // Update OpenSearch inline if provided by health
            if (data.opensearch) updateOpenSearchUI(data.opensearch);
        } else {
            setAgentStatus(false);
        }
    } catch (e) {
        setAgentStatus(false);
    }
}

async function checkOpenSearch() {
    try {
        const res = await fetch('/opensearch-status');
        if (res.ok) {
            const data = await res.json();
            updateOpenSearchUI(data.status);
            if (elements.serverTimeDisplay) elements.serverTimeDisplay.textContent = new Date().toLocaleTimeString();
        } else {
            updateOpenSearchUI('error');
        }
    } catch (e) {
        updateOpenSearchUI('unreachable');
    }
}

function setAgentStatus(isOnline) {
    state.agentOnline = isOnline;
    elements.agentStatusDot.className = isOnline ? 'online' : 'offline';
    elements.agentStatusText.textContent = isOnline ? 'Agent Online' : 'Agent Offline';
}

function updateOpenSearchUI(status) {
    state.opensearchStatus = status;
    const display = elements.opensearchStatusDisplay;
    if (!display) return;

    display.textContent = status;
    display.className = 'context-value'; // reset
    if (status === 'green') display.classList.add('status-green');
    else if (status === 'red' || status === 'error') display.classList.add('status-red');
    else display.classList.add('status-yellow');
}

// --- Action Logic ---
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

// Run init
window.addEventListener('load', init);
