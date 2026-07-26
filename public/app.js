const state = {
    sessionId: getOrCreateSessionId(),
    serverOnline: false,
    opensearchStatus: 'unknown',
    lastActions: [],
    chatBusy: false,
    speakingButton: null,
    pendingImage: null,
    conversations: [],
    memoryItems: [],
    recognition: null,
    listening: false
};

const elements = {
    chatMessages: document.getElementById('chatMessages'),
    chatInput: document.getElementById('chatInput'),
    sendBtn: document.getElementById('sendBtn'),
    attachBtn: document.getElementById('attachBtn'),
    imageInput: document.getElementById('imageInput'),
    attachmentPreview: document.getElementById('attachmentPreview'),
    attachmentImage: document.getElementById('attachmentImage'),
    attachmentName: document.getElementById('attachmentName'),
    removeAttachmentBtn: document.getElementById('removeAttachmentBtn'),
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
    ,
    conversationList: document.getElementById('conversationList'),
    conversationSearch: document.getElementById('conversationSearch'),
    searchChatsBtn: document.getElementById('searchChatsBtn'),
    mobileMenuBtn: document.getElementById('mobileMenuBtn'),
    sidebar: document.getElementById('sidebar'),
    sidebarBackdrop: document.getElementById('sidebarBackdrop'),
    imagesBtn: document.getElementById('imagesBtn'),
    modulesBtn: document.getElementById('modulesBtn'),
    memoryBtn: document.getElementById('memoryBtn'),
    permissionsBtn: document.getElementById('permissionsBtn'),
    dataDrawer: document.getElementById('dataDrawer'),
    dataDrawerTitle: document.getElementById('dataDrawerTitle'),
    dataDrawerBody: document.getElementById('dataDrawerBody'),
    drawerBackdrop: document.getElementById('drawerBackdrop'),
    closeDataDrawerBtn: document.getElementById('closeDataDrawerBtn'),
    voiceBtn: document.getElementById('voiceBtn')
};

function createSessionId() {
    if (globalThis.crypto?.randomUUID) {
        return 'sess-' + globalThis.crypto.randomUUID();
    }
    return 'sess-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function getOrCreateSessionId() {
    const stored = localStorage.getItem('synchronSessionId');
    if (stored?.startsWith('sess-')) return stored;
    const sessionId = createSessionId();
    localStorage.setItem('synchronSessionId', sessionId);
    return sessionId;
}

async function init() {
    updateSessionDisplay();

    elements.sendBtn.addEventListener('click', sendMessage);
    elements.attachBtn.addEventListener('click', () => elements.imageInput.click());
    elements.imageInput.addEventListener('change', handleImageSelection);
    elements.removeAttachmentBtn.addEventListener('click', clearPendingImage);
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
    elements.conversationList.addEventListener('click', handleConversationClick);
    elements.conversationSearch.addEventListener('input', renderConversationList);
    elements.searchChatsBtn.addEventListener('click', toggleConversationSearch);
    elements.mobileMenuBtn.addEventListener('click', toggleSidebar);
    elements.sidebarBackdrop.addEventListener('click', closeSidebar);
    elements.imagesBtn.addEventListener('click', openImagePicker);
    elements.modulesBtn.addEventListener('click', openModulesDrawer);
    elements.memoryBtn.addEventListener('click', openMemoryDrawer);
    elements.permissionsBtn.addEventListener('click', openPermissionsDrawer);
    elements.closeDataDrawerBtn.addEventListener('click', closeDataDrawer);
    elements.drawerBackdrop.addEventListener('click', closeDataDrawer);
    elements.dataDrawerBody.addEventListener('click', handleDataDrawerAction);
    elements.voiceBtn.addEventListener('click', toggleVoiceInput);
    document.addEventListener('keydown', handleGlobalKeydown);
    prepareVoiceInput();

    checkHealth();
    checkOpenSearch();
    setInterval(checkHealth, 10000);
    setInterval(checkOpenSearch, 20000);

    await restoreConversation();
    await loadConversations();
}

function updateSessionDisplay() {
    elements.sessionIdDisplay.textContent = state.sessionId;
}

function formatMemorySummary(items) {
    const personal = items.filter(
        (item) => (item.scope || 'personal') === 'personal'
    );
    const project = items.filter((item) => item.scope === 'project');
    const sections = ['**Тест на паметта — това знам в момента:**'];

    if (personal.length) {
        sections.push(
            '**За теб:**\n' +
            personal.map((item) => '- ' + item.fact).join('\n')
        );
    }

    if (project.length) {
        sections.push(
            '**За проекта:**\n' +
            project.map((item) => '- ' + item.fact).join('\n')
        );
    }

    if (!personal.length && !project.length) {
        sections.push('Все още няма записани постоянни спомени.');
    }

    return sections.join('\n\n');
}

