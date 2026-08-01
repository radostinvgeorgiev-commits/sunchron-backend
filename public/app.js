const state = {
  sessionId: getOrCreateSessionId(),
  serverOnline: false,
  opensearchStatus: "unknown",
  opensearchFailures: 0,
  lastMemorySuccessAt: 0,
  lastActions: [],
  chatBusy: false,
  speakingButton: null,
  pendingImage: null,
  conversations: [],
  conversationLoadError: "",
  memoryItems: [],
  recognition: null,
  listening: false,
  authenticatedUser: null,
  registrationEnabled: false,
  applicationStarted: false,
};

const elements = {
  authGate: document.getElementById("authGate"),
  appShell: document.getElementById("appShell"),
  loginForm: document.getElementById("loginForm"),
  loginEmail: document.getElementById("loginEmail"),
  loginPassword: document.getElementById("loginPassword"),
  loginBtn: document.getElementById("loginBtn"),
  showRegisterBtn: document.getElementById("showRegisterBtn"),
  registerForm: document.getElementById("registerForm"),
  registerName: document.getElementById("registerName"),
  registerEmail: document.getElementById("registerEmail"),
  registerPassword: document.getElementById("registerPassword"),
  registerInviteCode: document.getElementById("registerInviteCode"),
  registerBtn: document.getElementById("registerBtn"),
  backToLoginBtn: document.getElementById("backToLoginBtn"),
  authMessage: document.getElementById("authMessage"),
  chatMessages: document.getElementById("chatMessages"),
  chatInput: document.getElementById("chatInput"),
  sendBtn: document.getElementById("sendBtn"),
  attachBtn: document.getElementById("attachBtn"),
  imageInput: document.getElementById("imageInput"),
  attachmentPreview: document.getElementById("attachmentPreview"),
  attachmentImage: document.getElementById("attachmentImage"),
  attachmentName: document.getElementById("attachmentName"),
  removeAttachmentBtn: document.getElementById("removeAttachmentBtn"),
  newChatBtn: document.getElementById("newChatBtn"),
  toggleStatusBtn: document.getElementById("toggleStatusBtn"),
  profileActions: document.getElementById("profileActions"),
  profileStatusBtn: document.getElementById("profileStatusBtn"),
  sidebarLogoutBtn: document.getElementById("sidebarLogoutBtn"),
  closeContextBtn: document.getElementById("closeContextBtn"),
  statusPanel: document.getElementById("statusPanel"),
  agentStatusDot: document.getElementById("agentStatusDot"),
  agentStatusText: document.getElementById("agentStatusText"),
  sessionIdDisplay: document.getElementById("sessionIdDisplay"),
  serverStatusDisplay: document.getElementById("serverStatusDisplay"),
  opensearchStatusDisplay: document.getElementById("opensearchStatusDisplay"),
  actionsLog: document.getElementById("actionsLog"),
  conversationList: document.getElementById("conversationList"),
  conversationSearch: document.getElementById("conversationSearch"),
  searchChatsBtn: document.getElementById("searchChatsBtn"),
  mobileMenuBtn: document.getElementById("mobileMenuBtn"),
  sidebar: document.getElementById("sidebar"),
  sidebarBackdrop: document.getElementById("sidebarBackdrop"),
  imagesBtn: document.getElementById("imagesBtn"),
  modulesBtn: document.getElementById("modulesBtn"),
  systemConfigurationBtn: document.getElementById("systemConfigurationBtn"),
  focusBtn: document.getElementById("focusBtn"),
  toolsBtn: document.getElementById("toolsBtn"),
  memoryBtn: document.getElementById("memoryBtn"),
  permissionsBtn: document.getElementById("permissionsBtn"),
  dataDrawer: document.getElementById("dataDrawer"),
  dataDrawerTitle: document.getElementById("dataDrawerTitle"),
  dataDrawerBody: document.getElementById("dataDrawerBody"),
  drawerBackdrop: document.getElementById("drawerBackdrop"),
  closeDataDrawerBtn: document.getElementById("closeDataDrawerBtn"),
  voiceBtn: document.getElementById("voiceBtn"),
  profileAvatar: document.getElementById("profileAvatar"),
  profileName: document.getElementById("profileName"),
  profileRole: document.getElementById("profileRole"),
  logoutBtn: document.getElementById("logoutBtn"),
};

function createSessionId() {
  if (globalThis.crypto?.randomUUID) {
    return "sess-" + globalThis.crypto.randomUUID();
  }
  return (
    "sess-" + Math.random().toString(36).slice(2) + Date.now().toString(36)
  );
}

function getOrCreateSessionId() {
  const stored = localStorage.getItem("synchronSessionId");
  if (stored?.startsWith("sess-")) return stored;
  const sessionId = createSessionId();
  localStorage.setItem("synchronSessionId", sessionId);
  return sessionId;
}

function setAuthMessage(message = "", success = false) {
  elements.authMessage.textContent = message;
  elements.authMessage.classList.toggle("success", success);
}

function setAuthBusy(isBusy) {
  elements.loginBtn.disabled = isBusy;
  elements.registerBtn.disabled = isBusy;
}

function showLoginForm() {
  elements.loginForm.hidden = false;
  elements.registerForm.hidden = true;
  elements.showRegisterBtn.hidden = !state.registrationEnabled;
  setAuthMessage();
  elements.loginEmail.focus();
}

function showRegisterForm() {
  elements.loginForm.hidden = true;
  elements.registerForm.hidden = false;
  elements.showRegisterBtn.hidden = true;
  setAuthMessage();
  elements.registerName.focus();
}

async function readAuthSession() {
  const response = await fetch("/api/auth/session", { cache: "no-store" });
  if (!response.ok) {
    throw new Error("Входът временно не е достъпен.");
  }
  return response.json();
}

async function submitAuth(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(data?.error || "Входът не беше успешен.");
    error.code = data?.code || "AUTH_REQUEST_FAILED";
    throw error;
  }
  return data;
}

function consumeSharedTesterInvite() {
  const hash = globalThis.location?.hash || "";
  if (!hash.startsWith("#")) return "";
  const params = new URLSearchParams(hash.slice(1));
  const inviteCode = (params.get("tester-invite") || "").trim();
  if (!inviteCode) return "";
  globalThis.history?.replaceState?.(
    null,
    "",
    `${globalThis.location.pathname || "/"}${globalThis.location.search || ""}`,
  );
  return inviteCode;
}