async function showWelcomeMessage() {
    try {
        const response = await fetch('/memory/profile', { cache: 'no-store' });
        if (!response.ok) throw new Error('Паметта не е достъпна.');
        const data = await response.json();
        const items = Array.isArray(data.items) ? data.items : [];
        appendMessage('agent', formatMemorySummary(items));
    } catch (error) {
        console.error(error);
        appendMessage(
            'agent',
            'Здравей, Радко. Аз съм Synchron-X — твоят личен AI асистент. Паметта временно не можа да бъде заредена.'
        );
    }
}

async function restoreConversation() {
    try {
        const response = await fetch(
            '/memory/conversation/' + encodeURIComponent(state.sessionId),
            { cache: 'no-store' }
        );
        if (!response.ok) throw new Error('Историята не е достъпна.');
        const data = await response.json();
        const items = Array.isArray(data.items) ? data.items : [];
        if (items.length === 0) {
            await showWelcomeMessage();
            return;
        }
        for (const item of items) {
            if (
                (item.role === 'user' || item.role === 'assistant') &&
                typeof item.content === 'string'
            ) {
                appendMessage(
                    item.role === 'assistant' ? 'agent' : 'user',
                    item.content
                );
            }
        }
        logAction('Възстановена е историята на разговора');
    } catch (error) {
        console.error(error);
        await showWelcomeMessage();
        logAction('Историята не можа да бъде възстановена');
    }
}

async function startNewChat() {
    if (state.chatBusy) return;
    closeSidebar();
    clearPendingImage();
    state.sessionId = createSessionId();
    localStorage.setItem('synchronSessionId', state.sessionId);
    state.lastActions = [];
    elements.chatMessages.replaceChildren();
    updateSessionDisplay();
    renderActionsLog();
    await showWelcomeMessage();
    logAction('Започнат е нов разговор');
    renderConversationList();
    elements.chatInput.focus();
}

async function loadConversations() {
    try {
        const response = await fetch('/memory/conversations', { cache: 'no-store' });
        if (!response.ok) throw new Error('Списъкът не е достъпен.');
        const data = await response.json();
        state.conversations = Array.isArray(data.items) ? data.items : [];
        renderConversationList();
    } catch (error) {
        console.error(error);
        state.conversations = [];
        renderConversationList();
    }
}

function renderConversationList() {
    const query = elements.conversationSearch.value.trim().toLocaleLowerCase('bg-BG');
    const conversations = state.conversations.filter((item) =>
        !query || item.title.toLocaleLowerCase('bg-BG').includes(query)
    );
    elements.conversationList.replaceChildren();

    for (const item of conversations) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'conversation';
        if (item.sessionId === state.sessionId) button.classList.add('active');
        button.dataset.sessionId = item.sessionId;
        button.textContent = item.title;
        elements.conversationList.appendChild(button);
    }
}

async function handleConversationClick(event) {
    const button = event.target.closest('button[data-session-id]');
    if (!button || state.chatBusy || button.dataset.sessionId === state.sessionId) return;
    state.sessionId = button.dataset.sessionId;
    localStorage.setItem('synchronSessionId', state.sessionId);
    elements.chatMessages.replaceChildren();
    updateSessionDisplay();
    renderConversationList();
    await restoreConversation();
    closeSidebar();
}

function toggleSidebar() {
    const isOpen = elements.sidebar.classList.toggle('mobile-visible');
    elements.sidebarBackdrop.hidden = !isOpen;
    elements.mobileMenuBtn.setAttribute('aria-expanded', String(isOpen));
}

function closeSidebar() {
    elements.sidebar.classList.remove('mobile-visible');
    elements.sidebarBackdrop.hidden = true;
    elements.mobileMenuBtn.setAttribute('aria-expanded', 'false');
}

function openImagePicker() {
    closeSidebar();
    elements.imageInput.click();
}

function handleGlobalKeydown(event) {
    if (event.key !== 'Escape') return;
    closeSidebar();
    closeStatus();
    closeDataDrawer();
}

function toggleConversationSearch() {
    elements.conversationSearch.hidden = !elements.conversationSearch.hidden;
    if (!elements.conversationSearch.hidden) elements.conversationSearch.focus();
}