async function handleLogin(event) {
  event.preventDefault();
  setAuthBusy(true);
  setAuthMessage();
  try {
    await submitAuth("/api/auth/login", {
      email: elements.loginEmail.value,
      password: elements.loginPassword.value,
    });
    elements.loginPassword.value = "";
    const session = await readAuthSession();
    if (!session.authenticated) throw new Error("Сесията не беше създадена.");
    await startApplication(session.user);
  } catch (error) {
    setAuthMessage(error.message);
  } finally {
    setAuthBusy(false);
  }
}

async function handleRegistration(event) {
  event.preventDefault();
  setAuthBusy(true);
  setAuthMessage();
  try {
    const result = await submitAuth("/api/auth/register", {
      displayName: elements.registerName.value,
      email: elements.registerEmail.value,
      password: elements.registerPassword.value,
      inviteCode: elements.registerInviteCode.value,
    });
    elements.registerPassword.value = "";
    elements.registerInviteCode.value = "";
    if (result.confirmationRequired) {
      showLoginForm();
      elements.loginEmail.value = result.user?.email || "";
      setAuthMessage(
        "Профилът е създаден. Потвърди имейла си и после влез.",
        true,
      );
      return;
    }
    const session = await readAuthSession();
    if (!session.authenticated) throw new Error("Сесията не беше създадена.");
    await startApplication(session.user);
  } catch (error) {
    setAuthMessage(
      error.code === "AUTH_INVALID_INVITE_CODE"
        ? "Поканата вече не е валидна. Отвори новия линк за покана, изпратен от собственика."
        : error.message,
    );
  } finally {
    setAuthBusy(false);
  }
}

async function handleLogout() {
  elements.logoutBtn.disabled = true;
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } finally {
    globalThis.location.href = "/";
  }
}

function applyAuthenticatedUser(user) {
  state.authenticatedUser = user;
  const displayName = user?.displayName || "Потребител";
  const isOwner = user?.role === "owner";
  elements.profileName.textContent = displayName;
  elements.profileAvatar.textContent =
    displayName.trim().charAt(0).toLocaleUpperCase("bg-BG") || "П";
  elements.profileRole.textContent = isOwner
    ? "Собственик · настройки"
    : "Тестов профил";
  document.body.dataset.userRole = isOwner ? "owner" : "tester";
  for (const item of document.querySelectorAll("[data-owner-only]")) {
    item.hidden = !isOwner;
  }
}

async function init() {
  elements.loginForm.addEventListener("submit", handleLogin);
  elements.registerForm.addEventListener("submit", handleRegistration);
  elements.showRegisterBtn.addEventListener("click", showRegisterForm);
  elements.backToLoginBtn.addEventListener("click", showLoginForm);

  try {
    const session = await readAuthSession();
    state.registrationEnabled = Boolean(session.registrationEnabled);
    elements.showRegisterBtn.hidden = !state.registrationEnabled;
    if (session.authenticated) {
      await startApplication(session.user);
      return;
    }
    elements.authGate.hidden = false;
    elements.appShell.hidden = true;
    const sharedInvite = consumeSharedTesterInvite();
    if (state.registrationEnabled && sharedInvite) {
      elements.registerInviteCode.value = sharedInvite;
      showRegisterForm();
      setAuthMessage(
        "Поканата е приложена. Попълни име, имейл и парола.",
        true,
      );
      return;
    }
    if (!session.configured) {
      setAuthMessage(
        "Входът за тестови профили още не е активиран. Собственикът може да влезе с GitHub.",
      );
    }
  } catch (error) {
    setAuthMessage(error.message);
  }
}

async function startApplication(user) {
  if (state.applicationStarted) return;
  state.applicationStarted = true;
  applyAuthenticatedUser(user);
  globalThis.SynchronWorkMode?.init(user);
  elements.authGate.hidden = true;
  elements.appShell.hidden = false;
  updateSessionDisplay();

  elements.sendBtn.addEventListener("click", sendMessage);
  elements.attachBtn.addEventListener("click", () =>
    elements.imageInput.click(),
  );
  elements.imageInput.addEventListener("change", handleImageSelection);
  elements.removeAttachmentBtn.addEventListener("click", clearPendingImage);
  elements.chatInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  });
  elements.newChatBtn.addEventListener("click", startNewChat);
  elements.toggleStatusBtn.addEventListener("click", toggleProfileActions);
  elements.profileStatusBtn.addEventListener("click", openStatus);
  elements.sidebarLogoutBtn.addEventListener("click", handleLogout);
  elements.closeContextBtn.addEventListener("click", closeStatus);
  elements.chatMessages.addEventListener("click", handleMessageAction);
  elements.conversationList.addEventListener("click", handleConversationClick);
  elements.conversationSearch.addEventListener("input", renderConversationList);
  elements.searchChatsBtn.addEventListener("click", toggleConversationSearch);
  elements.mobileMenuBtn.addEventListener("click", toggleSidebar);
  elements.sidebarBackdrop.addEventListener("click", closeSidebar);
  elements.imagesBtn.addEventListener("click", openImagePicker);
  elements.modulesBtn.addEventListener("click", openModulesDrawer);
  elements.toolsBtn.addEventListener("click", openToolsDrawer);
  elements.systemConfigurationBtn.addEventListener(
    "click",
    openSystemConfigurationDrawer,
  );
  elements.memoryBtn.addEventListener("click", openMemoryDrawer);
  elements.permissionsBtn.addEventListener("click", openPermissionsDrawer);
  elements.closeDataDrawerBtn.addEventListener("click", closeDataDrawer);
  elements.drawerBackdrop.addEventListener("click", closeDataDrawer);
  elements.dataDrawerBody.addEventListener("click", handleDataDrawerAction);
  elements.voiceBtn.addEventListener("click", toggleVoiceInput);
  elements.logoutBtn.addEventListener("click", handleLogout);
  document.addEventListener("keydown", handleGlobalKeydown);
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

async function showWelcomeMessage() {
  appendMessage(
    "agent",
    [
      "## AI CORE",
      "**Твоята лична AI операционна система.**",
      "",
      "Едно AI ядро, постоянна контролирана памет и разрешени инструменти за реални задачи.",
      "",
      "AI аватарът е моят начин на общуване. Ти контролираш данните, паметта и рисковите действия.",
    ].join("\n"),
  );
}