function handleImageSelection(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowedTypes.includes(file.type)) {
        appendMessage('agent', '❌ Поддържат се само JPEG, PNG и WebP снимки.');
        clearPendingImage();
        return;
    }

    if (file.size > 5 * 1024 * 1024) {
        appendMessage('agent', '❌ Снимката трябва да бъде до 5 MB.');
        clearPendingImage();
        return;
    }

    const reader = new FileReader();
    reader.onload = () => {
        state.pendingImage = {
            dataUrl: reader.result,
            mimeType: file.type,
            name: file.name
        };
        elements.attachmentImage.src = reader.result;
        elements.attachmentName.textContent = file.name;
        elements.attachmentPreview.hidden = false;
        elements.chatInput.focus();
    };
    reader.onerror = () => {
        appendMessage('agent', '❌ Снимката не можа да бъде прочетена.');
        clearPendingImage();
    };
    reader.readAsDataURL(file);
}

function clearPendingImage() {
    state.pendingImage = null;
    elements.imageInput.value = '';
    elements.attachmentImage.removeAttribute('src');
    elements.attachmentName.textContent = '';
    elements.attachmentPreview.hidden = true;
}

function openStatus() {
    closeSidebar();
    elements.statusPanel.classList.add('mobile-visible');
}

function closeStatus() {
    elements.statusPanel.classList.remove('mobile-visible');
}

function prepareVoiceInput() {
    const SpeechRecognition =
        window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        elements.voiceBtn.hidden = true;
        return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = 'bg-BG';
    recognition.continuous = false;
    recognition.interimResults = true;

    recognition.onstart = () => setListening(true);
    recognition.onend = () => setListening(false);
    recognition.onerror = (event) => {
        setListening(false);
        if (event.error !== 'aborted' && event.error !== 'no-speech') {
            appendMessage(
                'agent',
                'Гласовото въвеждане не можа да стартира. Провери достъпа до микрофона.'
            );
        }
    };
    recognition.onresult = (event) => {
        let transcript = '';
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
            transcript += event.results[index][0].transcript;
        }
        elements.chatInput.value = transcript.trim();
        const lastResult = event.results[event.results.length - 1];
        if (lastResult?.isFinal) elements.chatInput.focus();
    };
    state.recognition = recognition;
}

function setListening(isListening) {
    state.listening = isListening;
    elements.voiceBtn.classList.toggle('listening', isListening);
    elements.voiceBtn.setAttribute('aria-pressed', String(isListening));
    elements.voiceBtn.title = isListening ? 'Спри слушането' : 'Гласово въвеждане';
}

function toggleVoiceInput() {
    if (!state.recognition || state.chatBusy) return;
    if (state.listening) {
        state.recognition.stop();
    } else {
        state.recognition.start();
    }
}

function openModulesDrawer() {
    openDataDrawer('Модули');
    elements.dataDrawerBody.innerHTML = `
        <section class="drawer-section permission-list">
            <article class="permission-card"><div><strong>Разговор с AI</strong><p>Основен разговор със Synchron-X</p></div><span class="permission-badge allow">Работи</span></article>
            <article class="permission-card"><div><strong>Памет</strong><p>Личен и проектен контекст</p></div><span class="permission-badge allow">Работи</span></article>
            <article class="permission-card"><div><strong>Снимки</strong><p>Избор и анализ на изображение</p></div><span class="permission-badge confirm">За тест</span></article>
            <article class="permission-card"><div><strong>Google Calendar</strong><p>Предстои проверка от край до край</p></div><span class="permission-badge deny">Неактивен</span></article>
        </section>`;
}

function openDataDrawer(title) {
    elements.dataDrawerTitle.textContent = title;
    elements.dataDrawer.hidden = false;
    elements.drawerBackdrop.hidden = false;
    elements.sidebar.classList.remove('mobile-visible');
}

function closeDataDrawer() {
    elements.dataDrawer.hidden = true;
    elements.drawerBackdrop.hidden = true;
}

function renderDrawerLoading() {
    elements.dataDrawerBody.innerHTML =
        '<div class="drawer-state"><i class="fa-solid fa-circle-notch fa-spin"></i> Зареждане…</div>';
}

function renderDrawerError(message) {
    elements.dataDrawerBody.innerHTML =
        `<div class="drawer-state drawer-error">${escapeHtml(message)}</div>`;
}

function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = String(value ?? '');
    return div.innerHTML;
}

async function openMemoryDrawer() {
    openDataDrawer('Памет');
    renderDrawerLoading();
    try {
        const response = await fetch('/memory/profile', { cache: 'no-store' });
        if (!response.ok) throw new Error('Паметта временно не е достъпна.');
        const data = await response.json();
        state.memoryItems = Array.isArray(data.items) ? data.items : [];
        renderMemoryItems();
    } catch (error) {
        renderDrawerError(error.message);
    }
}