async function restoreConversation() {
  try {
    const response = await fetch(
      "/memory/conversation/" + encodeURIComponent(state.sessionId),
      { cache: "no-store" },
    );
    if (!response.ok) throw new Error("Историята не е достъпна.");
    const data = await response.json();
    markMemoryOperational();
    const items = Array.isArray(data.items) ? data.items : [];
    if (items.length === 0) {
      await showWelcomeMessage();
      return;
    }
    for (const item of items) {
      if (
        (item.role === "user" || item.role === "assistant") &&
        typeof item.content === "string"
      ) {
        appendMessage(
          item.role === "assistant" ? "agent" : "user",
          item.content,
        );
      }
    }
    logAction("Възстановена е историята на разговора");
  } catch (error) {
    console.error(error);
    await showWelcomeMessage();
    logAction("Историята не можа да бъде възстановена");
  }
}

async function startNewChat() {
  if (state.chatBusy) return;
  closeSidebar();
  clearPendingImage();
  state.sessionId = createSessionId();
  localStorage.setItem("synchronSessionId", state.sessionId);
  state.lastActions = [];
  elements.chatMessages.replaceChildren();
  updateSessionDisplay();
  renderActionsLog();
  await showWelcomeMessage();
  logAction("Започнат е нов разговор");
  renderConversationList();
  elements.chatInput.focus();
}

async function loadConversations() {
  try {
    const response = await fetch("/memory/conversations", {
      cache: "no-store",
    });
    if (!response.ok) throw new Error("Списъкът не е достъпен.");
    const data = await response.json();
    state.conversations = Array.isArray(data.items) ? data.items : [];
    state.conversationLoadError = "";
    renderConversationList();
  } catch (error) {
    console.error(error);
    state.conversations = [];
    state.conversationLoadError =
      "Историята временно не е достъпна. Опитай отново.";
    renderConversationList();
  }
}

function renderConversationList() {
  const query = elements.conversationSearch.value
    .trim()
    .toLocaleLowerCase("bg-BG");
  const conversations = state.conversations.filter(
    (item) => !query || item.title.toLocaleLowerCase("bg-BG").includes(query),
  );
  elements.conversationList.replaceChildren();

  if (state.conversationLoadError) {
    const error = document.createElement("p");
    error.className = "conversation-state conversation-state-error";
    error.textContent = state.conversationLoadError;
    elements.conversationList.appendChild(error);
    return;
  }

  if (conversations.length === 0) {
    const empty = document.createElement("p");
    empty.className = "conversation-state";
    empty.textContent = query
      ? "Няма намерени разговори."
      : "Все още няма запазени разговори.";
    elements.conversationList.appendChild(empty);
    return;
  }

  for (const item of conversations) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "conversation";
    if (item.sessionId === state.sessionId) button.classList.add("active");
    button.dataset.sessionId = item.sessionId;
    button.textContent = item.title;
    elements.conversationList.appendChild(button);
  }
}

async function handleConversationClick(event) {
  const button = event.target.closest("button[data-session-id]");
  if (!button || state.chatBusy || button.dataset.sessionId === state.sessionId)
    return;
  state.sessionId = button.dataset.sessionId;
  localStorage.setItem("synchronSessionId", state.sessionId);
  elements.chatMessages.replaceChildren();
  updateSessionDisplay();
  renderConversationList();
  await restoreConversation();
  closeSidebar();
}

function toggleSidebar() {
  const isOpen = elements.sidebar.classList.toggle("mobile-visible");
  elements.sidebarBackdrop.hidden = !isOpen;
  elements.mobileMenuBtn.setAttribute("aria-expanded", String(isOpen));
}

function closeSidebar() {
  elements.sidebar.classList.remove("mobile-visible");
  elements.sidebarBackdrop.hidden = true;
  elements.mobileMenuBtn.setAttribute("aria-expanded", "false");
  closeProfileActions();
}

function toggleProfileActions() {
  const shouldOpen = elements.profileActions.hidden;
  elements.profileActions.hidden = !shouldOpen;
  elements.toggleStatusBtn.setAttribute("aria-expanded", String(shouldOpen));
}

function closeProfileActions() {
  elements.profileActions.hidden = true;
  elements.toggleStatusBtn.setAttribute("aria-expanded", "false");
}

function openImagePicker() {
  closeSidebar();
  elements.imageInput.click();
}

function handleGlobalKeydown(event) {
  if (event.key !== "Escape") return;
  closeSidebar();
  closeStatus();
  closeDataDrawer();
}

function toggleConversationSearch() {
  elements.conversationSearch.hidden = false;
  elements.conversationList
    .closest(".sidebar-section")
    ?.scrollIntoView({ block: "start", behavior: "smooth" });
  elements.conversationSearch.focus({ preventScroll: true });
}

function handleImageSelection(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  const allowedTypes = ["image/jpeg", "image/png", "image/webp"];
  if (!allowedTypes.includes(file.type)) {
    appendMessage("agent", "❌ Поддържат се само JPEG, PNG и WebP снимки.");
    clearPendingImage();
    return;
  }

  if (file.size > 5 * 1024 * 1024) {
    appendMessage("agent", "❌ Снимката трябва да бъде до 5 MB.");
    clearPendingImage();
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    state.pendingImage = {
      dataUrl: reader.result,
      mimeType: file.type,
      name: file.name,
    };
    elements.attachmentImage.src = reader.result;
    elements.attachmentName.textContent = file.name;
    elements.attachmentPreview.hidden = false;
    elements.chatInput.focus();
  };
  reader.onerror = () => {
    appendMessage("agent", "❌ Снимката не можа да бъде прочетена.");
    clearPendingImage();
  };
  reader.readAsDataURL(file);
}

function clearPendingImage() {
  state.pendingImage = null;
  elements.imageInput.value = "";
  elements.attachmentImage.removeAttribute("src");
  elements.attachmentName.textContent = "";
  elements.attachmentPreview.hidden = true;
}

function openStatus() {
  closeSidebar();
  elements.statusPanel.classList.add("mobile-visible");
}

function closeStatus() {
  elements.statusPanel.classList.remove("mobile-visible");
}

function prepareVoiceInput() {
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    elements.voiceBtn.hidden = true;
    return;
  }

  const recognition = new SpeechRecognition();
  recognition.lang = "bg-BG";
  recognition.continuous = false;
  recognition.interimResults = true;

  recognition.onstart = () => setListening(true);
  recognition.onend = () => setListening(false);
  recognition.onerror = (event) => {
    setListening(false);
    if (event.error !== "aborted" && event.error !== "no-speech") {
      appendMessage(
        "agent",
        "Гласовото въвеждане не можа да стартира. Провери достъпа до микрофона.",
      );
    }
  };
  recognition.onresult = (event) => {
    let transcript = "";
    for (
      let index = event.resultIndex;
      index < event.results.length;
      index += 1
    ) {
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
  elements.voiceBtn.classList.toggle("listening", isListening);
  elements.voiceBtn.setAttribute("aria-pressed", String(isListening));
  elements.voiceBtn.title = isListening
    ? "Спри слушането"
    : "Гласово въвеждане";
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
  openDataDrawer("Работни области");
  elements.dataDrawerBody.innerHTML = `
        <div class="module-summary">
            Това са области, в които личната AI операционна система използва разговора,
            паметта и разрешените инструменти. Областта сама по себе си не
            означава, че външна услуга е свързана.
        </div>
        <section class="drawer-section permission-list module-list" data-module-list></section>`;
  document.dispatchEvent(new CustomEvent("synchron:modules-opened"));
}

function isGoogleTool(tool) {
  return (
    tool?.provider === "google" ||
    tool?.id?.startsWith("google-") ||
    tool?.id === "gmail-read"
  );
}

function toolState(tool, googleConnected, githubConnected) {
  if (tool.availabilityCode === "COPILOT_AUTOMATION_DISABLED") {
    return { label: "Изключено · режим без Copilot", className: "confirm" };
  }
  if (!tool.enabled || !tool.executable) {
    return { label: "Не е свързан", className: "deny" };
  }
  if (!tool.configured) {
    return { label: "Не е конфигуриран", className: "deny" };
  }
  if (isGoogleTool(tool) && !googleConnected) {
    return { label: "Иска свързване", className: "confirm" };
  }
  if (tool.id === "github-write" && !githubConnected) {
    return { label: "Иска свързване", className: "confirm" };
  }
  return { label: "Работи", className: "allow" };
}

function toolStatusActions(tool, status, googleConnected, githubConnected) {
  let action = "";
  if (tool.availabilityCode === "COPILOT_AUTOMATION_DISABLED") {
    action = "";
  } else if (isGoogleTool(tool) && !googleConnected && tool.configured) {
    action =
      '<button type="button" class="tool-connect-btn" data-connect-service="google">Свържи Google</button>';
  } else if (
    tool.id === "github-write" &&
    tool.configured &&
    !githubConnected
  ) {
    action =
      '<button type="button" class="tool-connect-btn" data-connect-service="github">Свържи GitHub</button>';
  } else if (tool.id === "github-write" && !tool.configured) {
    action =
      '<button type="button" class="tool-connect-btn" data-github-setup>Настрой GitHub</button>';
  }

  return `
    <div class="tool-status-actions">
      <span class="permission-badge ${status.className}">${status.label}</span>
      ${action}
    </div>`;
}

function permissionAction(item, toolMap, googleConnected, githubConnected) {
  const googlePermissions = new Set([
    "calendar.read",
    "calendar.write",
    "drive.read",
    "mail.read",
  ]);
  if (googlePermissions.has(item.action) && !googleConnected) {
    return '<button type="button" class="tool-connect-btn" data-connect-service="google">Свържи Google</button>';
  }

  const githubWrite = toolMap.get("github-write");
  if (
    item.action === "github.write" &&
    githubWrite?.availabilityCode === "COPILOT_AUTOMATION_DISABLED"
  ) {
    return "";
  }
  if (
    item.action === "github.write" &&
    githubWrite?.configured &&
    githubWrite?.executable &&
    !githubConnected
  ) {
    return '<button type="button" class="tool-connect-btn" data-connect-service="github">Свържи GitHub</button>';
  }
  if (
    item.action === "github.write" &&
    (!githubWrite?.configured || !githubWrite?.executable)
  ) {
    return '<button type="button" class="tool-connect-btn" data-github-setup>Настрой GitHub</button>';
  }

  if (item.decision === "confirm") {
    return `<button type="button" class="permission-info-btn" data-permission-info="${escapeHtml(item.action)}">Как работи</button>`;
  }
  return "";
}

async function openToolsDrawer() {
  openDataDrawer("Инструменти");
  renderDrawerLoading();
  try {
    const [healthResponse, googleResponse, githubResponse] = await Promise.all([
      fetch("/health/integrations", { cache: "no-store" }),
      fetch("/api/google/status", { cache: "no-store" }).catch(() => null),
      fetch("/api/github/status", { cache: "no-store" }).catch(() => null),
    ]);
    if (!healthResponse.ok) {
      throw new Error("Състоянието на инструментите не е достъпно.");
    }
    const data = await healthResponse.json();
    const googleData = googleResponse?.ok
      ? await googleResponse.json().catch(() => ({}))
      : {};
    const githubData = githubResponse?.ok
      ? await githubResponse.json().catch(() => ({}))
      : {};
    const tools = Array.isArray(data.tools) ? data.tools : [];
    const descriptions = {
      "github-read": "Проверява commit-и и файлове. Само за четене.",
      "github-write":
        "Copilot мост: отделен клон, commit-и и Pull Request след точно потвърждение. Без автоматично сливане.",
      "google-drive-read": "Чете разрешени файлове от Google Drive.",
      "google-calendar-read": "Показва събития от Google Calendar.",
      "gmail-read": "Показва разрешени имейли. Не изпраща.",
      "openai-web-search": "Търси актуална информация в интернет.",
      "opensearch-memory": "Пази лична и проектна памет под твой контрол.",
      "synchron-system-inspector":
        "Проверява ядрото и всички runtime/DigitalOcean настройки без техните стойности.",
    };
    elements.dataDrawerBody.innerHTML = `
      <div class="permission-default">
        Показано е реалното състояние. „Регистриран“ не означава автоматично „работи“.
      </div>
      <section class="drawer-section permission-list">
        <button type="button" class="permission-card tool-status-card system-control-link" data-system-configuration>
          <div>
            <strong>Системен контрол</strong>
            <p>Ядро, инструменти и всички променливи без показване на тайните им стойности.</p>
          </div>
          <span class="permission-badge allow">Отвори</span>
        </button>
        <article class="permission-card tool-status-card">
          <div><strong>Снимки</strong><p>JPEG, PNG и WebP до 5 MB.</p></div>
          <span class="permission-badge allow">Работи</span>
        </article>
        ${tools
          .map((tool) => {
            const status = toolState(
              tool,
              Boolean(googleData.connected),
              Boolean(githubData.connected),
            );
            const description =
              tool.id === "github-write" &&
              tool.availabilityCode === "COPILOT_AUTOMATION_DISABLED"
                ? "Кодовият мост е запазен, но е изключен в текущия режим без Copilot."
                : descriptions[tool.id] || "Инструмент на AI CORE.";
            return `
              <article class="permission-card tool-status-card">
                <div>
                  <strong>${escapeHtml(tool.name)}</strong>
                  <p>${escapeHtml(description)}</p>
                </div>
                ${toolStatusActions(
                  tool,
                  status,
                  Boolean(googleData.connected),
                  Boolean(githubData.connected),
                )}
              </article>`;
          })
          .join("")}
      </section>`;
  } catch (error) {
    renderDrawerError(error.message);
  }
}

function configurationStatus(item) {
  const labels = {
    configured: ["Настроена", "allow"],
    defaulted: ["По подразбиране", "allow"],
    "protected-fallback": ["Защитен заместител", "allow"],
    "missing-required": ["Липсва", "deny"],
    "optional-missing": ["Незадължителна", "confirm"],
    compatibility: ["Стар резервен път", "confirm"],
    "not-needed": ["Не е нужна", "allow"],
    unused: ["Не се използва", "deny"],
  };
  const [label, className] = labels[item.status] || [item.status, "confirm"];
  return { label, className };
}

function renderEnvironmentGroup(area, items) {
  return `
    <details class="configuration-group" ${items.some((item) => item.status === "missing-required") ? "open" : ""}>
      <summary>${escapeHtml(area)} <span>${items.length}</span></summary>
      <div class="configuration-list">
        ${items
          .map((item) => {
            const status = configurationStatus(item);
            return `
              <article class="configuration-item">
                <div>
                  <code>${escapeHtml(item.key)}</code>
                  <p>${escapeHtml(item.purpose)}</p>
                  <small>
                    ${item.sensitivity === "secret" ? "Тайна стойност · никога не се показва" : "Обща настройка"}
                    · DigitalOcean: ${item.digitalOceanDeclared ? "декларирана" : "не е декларирана"}
                  </small>
                </div>
                <span class="permission-badge ${status.className}">${status.label}</span>
              </article>`;
          })
          .join("")}
      </div>
    </details>`;
}

async function openSystemConfigurationDrawer() {
  openDataDrawer("Системен контрол");
  renderDrawerLoading();
  try {
    const [configurationResponse, integrationsResponse, readinessResponse] =
      await Promise.all([
        fetch("/api/system/configuration", { cache: "no-store" }),
        fetch("/health/integrations", { cache: "no-store" }),
        fetch("/health/ready", { cache: "no-store" }),
      ]);
    if (!configurationResponse.ok || !integrationsResponse.ok) {
      throw new Error("Системната проверка временно не е достъпна.");
    }
    const configuration = await configurationResponse.json();
    const integrations = await integrationsResponse.json();
    const readiness = readinessResponse.ok
      ? await readinessResponse.json()
      : null;
    const groups = new Map();
    for (const item of configuration.environment || []) {
      if (!groups.has(item.area)) groups.set(item.area, []);
      groups.get(item.area).push(item);
    }
    const tools = Array.isArray(integrations.tools) ? integrations.tools : [];
    const workingTools = tools.filter(
      (tool) => tool.enabled && tool.executable && tool.configured,
    ).length;
    elements.dataDrawerBody.innerHTML = `
      <div class="permission-default system-summary">
        <strong>${readiness?.status === "ready" ? "Ядрото е готово" : "Ядрото изисква внимание"}</strong>
        <p>${workingTools} от ${tools.length} инструмента са конфигурирани и изпълними.</p>
        <p>${configuration.summary.configured} настройки са налични; ${configuration.summary.protectedFallback || 0} използват защитен заместител; ${configuration.summary.missingRequired} задължителни липсват.</p>
        <p>Production: ${configuration.production?.status === "ready" ? `готово · commit ${escapeHtml(configuration.production.commit)}` : "не е потвърдено"}.</p>
        <p>DigitalOcean самопроверка (API): ${configuration.digitalOcean.connected ? "работи" : "не е достъпна"}.</p>
        <small>Тук няма стойности на ключове, пароли или token-и.</small>
      </div>
      <section class="drawer-section">
        <h3>Променливи <span>${configuration.summary.total}</span></h3>
        ${[...groups.entries()]
          .map(([area, items]) => renderEnvironmentGroup(area, items))
          .join("")}
      </section>
      <button type="button" class="permission-info-btn" data-back-tools>Назад към инструментите</button>`;
  } catch (error) {
    renderDrawerError(error.message);
  }
}

function openDataDrawer(title) {
  elements.dataDrawerTitle.textContent = title;
  elements.dataDrawer.hidden = false;
  elements.drawerBackdrop.hidden = false;
  elements.sidebar.classList.remove("mobile-visible");
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
  elements.dataDrawerBody.innerHTML = `<div class="drawer-state drawer-error">${escapeHtml(message)}</div>`;
}

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = String(value ?? "");
  return div.innerHTML;
}