function renderMemoryItems() {
    const personal = state.memoryItems.filter(
        (item) => (item.scope || 'personal') === 'personal'
    );
    const project = state.memoryItems.filter((item) => item.scope === 'project');
    const section = (title, items) => `
        <section class="drawer-section">
            <h3>${title} <span>${items.length}</span></h3>
            ${items.length
                ? items.map((item) => `
                    <article class="memory-card">
                        <p>${escapeHtml(item.fact)}</p>
                        <button type="button" data-memory-delete="${escapeHtml(item.id)}"
                            aria-label="Изтрий този спомен" title="Изтрий">
                            <i class="fa-regular fa-trash-can"></i>
                        </button>
                    </article>`).join('')
                : '<div class="drawer-empty">Няма записани спомени.</div>'}
        </section>`;
    elements.dataDrawerBody.innerHTML =
        section('За теб', personal) + section('За проекта', project);
}

async function openPermissionsDrawer() {
    openDataDrawer('Разрешения');
    renderDrawerLoading();
    try {
        const response = await fetch('/permissions', { cache: 'no-store' });
        if (!response.ok) throw new Error('Разрешенията временно не са достъпни.');
        const data = await response.json();
        const labels = { allow: 'Разрешено', confirm: 'Иска потвърждение', deny: 'Забранено' };
        elements.dataDrawerBody.innerHTML = `
            <div class="permission-default">
                Непознатите действия са <strong>забранени по подразбиране</strong>.
            </div>
            <section class="drawer-section permission-list">
                ${(data.permissions || []).map((item) => `
                    <article class="permission-card">
                        <div>
                            <strong>${escapeHtml(item.action)}</strong>
                            <p>${escapeHtml(item.reason)}</p>
                        </div>
                        <span class="permission-badge ${escapeHtml(item.decision)}">
                            ${labels[item.decision] || escapeHtml(item.decision)}
                        </span>
                    </article>`).join('')}
            </section>`;
    } catch (error) {
        renderDrawerError(error.message);
    }
}

async function handleDataDrawerAction(event) {
    const button = event.target.closest('button[data-memory-delete]');
    if (!button) return;
    const item = state.memoryItems.find(
        (candidate) => candidate.id === button.dataset.memoryDelete
    );
    if (!item) return;

    const confirmed = window.confirm(
        `Да изтрия ли този спомен?\n\n${item.fact}`
    );
    if (!confirmed) return;

    button.disabled = true;
    try {
        const response = await fetch(
            '/memory/profile/' + encodeURIComponent(item.id),
            {
                method: 'DELETE',
                headers: {
                    'x-confirm-memory-delete':
                        'confirm-delete-profile-memory'
                }
            }
        );
        if (!response.ok) {
            const data = await response.json().catch(() => null);
            throw new Error(data?.error || 'Споменът не можа да бъде изтрит.');
        }
        state.memoryItems = state.memoryItems.filter(
            (candidate) => candidate.id !== item.id
        );
        renderMemoryItems();
        logAction('Изтрит е потвърден спомен');
    } catch (error) {
        renderDrawerError(error.message);
    }
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
    elements.attachBtn.disabled = isBusy;
    elements.voiceBtn.disabled = isBusy;
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

    const turn = button.closest('.assistant-turn, .user-turn');
    const message = turn?.querySelector('.message.agent, .message.user');
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
    const image = state.pendingImage;
    if ((!text && !image) || state.chatBusy) return;

    const messageText = text || 'Какво виждаш на тази снимка?';
    appendMessage('user', messageText, image);
    elements.chatInput.value = '';
    clearPendingImage();
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
                message: messageText,
                image
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
        await loadConversations();
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

function appendMessage(role, text, image = null) {
    if (role === 'agent') {
        const assistantTurn = createAssistantTurn(text, true);
        scrollChatToBottom();
        return assistantTurn.message;
    }

    const turn = document.createElement('div');
    turn.className = 'user-turn';

    const div = document.createElement('div');
    div.className = `message ${role}`;
    div.dataset.rawText = text;
    if (image?.dataUrl) {
        const preview = document.createElement('img');
        preview.className = 'message-image';
        preview.src = image.dataUrl;
        preview.alt = image.name || 'Изпратена снимка';
        div.appendChild(preview);
    }

    const textNode = document.createElement('div');
    textNode.textContent = text;
    div.appendChild(textNode);

    const actions = document.createElement('div');
    actions.className = 'message-actions user-actions';
    actions.innerHTML = `
        <button type="button" data-action="copy" title="Копирай" aria-label="Копирай">
            <i class="fa-regular fa-copy"></i>
        </button>
    `;

    turn.append(div, actions);
    elements.chatMessages.appendChild(turn);
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