async function openMemoryDrawer() {
  openDataDrawer("Памет");
  renderDrawerLoading();
  try {
    const response = await fetch("/memory/profile", { cache: "no-store" });
    if (!response.ok) throw new Error("Паметта временно не е достъпна.");
    const data = await response.json();
    markMemoryOperational();
    state.memoryItems = Array.isArray(data.items) ? data.items : [];
    renderMemoryItems();
  } catch (error) {
    renderDrawerError(error.message);
  }
}

function renderMemoryItems() {
  const personal = state.memoryItems.filter(
    (item) => (item.scope || "personal") === "personal",
  );
  const project = state.memoryItems.filter((item) => item.scope === "project");
  const section = (title, items) => `
        <section class="drawer-section">
            <h3>${title} <span>${items.length}</span></h3>
            ${
              items.length
                ? items
                    .map(
                      (item) => `
                    <article class="memory-card">
                        <div>
                          ${item.readOnly ? '<span class="memory-badge">Текуща основа</span>' : ""}
                          <p>${escapeHtml(item.fact)}</p>
                        </div>
                        ${
                          item.readOnly
                            ? ""
                            : `<button type="button" data-memory-delete="${escapeHtml(item.id)}"
                              aria-label="Изтрий този спомен" title="Изтрий">
                              <i class="fa-regular fa-trash-can"></i>
                            </button>`
                        }
                    </article>`,
                    )
                    .join("")
                : '<div class="drawer-empty">Няма записани спомени.</div>'
            }
        </section>`;
  elements.dataDrawerBody.innerHTML =
    section("За теб", personal) + section("За проекта", project);
}

async function openPermissionsDrawer() {
  openDataDrawer("Разрешения");
  renderDrawerLoading();
  try {
    const [
      permissionsResponse,
      healthResponse,
      googleResponse,
      githubResponse,
    ] = await Promise.all([
      fetch("/permissions", { cache: "no-store" }),
      fetch("/health/integrations", { cache: "no-store" }),
      fetch("/api/google/status", { cache: "no-store" }).catch(() => null),
      fetch("/api/github/status", { cache: "no-store" }).catch(() => null),
    ]);
    if (!permissionsResponse.ok || !healthResponse.ok) {
      throw new Error("Разрешенията временно не са достъпни.");
    }
    const [data, healthData] = await Promise.all([
      permissionsResponse.json(),
      healthResponse.json(),
    ]);
    const googleData = googleResponse?.ok
      ? await googleResponse.json().catch(() => ({}))
      : {};
    const githubData = githubResponse?.ok
      ? await githubResponse.json().catch(() => ({}))
      : {};
    const toolMap = new Map(
      (healthData.tools || []).map((tool) => [tool.id, tool]),
    );
    const labels = {
      allow: "Разрешено",
      confirm: "Иска потвърждение",
      deny: "Забранено",
    };
    elements.dataDrawerBody.innerHTML = `
            <div class="permission-default">
                Зеленото е активно. Оранжевото също работи, но пита преди рисково действие.
                Несвързаните услуги имат отделен бутон за вход.
            </div>
            <section class="drawer-section permission-list">
                ${(data.permissions || [])
                  .map(
                    (item) => `
                    <article class="permission-card">
                        <div>
                            <strong>${escapeHtml(item.action)}</strong>
                            <p>${escapeHtml(item.reason)}</p>
                        </div>
                        <div class="permission-card-actions">
                          <span class="permission-badge ${escapeHtml(item.decision)}">
                              ${labels[item.decision] || escapeHtml(item.decision)}
                          </span>
                          ${permissionAction(
                            item,
                            toolMap,
                            Boolean(googleData.connected),
                            Boolean(githubData.connected),
                          )}
                        </div>
                    </article>`,
                  )
                  .join("")}
            </section>`;
  } catch (error) {
    renderDrawerError(error.message);
  }
}

function showGitHubSetup() {
  openDataDrawer("GitHub статус");
  elements.dataDrawerBody.innerHTML = `
    <section class="setup-guide">
      <div class="permission-default">
        GitHub Read работи. GitHub Write е изключен в текущия режим без Copilot.
      </div>
      <article class="setup-step">
        <span><i class="fa-solid fa-check"></i></span>
        <div>
          <strong>Четенето е активно</strong>
          <p>AI CORE може да проверява разрешеното хранилище, commit-и и Pull Request-и.</p>
        </div>
      </article>
      <article class="setup-step">
        <span><i class="fa-solid fa-lock"></i></span>
        <div>
          <strong>Писането е изключено</strong>
          <p>От този екран не се създават branch, commit или Pull Request.</p>
        </div>
      </article>
      <div class="setup-note">
        Не са нужни нов GitHub App, App ID, Installation ID, private key, token или production secret.
      </div>
      <button type="button" class="permission-info-btn" data-back-tools>Назад към инструментите</button>
    </section>`;
}

function showPermissionInfo(action) {
  const messages = {
    "calendar.write":
      "Записът в Google Calendar е активен след свързване на Google. AI CORE първо показва точните данни и записва събитието само след еднократно потвърждение.",
    "memory.write":
      "Записът в паметта е активен. Преди постоянен запис AI CORE трябва да покаже точния текст и да поиска твоето потвърждение.",
    "memory.delete":
      "Изтриването е активно, но се изпълнява само след точно потвърждение за конкретния спомен.",
    "external.send":
      "Това е защитно правило за бъдещи имейли и публикации. Външно изпращане още не е свързано.",
    payment:
      "Това е защитно правило за бъдещи плащания и резервации. Платежен инструмент още не е свързан.",
  };
  openDataDrawer(action);
  elements.dataDrawerBody.innerHTML = `
    <section class="setup-guide">
      <div class="permission-default">${escapeHtml(
        messages[action] ||
          "Това действие се изпълнява само след твое потвърждение.",
      )}</div>
      <button type="button" class="permission-info-btn" data-back-permissions>Назад към разрешенията</button>
    </section>`;
}

async function handleDataDrawerAction(event) {
  if (event.target.closest("[data-system-configuration]")) {
    await openSystemConfigurationDrawer();
    return;
  }
  const connectionButton = event.target.closest("[data-connect-service]");
  if (connectionButton) {
    if (connectionButton.dataset.connectService === "google") {
      window.location.href = "/api/google/connect";
    } else if (connectionButton.dataset.connectService === "github") {
      window.location.href = "/api/github/connect";
    }
    return;
  }

  if (event.target.closest("[data-github-setup]")) {
    showGitHubSetup();
    return;
  }

  if (event.target.closest("[data-back-tools]")) {
    await openToolsDrawer();
    return;
  }

  if (event.target.closest("[data-back-permissions]")) {
    await openPermissionsDrawer();
    return;
  }

  const permissionInfo = event.target.closest("[data-permission-info]");
  if (permissionInfo) {
    showPermissionInfo(permissionInfo.dataset.permissionInfo);
    return;
  }

  const button = event.target.closest("button[data-memory-delete]");
  if (!button) return;
  const item = state.memoryItems.find(
    (candidate) => candidate.id === button.dataset.memoryDelete,
  );
  if (!item) return;

  button.disabled = true;
  try {
    const preparedResponse = await fetch(
      "/memory/profile/" + encodeURIComponent(item.id),
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: state.sessionId }),
      },
    );
    const prepared = await preparedResponse.json().catch(() => null);
    if (
      preparedResponse.status !== 409 ||
      prepared?.code !== "MEMORY_DELETE_CONFIRMATION_REQUIRED" ||
      !prepared?.confirmationId
    ) {
      throw new Error(prepared?.error || "Споменът не можа да бъде подготвен.");
    }

    const confirmed = window.confirm(
      `Да изтрия ли този спомен?\n\n${item.fact}`,
    );
    if (!confirmed) {
      button.disabled = false;
      return;
    }

    const response = await fetch(
      "/memory/profile/" + encodeURIComponent(item.id),
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: state.sessionId,
          confirmationId: prepared.confirmationId,
        }),
      },
    );
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      throw new Error(data?.error || "Споменът не можа да бъде изтрит.");
    }
    state.memoryItems = state.memoryItems.filter(
      (candidate) => candidate.id !== item.id,
    );
    renderMemoryItems();
    logAction("Изтрит е потвърден спомен");
  } catch (error) {
    renderDrawerError(error.message);
  }
}

function showTypingIndicator() {
  const div = document.createElement("div");
  div.className = "message typing";
  div.id = "typingIndicator";
  div.innerHTML = `
        <span class="thinking-avatar" aria-hidden="true">
            <i class="fa-solid fa-atom"></i>
        </span>
        <span class="thinking-label">Приемам задачата…</span>
        <span class="thinking-dots" aria-hidden="true">
            <span></span><span></span><span></span>
        </span>
    `;
  elements.chatMessages.appendChild(div);
  scrollChatToBottom();
}

function updateTaskIndicator(task) {
  const indicator = document.getElementById("typingIndicator");
  const label = indicator?.querySelector(".thinking-label");
  if (!indicator || !label || typeof task?.message !== "string") return;
  label.textContent = task.message;
  indicator.dataset.taskStatus = task.status || "executing";
  scrollChatToBottom();
}

function removeTypingIndicator() {
  document.getElementById("typingIndicator")?.remove();
}

function setChatBusy(isBusy) {
  state.chatBusy = isBusy;
  elements.sendBtn.disabled = isBusy;
  elements.chatInput.disabled = isBusy;
  elements.newChatBtn.disabled = isBusy;
  elements.attachBtn.disabled = isBusy;
  elements.voiceBtn.disabled = isBusy;
  globalThis.SynchronWorkMode?.setBusy(isBusy);
}

function renderAgentText(element, text) {
  const value = String(text ?? "");
  if (globalThis.SynchronMarkdown?.renderSafeMarkdown) {
    globalThis.SynchronMarkdown.renderSafeMarkdown(element, value);
    return;
  }

  element.dataset.rawText = value;
  element.textContent = value;
}

function createAssistantTurn(text = "", showActions = true) {
  const turn = document.createElement("div");
  turn.className = "assistant-turn";

  const message = document.createElement("div");
  message.className = "message agent";
  renderAgentText(message, text);

  const actions = document.createElement("div");
  actions.className = "message-actions";
  actions.hidden = !showActions;
  actions.innerHTML = `
        <button type="button" data-action="copy" title="Копирай" aria-label="Копирай">
            <i class="fa-regular fa-copy"></i>
            <span class="action-label">Копирай</span>
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

function showConversationPersistenceWarning(message) {
  const turn = message?.closest(".assistant-turn");
  if (!turn || turn.querySelector(".conversation-persistence-warning")) return;

  const warning = document.createElement("div");
  warning.className = "conversation-persistence-warning";
  warning.setAttribute("role", "status");
  warning.textContent =
    "Отговорът е получен, но разговорът не е запазен. Копирай важната информация преди да затвориш чата.";

  const actions = turn.querySelector(".message-actions");
  turn.insertBefore(warning, actions || null);
}

async function handleMessageAction(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;

  const turn = button.closest(".assistant-turn, .user-turn");
  const message = turn?.querySelector(".message.agent, .message.user");
  const text = message?.dataset.rawText || message?.innerText || "";
  if (!text) return;

  const action = button.dataset.action;

  if (action === "copy") {
    await copyText(text);
    const icon = button.querySelector("i");
    icon.className = "fa-solid fa-check";
    button.classList.add("active");
    setTimeout(() => {
      icon.className = "fa-regular fa-copy";
      button.classList.remove("active");
    }, 1400);
    return;
  }

  if (action === "speak") {
    speakText(text, button);
    return;
  }

  if (action === "like" || action === "dislike") {
    const otherAction = action === "like" ? "dislike" : "like";
    const otherButton = turn.querySelector(
      `button[data-action="${otherAction}"]`,
    );
    otherButton?.classList.remove("active");
    button.classList.toggle("active");
  }
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function speakText(text, button) {
  if (!("speechSynthesis" in window)) return;

  if (state.speakingButton === button && window.speechSynthesis.speaking) {
    window.speechSynthesis.cancel();
    button.classList.remove("active");
    state.speakingButton = null;
    return;
  }

  window.speechSynthesis.cancel();
  state.speakingButton?.classList.remove("active");

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "bg-BG";
  utterance.rate = 1;
  button.classList.add("active");
  state.speakingButton = button;

  const finish = () => {
    button.classList.remove("active");
    if (state.speakingButton === button) state.speakingButton = null;
  };

  utterance.onend = finish;
  utterance.onerror = finish;
  window.speechSynthesis.speak(utterance);
}

function parseSseEvent(rawEvent) {
  const lines = rawEvent.split("\n");
  let eventName = "message";
  const dataLines = [];

  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (dataLines.length === 0) return null;

  try {
    return {
      event: eventName,
      data: JSON.parse(dataLines.join("\n")),
    };
  } catch {
    throw new Error("Получен е повреден поток от сървъра.");
  }
}

async function sendMessage() {
  const text = elements.chatInput.value.trim();
  const image = state.pendingImage;
  if ((!text && !image) || state.chatBusy) return;

  const messageText = text || "Какво виждаш на тази снимка?";
  appendMessage("user", messageText, image);
  elements.chatInput.value = "";
  clearPendingImage();
  logAction("Изпратено съобщение");
  showTypingIndicator();
  setChatBusy(true);

  let responseBubble = null;
  let responseActions = null;

  try {
    const response = await fetch("/chat/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: state.sessionId,
        message: messageText,
        image,
        ...globalThis.SynchronWorkMode?.getRequestPayload(),
      }),
    });

    if (!response.ok) {
      const contentType = response.headers.get("content-type") || "";
      let errorMessage = `HTTP ${response.status}`;

      if (contentType.includes("application/json")) {
        const data = await response.json().catch(() => null);
        if (data?.error) errorMessage = data.error;
      }

      throw new Error(errorMessage);
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/event-stream")) {
      throw new Error("Сървърът върна неочакван формат.");
    }

    const assistantTurn = createAssistantTurn("", false);
    responseBubble = assistantTurn.message;
    responseActions = assistantTurn.actions;

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let streamBuffer = "";
    let fullText = "";
    let completed = false;

    const processEvents = () => {
      streamBuffer = streamBuffer.replace(/\r\n/g, "\n");
      const events = streamBuffer.split("\n\n");
      streamBuffer = events.pop() || "";

      for (const rawEvent of events) {
        const parsed = parseSseEvent(rawEvent);
        if (!parsed) continue;

        if (
          parsed.event === "token" &&
          typeof parsed.data?.token === "string"
        ) {
          removeTypingIndicator();
          fullText += parsed.data.token;
          renderAgentText(responseBubble, fullText);
        } else if (parsed.event === "error") {
          throw new Error(parsed.data?.message || "AI агентът върна грешка.");
        } else if (
          parsed.event === "activity" &&
          typeof parsed.data?.message === "string"
        ) {
          logAction(parsed.data.message);
        } else if (
          parsed.event === "task" &&
          typeof parsed.data?.message === "string"
        ) {
          updateTaskIndicator(parsed.data);
          globalThis.SynchronWorkMode?.onTask(parsed.data);
          logAction(parsed.data.message);
        } else if (parsed.event === "done") {
          completed = true;
          globalThis.SynchronWorkMode?.onDone(parsed.data);
          if (
            parsed.data?.conversationPersisted === false &&
            parsed.data?.warningCode === "CONVERSATION_NOT_SAVED"
          ) {
            showConversationPersistenceWarning(responseBubble);
            logAction("Разговорът не е запазен");
          }
          if (parsed.data?.task?.status === "completed") {
            logAction(
              parsed.data.task.verified
                ? "Задачата е изпълнена и проверена"
                : "Задачата е изпълнена",
            );
          } else if (parsed.data?.task?.status === "waiting_confirmation") {
            logAction("Задачата чака потвърждение");
          } else if (parsed.data?.task?.status === "partial") {
            logAction("Задачата е изпълнена частично");
          }
          if (typeof parsed.data?.tool === "string") {
            logAction("Използван инструмент: " + parsed.data.tool);
          }
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
      streamBuffer += "\n\n";
      processEvents();
    }

    if (!completed || !fullText.trim()) {
      throw new Error("AI отговорът приключи неочаквано.");
    }

    responseActions.hidden = false;
    logAction("Получен AI отговор");
    await loadConversations();
  } catch (error) {
    console.error(error);
    globalThis.SynchronWorkMode?.onError();
    const message = `❌ ${error?.message || "Сървърна грешка. Опитай отново."}`;

    if (responseBubble) {
      responseBubble.textContent = message;
      responseBubble.dataset.rawText = message;
      if (responseActions) responseActions.hidden = true;
    } else {
      appendMessage("agent", message);
    }
    logAction("Грешка при AI отговор");
  } finally {
    removeTypingIndicator();
    setChatBusy(false);
    elements.chatInput.focus();
    scrollChatToBottom();
  }
}

function appendMessage(role, text, image = null) {
  if (role === "agent") {
    const assistantTurn = createAssistantTurn(text, true);
    scrollChatToBottom();
    return assistantTurn.message;
  }

  const turn = document.createElement("div");
  turn.className = "user-turn";

  const div = document.createElement("div");
  div.className = `message ${role}`;
  div.dataset.rawText = text;
  if (image?.dataUrl) {
    const preview = document.createElement("img");
    preview.className = "message-image";
    preview.src = image.dataUrl;
    preview.alt = image.name || "Изпратена снимка";
    div.appendChild(preview);
  }

  const textNode = document.createElement("div");
  textNode.textContent = text;
  div.appendChild(textNode);

  const actions = document.createElement("div");
  actions.className = "message-actions user-actions";
  actions.innerHTML = `
        <button type="button" data-action="copy" title="Копирай" aria-label="Копирай">
            <i class="fa-regular fa-copy"></i>
            <span class="action-label">Копирай</span>
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
    const response = await fetch("/health", { cache: "no-store" });
    setServerStatus(response.ok);
  } catch {
    setServerStatus(false);
  }
}

async function checkOpenSearch() {
  try {
    const response = await fetch("/health/ready", { cache: "no-store" });
    const data = await response.json();
    const memory = data?.checks?.memory;

    if (memory?.ready) {
      state.opensearchFailures = 0;
      updateOpenSearchUI(memory.status || "operational");
      return;
    }

    handleOpenSearchProbeFailure(memory?.status || "unavailable");
  } catch {
    handleOpenSearchProbeFailure("unreachable");
  }
}

function markMemoryOperational() {
  state.lastMemorySuccessAt = Date.now();
  state.opensearchFailures = 0;
  updateOpenSearchUI("operational");
}

function handleOpenSearchProbeFailure(status) {
  const memoryWorkedRecently = Date.now() - state.lastMemorySuccessAt < 60_000;

  if (memoryWorkedRecently) {
    updateOpenSearchUI("operational");
    return;
  }

  state.opensearchFailures += 1;
  updateOpenSearchUI(state.opensearchFailures >= 3 ? status : "checking");
}

function setServerStatus(isOnline) {
  state.serverOnline = isOnline;
  elements.agentStatusDot.className = isOnline ? "online" : "offline";
  elements.agentStatusText.textContent = isOnline
    ? "Сървър онлайн"
    : "Сървър офлайн";
  elements.serverStatusDisplay.textContent = isOnline ? "Онлайн" : "Офлайн";
  elements.serverStatusDisplay.className = `context-value ${isOnline ? "status-green" : "status-red"}`;
}

function updateOpenSearchUI(status) {
  state.opensearchStatus = status;
  elements.opensearchStatusDisplay.className = "context-value";

  if (status === "green" || status === "operational") {
    elements.opensearchStatusDisplay.textContent = "Свързан · работи";
    elements.opensearchStatusDisplay.classList.add("status-green");
  } else if (status === "yellow") {
    elements.opensearchStatusDisplay.textContent = "Работи · ограничен резерв";
    elements.opensearchStatusDisplay.classList.add("status-yellow");
  } else if (
    status === "red" ||
    status === "error" ||
    status === "unreachable" ||
    status === "unavailable"
  ) {
    elements.opensearchStatusDisplay.textContent =
      status === "red" ? "Проблем в паметта" : "Временно недостъпен";
    elements.opensearchStatusDisplay.classList.add("status-red");
  } else if (status === "not-configured") {
    elements.opensearchStatusDisplay.textContent = "Не е настроен";
    elements.opensearchStatusDisplay.classList.add("status-red");
  } else {
    elements.opensearchStatusDisplay.textContent = "Проверка…";
    elements.opensearchStatusDisplay.classList.add("status-yellow");
  }
}

function logAction(actionName) {
  const time = new Date().toLocaleTimeString("bg-BG", {
    hour: "2-digit",
    minute: "2-digit",
  });
  state.lastActions.unshift(`[${time}] ${actionName}`);
  if (state.lastActions.length > 5) state.lastActions.pop();
  renderActionsLog();
}

function renderActionsLog() {
  elements.actionsLog.replaceChildren();

  if (state.lastActions.length === 0) {
    const item = document.createElement("li");
    item.textContent = "Няма скорошни действия";
    elements.actionsLog.appendChild(item);
    return;
  }

  for (const action of state.lastActions) {
    const item = document.createElement("li");
    item.textContent = action;
    elements.actionsLog.appendChild(item);
  }
}

window.addEventListener("load", init);
