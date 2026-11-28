const chatLocale = globalThis.NovariumLocale;
const chatText = (value, values) => chatLocale?.text(value, values) ?? value;
const englishAuthErrors = {
  AUTH_INVALID_EMAIL: "Enter a valid email address.",
  AUTH_INVALID_NAME: "Enter a valid name.",
  AUTH_INVALID_PASSWORD: "Enter a password between 8 and 128 characters.",
  AUTH_INVALID_CREDENTIALS: "The email address or password is incorrect.",
  AUTH_INVITE_INVALID: "Enter a valid early access code.",
  AUTH_REGISTRATION_CLOSED: "Registration is currently closed.",
  AUTH_REGISTRATION_INCOMPLETE: "Account access is not active. Continue with Google using the same email address.",
  AUTH_PASSWORD_SIGNUP_REMOVED: "New accounts are no longer created with an email and password. Select Continue with Google; your account is created on first sign-in.",
  AUTH_EMAIL_NOT_VERIFIED: "Open the link in your verification email and select Complete verification. Then sign in.",
  AUTH_EMAIL_VERIFICATION_RESENT: "We sent a new verification email. Open the latest message, follow its link and select Complete verification. Check your spam folder if needed.",
  AUTH_UNAVAILABLE: "Sign-in is temporarily unavailable. Try again shortly.",
  AUTH_SIGNUP_REJECTED: "The account could not be created. If you already have an account, sign in.",
};

const state = {
  sessionId: getOrCreateSessionId(),
  serverOnline: false,
  lastActions: [],
  chatBusy: false,
  talkMode: false,
  talkEmpty: 0,
  councilMode: false,
  speakingButton: null,
  pendingImage: null,
  conversations: [],
  conversationLoadError: "",
  recentConversationMessages: [],
  memoryItems: [],
  knowledgeItems: [],
  knowledgePreview: [],
  knowledgeImportConfirmation: null,
  memoryWorkspace: null,
  recognition: null,
  listening: false,
  authenticatedUser: null,
  applicationStarted: false,
};

const MAX_CHAT_INPUT_HEIGHT = 160;
let statusReturnFocus = null;

const elements = {
  authGate: document.getElementById("authGate"),
  authCard: document.getElementById("authCard"),
  appShell: document.getElementById("appShell"),
  loginForm: document.getElementById("loginForm"),
  loginEmail: document.getElementById("loginEmail"),
  loginPassword: document.getElementById("loginPassword"),
  loginBtn: document.getElementById("loginBtn"),
  passwordSignIn: document.getElementById("passwordSignIn"),
  authMessage: document.getElementById("authMessage"),
  forgotPasswordBtn: document.getElementById("forgotPasswordBtn"),
  chatMessages: document.getElementById("chatMessages"),
  chatInput: document.getElementById("chatInput"),
  sendBtn: document.getElementById("sendBtn"),
  councilModeBtn: document.getElementById("councilModeBtn"),
  councilProviderPicker: document.getElementById("councilProviderPicker"),
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
  myDataBtn: document.getElementById("myDataBtn"),
  sidebarLogoutBtn: document.getElementById("sidebarLogoutBtn"),
  closeContextBtn: document.getElementById("closeContextBtn"),
  statusPanel: document.getElementById("statusPanel"),
  agentStatusDot: document.getElementById("agentStatusDot"),
  agentStatusText: document.getElementById("agentStatusText"),
  sessionIdDisplay: document.getElementById("sessionIdDisplay"),
  serverStatusDisplay: document.getElementById("serverStatusDisplay"),
  activeIntegrationsDisplay: document.getElementById(
    "activeIntegrationsDisplay",
  ),
  taskRunList: document.getElementById("taskRunList"),
  actionsLog: document.getElementById("actionsLog"),
  conversationList: document.getElementById("conversationList"),
  conversationSearch: document.getElementById("conversationSearch"),
  searchChatsBtn: document.getElementById("searchChatsBtn"),
  mobileMenuBtn: document.getElementById("mobileMenuBtn"),
  sidebar: document.getElementById("sidebar"),
  sidebarBackdrop: document.getElementById("sidebarBackdrop"),
  imagesBtn: document.getElementById("imagesBtn"),
  systemConfigurationBtn: document.getElementById("systemConfigurationBtn"),
  focusBtn: document.getElementById("focusBtn"),
  toolsBtn: document.getElementById("toolsBtn"),
  memoryBtn: document.getElementById("memoryBtn"),
  connectionsBtn: document.getElementById("connectionsBtn"),
  inboxBtn: document.getElementById("inboxBtn"),
  inboxCount: document.getElementById("inboxCount"),
  permissionsBtn: document.getElementById("permissionsBtn"),
  dataDrawer: document.getElementById("dataDrawer"),
  dataDrawerTitle: document.getElementById("dataDrawerTitle"),
  dataDrawerBody: document.getElementById("dataDrawerBody"),
  drawerBackdrop: document.getElementById("drawerBackdrop"),
  closeDataDrawerBtn: document.getElementById("closeDataDrawerBtn"),
  voiceBtn: document.getElementById("voiceBtn"),
  talkBtn: document.getElementById("talkBtn"),
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
  const stored = readLocalStorage("synchronSessionId");
  if (stored?.startsWith("sess-")) return stored;
  const sessionId = createSessionId();
  writeLocalStorage("synchronSessionId", sessionId);
  return sessionId;
}

function readLocalStorage(key) {
  try {
    return globalThis.localStorage?.getItem(key) || null;
  } catch {
    return null;
  }
}

function writeLocalStorage(key, value) {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // The app remains usable when storage is blocked by the browser.
  }
}

function setAuthMessage(message = "", success = false) {
  elements.authMessage.textContent = message;
  elements.authMessage.classList.toggle("success", success);
}

function setCouncilMode(enabled) {
  state.councilMode = Boolean(enabled);
  if (elements.councilProviderPicker) {
    elements.councilProviderPicker.hidden = !state.councilMode;
  }
  if (!elements.councilModeBtn) return;
  elements.councilModeBtn.setAttribute(
    "aria-pressed",
    String(state.councilMode),
  );
  elements.councilModeBtn.title = state.councilMode
    ? chatText("Следващото съобщение ще бъде изпратено до избраните AI двигатели")
    : chatText("Попитай избраните AI двигатели и сравни отговорите");
}

function setAuthBusy(isBusy) {
  elements.loginBtn.disabled = isBusy;
  elements.authCard?.setAttribute("aria-busy", String(isBusy));
  elements.loginBtn.textContent = isBusy ? chatText("Влизане…") : chatText("Влез");
}

async function readAuthSession() {
  const response = await fetch("/api/auth/session", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(chatText("Входът временно не е достъпен."));
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
    const error = new Error(
      chatLocale && chatLocale.language !== "bg"
        ? (Object.hasOwn(englishAuthErrors, data?.code)
            ? englishAuthErrors[data.code]
            : `Sign-in failed (HTTP ${response.status}).`)
        : data?.error || `Входът не беше успешен (HTTP ${response.status}).`,
    );
    error.code = data?.code || "AUTH_REQUEST_FAILED";
    error.status = response.status;
    throw error;
  }
  if (!data) {
    throw new Error(chatText("Невалиден отговор от услугата (HTTP {status}).", { status: response.status }));
  }
  return data;
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
    if (!session.authenticated) throw new Error(chatText("Сесията не беше създадена."));
    await startApplication(session.user);
  } catch (error) {
    // Identity Platform answers the same for "no account" and "wrong
    // password". New profiles are made with Google, so point there.
    setAuthMessage(
      error.code === "AUTH_INVALID_CREDENTIALS"
        ? chatText("Имейлът или паролата не съвпадат. Нямаш профил? Натисни „Продължи с Google“ — профилът се създава сам.")
        : error.message,
    );
  } finally {
    setAuthBusy(false);
  }
}

const GOOGLE_SIGN_IN_ERRORS = Object.freeze({
  AUTH_GOOGLE_CANCELLED: "Входът с Google беше отказан.",
  AUTH_GOOGLE_STATE_INVALID: "Входът с Google изтече. Опитай пак.",
  AUTH_GOOGLE_DISABLED: "Входът с Google още не е включен.",
  AUTH_GOOGLE_PROVIDER_DISABLED: "Входът с Google още не е включен.",
  AUTH_GOOGLE_PASSWORD_ACCOUNT: "Този имейл вече има профил с парола. Влез с паролата си от „Имаш профил с имейл и парола?“.",
  AUTH_GITHUB_CANCELLED: "Входът с GitHub беше отказан.",
  AUTH_GITHUB_STATE_INVALID: "Входът с GitHub изтече. Опитай пак.",
  AUTH_GITHUB_DISABLED: "Входът с GitHub още не е включен.",
  AUTH_GITHUB_PROVIDER_DISABLED: "Входът с GitHub още не е включен.",
  AUTH_GITHUB_EXISTING_ACCOUNT: "Имейлът от GitHub вече има профил. Влез с „Продължи с Google“ или с паролата си.",
  AUTH_FACEBOOK_EXISTING_ACCOUNT: "Имейлът от Facebook вече има профил. Влез с „Продължи с Google“ или с паролата си.",
  AUTH_MICROSOFT_EXISTING_ACCOUNT: "Имейлът от Microsoft вече има профил. Влез с „Продължи с Google“ или с паролата си.",
});

function showGoogleSignInError() {
  const params = new URLSearchParams(globalThis.location?.search || "");
  const code = params.get("auth_error");
  if (!code) return;
  setAuthMessage(
    chatText(
      GOOGLE_SIGN_IN_ERRORS[code] ||
        (code.startsWith("AUTH_GITHUB")
          ? "Входът с GitHub не успя. Опитай пак."
          : code.startsWith("AUTH_FACEBOOK")
            ? "Входът с Facebook не успя. Опитай пак."
            : code.startsWith("AUTH_MICROSOFT")
              ? "Входът с Microsoft не успя. Опитай пак."
              : "Входът с Google не успя. Опитай пак."),
    ),
  );
  if (code === "AUTH_GOOGLE_PASSWORD_ACCOUNT" && elements.passwordSignIn) {
    elements.passwordSignIn.open = true;
  }
  params.delete("auth_error");
  const rest = params.toString();
  globalThis.history?.replaceState?.({}, "", `${globalThis.location.pathname}${rest ? `?${rest}` : ""}`);
}

async function handleForgotPassword() {
  const email = elements.loginEmail.value.trim();
  if (!email) {
    setAuthMessage(chatText("Въведи имейла си в полето отгоре и натисни отново."));
    elements.loginEmail.focus();
    return;
  }
  setAuthBusy(true);
  setAuthMessage();
  try {
    await submitAuth("/api/auth/password-reset", { email });
    setAuthMessage(
      chatText("Ако има профил с този имейл, изпратихме писмо с линк за нова парола (от noreply, провери и „Спам“/„Промоции“). Ако писмо не дойде до 5 минути, най-вероятно още нямаш профил — натисни „Продължи с Google“."),
      true,
    );
  } catch (error) {
    setAuthMessage(error.message);
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
  const displayName = user?.displayName || chatText("Потребител");
  const isOwner = user?.role === "owner";
  elements.profileName.textContent = displayName;
  elements.profileAvatar.textContent =
    displayName.trim().charAt(0).toLocaleUpperCase("bg-BG") || "П";
  elements.profileRole.textContent = isOwner
    ? chatText("Собственик · настройки")
    : chatText("Личен профил");
  document.body.dataset.userRole = isOwner ? "owner" : "member";
  for (const item of document.querySelectorAll("[data-owner-only]")) {
    item.hidden = !isOwner;
  }
  for (const item of document.querySelectorAll("[data-member-only]")) {
    item.hidden = isOwner;
  }
}

async function init() {
  elements.loginForm.addEventListener("submit", handleLogin);
  elements.forgotPasswordBtn?.addEventListener("click", handleForgotPassword);

  try {
    const session = await readAuthSession();
    const googleSignInBtn = document.getElementById("googleSignInBtn");
    if (googleSignInBtn) googleSignInBtn.hidden = session.googleSignIn !== true;
    const githubSignInBtn = document.getElementById("githubSignInBtn");
    if (githubSignInBtn) githubSignInBtn.hidden = session.githubSignIn !== true;
    for (const button of document.querySelectorAll("a[data-provider]")) {
      button.hidden = session.providerSignIn?.[button.dataset.provider] !== true;
    }
    // Without Google the password form is the only way in, so keep it open.
    if (
      elements.passwordSignIn &&
      session.googleSignIn !== true &&
      session.githubSignIn !== true &&
      !Object.values(session.providerSignIn || {}).some(Boolean)
    ) {
      elements.passwordSignIn.open = true;
    }
    showGoogleSignInError();
    if (session.authenticated) {
      await startApplication(session.user);
      return;
    }
    elements.authGate.hidden = false;
    elements.appShell.hidden = true;
    if (!session.configured) {
      setAuthMessage(
        chatText("Входът с потребителски профили още не е активиран. Собственикът може да влезе с GitHub."),
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
  globalThis.SynchronWorkMode?.init(user, {
    getActiveId: () => state.sessionId,
    list: () => state.conversations,
    open: (id) => openConversation(id, { withinProject: true }),
    create: () => startNewChat({ withinProject: true }),
    closeDrawer: closeDataDrawer,
  });
  elements.authGate.hidden = true;
  elements.appShell.hidden = false;
  // Parts that loaded before sign-in (e.g. the assistants row) reload now,
  // so signing in with a password needs no page refresh.
  document.dispatchEvent(new CustomEvent("novarium:signed-in"));
  if (user?.role === "owner") {
    globalThis.SynchronCodeWorkspace?.afterSignIn();
    globalThis.SynchronAiSpend?.start();
  }
  updateSessionDisplay();

  elements.sendBtn.addEventListener("click", () => {
    if (state.chatBusy) stopGeneration();
    else sendMessage();
  });
  elements.councilModeBtn?.addEventListener("click", () => {
    setCouncilMode(!state.councilMode);
  });
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
  elements.chatInput.addEventListener("input", resizeChatInput);
  elements.newChatBtn.addEventListener("click", startNewChat);
  elements.toggleStatusBtn.addEventListener("click", toggleProfileActions);
  elements.profileStatusBtn.addEventListener("click", openStatus);
  elements.myDataBtn?.addEventListener("click", openMyDataDrawer);
  elements.sidebarLogoutBtn.addEventListener("click", handleLogout);
  elements.closeContextBtn.addEventListener("click", closeStatus);
  elements.chatMessages.addEventListener("click", handleMessageAction);
  elements.conversationList.addEventListener("click", handleConversationClick);
  elements.conversationSearch.addEventListener("input", renderConversationList);
  elements.searchChatsBtn.addEventListener("click", toggleConversationSearch);
  elements.mobileMenuBtn.addEventListener("click", toggleSidebar);
  elements.sidebarBackdrop.addEventListener("click", closeSidebar);
  elements.imagesBtn.addEventListener("click", openImagePicker);
  elements.toolsBtn.addEventListener("click", openToolsDrawer);
  document.getElementById("activityBtn")?.addEventListener("click", openActivityDrawer);
  // Projects and Код live in the menu, so the phone header keeps one row.
  for (const [menuId, targetId] of [
    ["projectsMenuBtn", "workContextBtn"],
    ["codeMenuBtn", "codeWorkspaceBtn"],
  ]) {
    document.getElementById(menuId)?.addEventListener("click", () => {
      closeSidebar();
      document.getElementById(targetId)?.click();
    });
  }
  elements.systemConfigurationBtn.addEventListener(
    "click",
    openSystemConfigurationDrawer,
  );
  elements.memoryBtn.addEventListener("click", openMemoryDrawer);
  elements.connectionsBtn?.addEventListener("click", openConnectionsDrawer);
  elements.inboxBtn?.addEventListener("click", openInboxDrawer);
  refreshInboxCount();
  elements.permissionsBtn.addEventListener("click", openPermissionsDrawer);
  elements.closeDataDrawerBtn.addEventListener("click", closeDataDrawer);
  elements.drawerBackdrop.addEventListener("click", closeDataDrawer);
  elements.dataDrawerBody.addEventListener("click", handleDataDrawerAction);
  elements.taskRunList?.addEventListener("click", handleTaskRunAction);
  elements.voiceBtn.addEventListener("click", toggleVoiceInput);
  elements.talkBtn?.addEventListener("click", toggleTalkMode);
  elements.logoutBtn.addEventListener("click", handleLogout);
  document.addEventListener("keydown", handleGlobalKeydown);
  prepareVoiceInput();

  checkHealth();
  void loadTaskRuns();
  setInterval(checkHealth, 10000);
  resizeChatInput();

  await restoreConversation();
  await loadConversations();
}

function updateSessionDisplay() {
  elements.sessionIdDisplay.textContent = state.sessionId;
}

async function showWelcomeMessage() {
  const welcome = appendMessage(
    "agent",
    `## ${chatText("С какво започваме?")}`,
    null,
    { remember: false },
  );
  welcome.closest(".assistant-turn")?.classList.add("welcome-turn");
}

async function restoreConversation() {
  const sessionId = state.sessionId;
  state.recentConversationMessages = [];
  try {
    const response = await fetch(
      "/memory/conversation/" + encodeURIComponent(sessionId),
      { cache: "no-store" },
    );
    if (!response.ok) throw new Error(chatText("Историята не е достъпна."));
    const data = await response.json();
    if (state.sessionId !== sessionId) return;
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
        // The page shows its own Next label, but the history sent back keeps
        // the stored text: the server matches it against the saved turns and
        // strips their "Следва:" lines.
        appendMessage(
          item.role === "assistant" ? "agent" : "user",
          item.role === "assistant" ? localizedNextLines(item.content) : item.content,
          null,
          { remember: false },
        );
        rememberConversationMessage(item.role, item.content);
      }
    }
    logAction("Възстановена е историята на разговора");
  } catch (error) {
    if (state.sessionId !== sessionId) return;
    console.error(error);
    await showWelcomeMessage();
    logAction("Историята не можа да бъде възстановена");
  }
}

async function startNewChat({ withinProject = false } = {}) {
  stopTalkMode();
  if (state.chatBusy) return;
  // Queued pictures and clips belong to the conversation on screen; they
  // never start in the new one (review r2).
  cancelQueuedMedia();
  closeSidebar();
  clearPendingImage();
  const sessionId = createSessionId();
  state.sessionId = sessionId;
  if (!withinProject)
    globalThis.SynchronWorkMode?.selectConversation(sessionId);
  writeLocalStorage("synchronSessionId", state.sessionId);
  state.lastActions = [];
  state.recentConversationMessages = [];
  elements.chatMessages.replaceChildren();
  updateSessionDisplay();
  renderActionsLog();
  await showWelcomeMessage();
  logAction("Започнат е нов разговор");
  renderConversationList();
  elements.chatInput.focus();
  return sessionId;
}

async function loadConversations() {
  try {
    const response = await fetch("/memory/conversations", {
      cache: "no-store",
    });
    if (!response.ok) throw new Error(chatText("Списъкът не е достъпен."));
    const data = await response.json();
    state.conversations = Array.isArray(data.items) ? data.items : [];
    state.conversationLoadError = "";
    renderConversationList();
  } catch (error) {
    console.error(error);
    state.conversations = [];
    state.conversationLoadError =
      chatText("Историята временно не е достъпна. Опитай отново.");
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
      ? chatText("Няма намерени разговори.")
      : chatText("Все още няма запазени разговори.");
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
  if (button) await openConversation(button.dataset.sessionId);
}

async function openConversation(sessionId, { withinProject = false } = {}) {
  if (state.chatBusy || !sessionId || sessionId === state.sessionId) return;
  cancelQueuedMedia();
  state.sessionId = sessionId;
  if (!withinProject)
    globalThis.SynchronWorkMode?.selectConversation(sessionId);
  writeLocalStorage("synchronSessionId", sessionId);
  elements.chatMessages.replaceChildren();
  state.recentConversationMessages = [];
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

function resizeChatInput() {
  elements.chatInput.style.height = "auto";
  const naturalHeight = elements.chatInput.scrollHeight;
  const nextHeight = Math.min(naturalHeight, MAX_CHAT_INPUT_HEIGHT);
  elements.chatInput.style.height = `${nextHeight}px`;
  elements.chatInput.style.overflowY =
    naturalHeight > MAX_CHAT_INPUT_HEIGHT ? "auto" : "hidden";
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

  const allowedTypes = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
  if (!allowedTypes.includes(file.type)) {
    appendMessage("agent", chatText("❌ Поддържат се JPEG, PNG и WebP снимки и PDF документи."), null, { remember: false });
    clearPendingImage();
    return;
  }

  if (file.size > 5 * 1024 * 1024) {
    appendMessage("agent", chatText("❌ Файлът трябва да е до 5 MB."), null, { remember: false });
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
    // A PDF has no picture preview; the file name is enough.
    if (file.type === "application/pdf") {
      elements.attachmentImage.removeAttribute("src");
      elements.attachmentImage.hidden = true;
    } else {
      elements.attachmentImage.hidden = false;
      elements.attachmentImage.src = reader.result;
    }
    elements.attachmentName.textContent = file.type === "application/pdf" ? `📄 ${file.name}` : file.name;
    elements.attachmentPreview.hidden = false;
    elements.chatInput.focus();
  };
  reader.onerror = () => {
    appendMessage("agent", chatText("❌ Файлът не можа да бъде прочетен."), null, { remember: false });
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
  const activeElement = document.activeElement;
  statusReturnFocus =
    activeElement === elements.profileStatusBtn
      ? elements.toggleStatusBtn
      : activeElement &&
          activeElement !== document.body &&
          typeof activeElement.focus === "function"
        ? activeElement
        : elements.toggleStatusBtn;
  closeSidebar();
  elements.statusPanel.classList.add("mobile-visible");
  elements.statusPanel.setAttribute("aria-hidden", "false");
  void loadTaskRuns();
  elements.closeContextBtn.focus({ preventScroll: true });
}

function closeStatus() {
  const wasOpen = elements.statusPanel.classList.contains("mobile-visible");
  elements.statusPanel.classList.remove("mobile-visible");
  elements.statusPanel.setAttribute("aria-hidden", "true");
  if (!wasOpen) return;

  document.dispatchEvent(new CustomEvent("synchron:status-closed"));
  const returnTarget = statusReturnFocus;
  statusReturnFocus = null;
  if (returnTarget?.isConnected && typeof returnTarget.focus === "function") {
    returnTarget.focus({ preventScroll: true });
  }
}

// iPhone Safari and the home-screen app either lack speech recognition or
// do not support Bulgarian there; record the voice and let the server turn
// it into text instead.
function prefersServerVoice() {
  const ios =
    /iPad|iPhone|iPod/u.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  let remembered = false;
  try {
    remembered = localStorage.getItem("novariumServerVoice") === "1";
  } catch {
    // storage unavailable; decide from the device
  }
  return ios || remembered;
}

function canRecordVoice() {
  return Boolean(
    window.MediaRecorder && navigator.mediaDevices?.getUserMedia,
  );
}

function prepareVoiceInput() {
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;
  state.serverVoice =
    canRecordVoice() && (!SpeechRecognition || prefersServerVoice());
  if (state.serverVoice) return;
  if (!SpeechRecognition) {
    elements.voiceBtn.hidden = true;
    if (elements.talkBtn) elements.talkBtn.hidden = true;
    return;
  }

  const recognition = new SpeechRecognition();
  recognition.lang = chatLocale?.browserLocale || "bg-BG";
  recognition.continuous = false;
  recognition.interimResults = true;

  recognition.onstart = () => setListening(true);
  recognition.onend = () => {
    setListening(false);
    if (state.talkMode) talkAfterListening();
  };
  recognition.onerror = (event) => {
    setListening(false);
    if (event.error === "aborted" || event.error === "no-speech") return;
    stopTalkMode();
    // The browser cannot do it here; use the server from the next tap on.
    if (
      canRecordVoice() &&
      ["service-not-allowed", "network", "language-not-supported"].includes(event.error)
    ) {
      state.serverVoice = true;
      try {
        localStorage.setItem("novariumServerVoice", "1");
      } catch {
        // remembered for this visit only
      }
      appendMessage(
        "agent",
        chatText("Гласът на браузъра не работи тук. Натисни микрофона пак — ще записвам и ще разпознавам на сървъра."),
        null,
        { remember: false },
      );
      return;
    }
    const reasons = {
      "not-allowed": "Микрофонът е забранен за сайта. Разреши го: iPhone → Настройки → Safari → Микрофон, или от иконата „aA“ в адресната лента.",
      "service-not-allowed": "Разпознаването на говор е изключено. На iPhone включи Настройки → Siri и Диктовка. Можеш да ползваш и микрофона на клавиатурата.",
      network: "Разпознаването на говор има нужда от интернет. Провери връзката.",
      "audio-capture": "Не намирам микрофон. Провери дали друго приложение не го използва.",
    };
    appendMessage(
      "agent",
      chatText(reasons[event.error] || "Гласовото въвеждане не можа да стартира. Провери достъпа до микрофона."),
    );
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
    resizeChatInput();
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
    ? chatText("Спри слушането")
    : chatText("Гласово въвеждане");
}

const MAX_RECORDING_MS = 90_000;

function recordingMimeType() {
  for (const type of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"]) {
    if (window.MediaRecorder?.isTypeSupported?.(type)) return type;
  }
  return "";
}

async function startServerRecording() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (error) {
    appendMessage(
      "agent",
      chatText(
        error?.name === "NotAllowedError"
          ? "Микрофонът е забранен за сайта. Разреши го: iPhone → Настройки → Safari → Микрофон, или от иконата „aA“ в адресната лента."
          : "Не намирам микрофон. Провери дали друго приложение не го използва.",
      ),
      null,
      { remember: false },
    );
    return;
  }
  const mimeType = recordingMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks = [];
  recorder.ondataavailable = (event) => {
    if (event.data?.size) chunks.push(event.data);
  };
  recorder.onstop = async () => {
    clearTimeout(state.recordingTimer);
    stream.getTracks().forEach((track) => track.stop());
    state.recorder = null;
    setListening(false);
    state.silenceWatch?.();
    state.silenceWatch = null;
    const blob = new Blob(chunks, { type: (recorder.mimeType || mimeType || "audio/webm") });
    if (blob.size < 1000 || state.talkHeard === false) {
      if (state.talkMode) talkAfterListening();
      return;
    }
    await transcribeRecording(blob);
  };
  state.recorder = recorder;
  recorder.start();
  setListening(true);
  state.talkHeard = null;
  if (state.talkMode) state.silenceWatch = watchForSilence(stream, recorder);
  state.recordingTimer = setTimeout(() => {
    if (recorder.state === "recording") recorder.stop();
  }, MAX_RECORDING_MS);
}

async function transcribeRecording(blob) {
  const previousPlaceholder = elements.chatInput.placeholder;
  elements.chatInput.placeholder = chatText("Разпознаване…");
  elements.voiceBtn.disabled = true;
  try {
    const audio = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    const response = await fetch("/api/voice/transcribe", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        audio,
        mimeType: blob.type,
        language: chatLocale?.language || "bg",
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || chatText("Записът не можа да се разпознае."));
    const heard = String(data.text || "").trim();
    if (!heard) {
      logAction("Не чух говор в записа");
    } else {
      const current = elements.chatInput.value.trim();
      elements.chatInput.value = current ? `${current} ${heard}` : heard;
      resizeChatInput();
      elements.chatInput.focus();
    }
  } catch (error) {
    stopTalkMode();
    appendMessage("agent", `❌ ${error.message}`, null, { remember: false });
  } finally {
    elements.chatInput.placeholder = previousPlaceholder;
    elements.voiceBtn.disabled = state.chatBusy;
  }
  if (state.talkMode) talkAfterListening();
}

// Hands-free recording: stop by itself after a pause once the person has
// spoken, or after a while if nobody speaks at all.
function watchForSilence(stream, recorder) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  let context;
  try {
    context = new AudioContextClass();
  } catch {
    return null;
  }
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  context.createMediaStreamSource(stream).connect(analyser);
  const samples = new Uint8Array(analyser.fftSize);
  const started = Date.now();
  let lastVoice = 0;
  state.talkHeard = false;
  const timer = setInterval(() => {
    analyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) sum += (sample - 128) ** 2;
    const level = Math.sqrt(sum / samples.length);
    const now = Date.now();
    if (level > 6) {
      lastVoice = now;
      state.talkHeard = true;
    }
    const quietAfterSpeech = lastVoice && now - lastVoice > 1600;
    const nobodySpoke = !lastVoice && now - started > 8000;
    if ((quietAfterSpeech || nobodySpoke) && recorder.state === "recording") recorder.stop();
  }, 120);
  return () => {
    clearInterval(timer);
    void context.close().catch(() => {});
  };
}

// ── Talk with voice, hands-free ─────────────────────────────────────────
// Listen → send by itself → read the answer aloud → listen again, until the
// person says "стоп" or presses the button again.
const TALK_STOP_WORDS = /^(стоп|спри|край|stop|that'?s all|enough)[.!]?$/iu;
const TALK_MAX_EMPTY = 3;

function setTalkUi(on) {
  document.body.classList.toggle("talk-mode", on);
  if (!elements.talkBtn) return;
  elements.talkBtn.classList.toggle("talking", on);
  elements.talkBtn.setAttribute("aria-pressed", String(on));
  const label = chatText(on ? "Спри разговора с глас" : "Разговор с глас");
  elements.talkBtn.title = label;
  elements.talkBtn.setAttribute("aria-label", label);
  elements.chatInput.placeholder = chatText(on ? "Говори… кажи „стоп“ за край" : "Пиши на NovariumAI");
}

function toggleTalkMode() {
  if (state.talkMode) {
    stopTalkMode();
    return;
  }
  if (state.chatBusy) return;
  state.talkMode = true;
  state.talkEmpty = 0;
  // iPhone lets a page speak only after a tap; this empty phrase unlocks it.
  try {
    window.speechSynthesis?.speak(new SpeechSynthesisUtterance(""));
  } catch {
    // no speech on this device; answers stay on screen
  }
  setTalkUi(true);
  logAction("Разговор с глас: слушам");
  talkListen();
}

function stopTalkMode() {
  if (!state.talkMode) return;
  state.talkMode = false;
  clearTimeout(state.talkTimer);
  window.speechSynthesis?.cancel();
  if (state.recorder?.state === "recording") state.recorder.stop();
  if (state.listening) state.recognition?.abort();
  setTalkUi(false);
  logAction("Разговорът с глас спря");
}

function talkListen() {
  if (!state.talkMode || state.listening) return;
  clearTimeout(state.talkTimer);
  // While an answer, a picture or a clip is being made, listen once it is done.
  if (state.chatBusy) {
    state.talkTimer = setTimeout(talkListen, 500);
    return;
  }
  if (state.serverVoice) {
    void startServerRecording();
    return;
  }
  if (!state.recognition) {
    stopTalkMode();
    return;
  }
  try {
    state.recognition.start();
  } catch {
    state.recognition.abort();
    state.talkTimer = setTimeout(talkListen, 400);
  }
}

function talkAfterListening() {
  if (!state.talkMode) return;
  const said = elements.chatInput.value.trim();
  if (TALK_STOP_WORDS.test(said)) {
    elements.chatInput.value = "";
    resizeChatInput();
    stopTalkMode();
    return;
  }
  if (said) {
    state.talkEmpty = 0;
    // A picture or a clip is still being made: send once the chat is free.
    if (state.chatBusy) {
      clearTimeout(state.talkTimer);
      state.talkTimer = setTimeout(talkAfterListening, 500);
      return;
    }
    void sendMessage();
    return;
  }
  state.talkEmpty += 1;
  if (state.talkEmpty >= TALK_MAX_EMPTY) {
    stopTalkMode();
    return;
  }
  state.talkTimer = setTimeout(talkListen, 300);
}

// Plain words for reading aloud: no code, links or Markdown marks.
function textForSpeech(text) {
  return String(text || "")
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/https?:\/\/\S+/gu, " ")
    .replace(/[`*_#>|~]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 2400);
}

function speechChunks(text) {
  const sentences = text.match(/[^.!?…]+[.!?…]*\s*/gu) || [text];
  const chunks = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && (current + sentence).length > 220) {
      chunks.push(current.trim());
      current = "";
    }
    current += sentence;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

function talkSpeak(text) {
  const words = textForSpeech(text);
  const next = () => {
    state.talkTimer = setTimeout(talkListen, 350);
  };
  if (!state.talkMode) return;
  if (!words || !("speechSynthesis" in window)) {
    next();
    return;
  }
  window.speechSynthesis.cancel();
  const chunks = speechChunks(words);
  chunks.forEach((chunk, index) => {
    const utterance = new SpeechSynthesisUtterance(chunk);
    utterance.lang = chatLocale?.browserLocale || "bg-BG";
    if (index === chunks.length - 1) {
      utterance.onend = () => {
        if (state.talkMode) next();
      };
      utterance.onerror = utterance.onend;
    }
    window.speechSynthesis.speak(utterance);
  });
}

function toggleVoiceInput() {
  if (state.chatBusy) return;
  if (state.serverVoice) {
    if (state.recorder?.state === "recording") state.recorder.stop();
    else void startServerRecording();
    return;
  }
  if (!state.recognition) return;
  if (state.listening) {
    state.recognition.stop();
    return;
  }
  try {
    state.recognition.start();
  } catch {
    // start() throws if a previous session is still closing; reset it.
    state.recognition.abort();
    setListening(false);
  }
}

const GOOGLE_OAUTH_TOOL_IDS = new Set([
  "google-drive-read",
  "google-calendar-read",
  "google-calendar-write",
  "gmail-read",
  "google-contacts",
  "youtube-channel",
]);

function requiresGoogleOAuth(tool) {
  return GOOGLE_OAUTH_TOOL_IDS.has(tool?.id);
}

function toolState(tool, googleConnected, githubConnected) {
  if (!tool.enabled || !tool.executable) {
    return { label: "Не е свързан", className: "deny" };
  }
  if (!tool.configured) {
    return { label: "Не е конфигуриран", className: "deny" };
  }
  if (requiresGoogleOAuth(tool) && !googleConnected) {
    return { label: "Иска свързване", className: "confirm" };
  }
  if (tool.id === "github-read" && !githubConnected) {
    return { label: "Иска свързване", className: "confirm" };
  }
  if (
    ["github-write", "github-confirmed-write"].includes(tool.id) &&
    !githubConnected
  ) {
    return { label: "Иска свързване", className: "confirm" };
  }
  // "Работи" only after a real call answers (see checkToolsLive). Until then
  // the badge says what is known: it is set up, and whether it is checked.
  if (LIVE_TOOL_CHECKS[tool.id]) {
    return { label: "Проверявам…", className: "confirm" };
  }
  if (
    ["github-write", "github-confirmed-write"].includes(tool.id) &&
    githubConnected
  ) {
    return { label: "Свързано · пише само след потвърждение", className: "allow" };
  }
  return { label: "Настроен · без жива проверка", className: "confirm" };
}

// Which live check proves each tool works: a read-only call made when the
// tools list opens.
const LIVE_TOOL_CHECKS = {
  "google-drive-read": "google:drive",
  "gmail-read": "google:gmail",
  "google-calendar-read": "google:calendar",
  "google-contacts": "google:contacts",
  "youtube-channel": "google:youtube",
  "google-calendar-write": "google:calendar",
  "github-read": "github",
  "synchron-agent-chat": "core:synchron-agent-chat",
  "synchron-integrations-status": "core:synchron-integrations-status",
  "synchron-system-inspector": "core:synchron-system-inspector",
  "openai-codex": "core:openai-codex",
  "openai-web-search": "core:openai-web-search",
  "gemini-youtube": "core:gemini-youtube",
  "gemini-maps": "core:gemini-maps",
  "google-cloud-read": "core:google-cloud-read",
  "google-cloud-diagnostics": "core:google-cloud-diagnostics",
  "google-cloud-write": "core:google-cloud-write",
  "google-firestore-memory": "core:google-firestore-memory",
  "synchron-tasks": "core:synchron-tasks",
};

// Tells the server which tools showed as not working (names and badge text
// only), so a problem is seen without the owner sending a screenshot.
function reportBrokenTools(container) {
  if (document.body.dataset.userRole !== "owner") return;
  const items = [...container.querySelectorAll(".permission-badge.deny")].map((badge) => {
    const card = badge.closest("article") || badge.parentElement;
    return {
      name: card?.querySelector("strong, h3")?.textContent || "",
      label: badge.textContent || "",
      reason: badge.title || card?.querySelector(".tool-live-reason")?.textContent || "",
    };
  });
  if (!items.length) return;
  fetch("/api/tools/report", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  }).catch(() => {});
}

async function checkToolsLive(container) {
  const badges = [...container.querySelectorAll("[data-live-check]")];
  if (!badges.length) return;
  const [google, github, core] = await Promise.all([
    fetch("/api/google/check", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null),
    badges.some((badge) => badge.dataset.liveCheck === "github")
      ? fetch("/api/github/status", { cache: "no-store" })
          .then(async (response) => ({ ok: response.ok, data: await response.json().catch(() => ({})) }))
          .catch(() => ({ ok: false, data: {} }))
      : null,
    badges.some((badge) => badge.dataset.liveCheck.startsWith("core:"))
      ? fetch("/api/tools/check", { cache: "no-store" })
          .then((response) => (response.ok ? response.json() : null))
          .catch(() => null)
      : null,
  ]);
  const time = new Date().toLocaleTimeString("bg-BG", { hour: "2-digit", minute: "2-digit" });
  for (const badge of badges) {
    const [kind, service] = badge.dataset.liveCheck.split(":");
    let result = { ok: false, reason: "Проверката не мина." };
    if (kind === "google") {
      result = google?.services?.[service] || { ok: false, reason: google ? "Google не е свързан." : "Проверката не мина." };
    } else if (kind === "core") {
      result = core?.tools?.[service] || { ok: false, reason: "Проверката не мина." };
    } else if (kind === "github") {
      result = github?.ok ? { ok: true } : { ok: false, reason: github?.data?.error || "GitHub не отговори." };
    }
    if (!result.ok && typeof result.connect === "string" && result.connect.startsWith("/api/google/connect")) {
      badge.className = "permission-badge confirm";
      badge.textContent = result.reconnect ? "Връзката изтече" : "Още не е разрешен";
      const link = document.createElement("a");
      link.className = "tool-connect-btn";
      link.href = result.connect;
      link.textContent = result.reconnect ? "Свържи отново" : "Разреши";
      badge.after(link);
      continue;
    }
    badge.className = `permission-badge ${result.ok ? "allow" : "deny"}`;
    badge.textContent = result.ok ? `Работи · проверено ${time}` : "Не отговаря";
    badge.title = result.ok ? "Истинско четене току-що мина успешно." : result.reason || "";
    if (!result.ok && result.reason) {
      const note = document.createElement("small");
      note.className = "tool-live-reason";
      note.textContent = result.reason;
      badge.after(note);
    }
  }
}

function toolStatusActions(tool, status, googleConnected, githubConnected) {
  let action = "";
  if (requiresGoogleOAuth(tool) && !googleConnected && tool.configured) {
    action =
      '<button type="button" class="tool-connect-btn" data-connect-service="google">Свържи Google</button>';
  } else if (
    ["github-write", "github-confirmed-write"].includes(tool.id) &&
    tool.configured &&
    !githubConnected
  ) {
    action =
      '<button type="button" class="tool-connect-btn" data-connect-service="github">Свържи GitHub</button>';
  } else if (
    ["github-write", "github-confirmed-write"].includes(tool.id) &&
    !tool.configured
  ) {
    action =
      '<button type="button" class="tool-connect-btn" data-github-setup>Настрой GitHub</button>';
  }

  const ready = !action && LIVE_TOOL_CHECKS[tool.id];
  const live = ready ? ` data-live-check="${LIVE_TOOL_CHECKS[tool.id]}"` : "";
  return `
    <div class="tool-status-actions">
      <span class="permission-badge ${status.className}"${live}>${status.label}</span>
      ${action}
    </div>`;
}

function permissionAction(item, toolMap, googleConnected, githubConnected) {
  const googlePermissions = new Set([
    "calendar.read",
    "calendar.write",
    "drive.read",
    "mail.read",
    "mail.draft",
    "mail.send",
    "mail.delete",
    "contacts.read",
    "contacts.write",
  ]);
  if (googlePermissions.has(item.action) && !googleConnected) {
    return '<button type="button" class="tool-connect-btn" data-connect-service="google">Свържи Google</button>';
  }

  const githubWrite =
    toolMap.get("github-confirmed-write") || toolMap.get("github-write");
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

function connectionControls(
  googleConnected,
  githubConnected,
  chatgptConnection = {},
) {
  const chatgptConnected = Boolean(chatgptConnection.connected);
  const chatgptConfigured = chatgptConnection.configured !== false;
  const chatgptUnavailable = Boolean(chatgptConnection.unavailable);
  const chatgptGrants = Array.isArray(chatgptConnection.grants)
    ? chatgptConnection.grants
    : [];
  const chatgptScopes = [
    ...new Set(chatgptGrants.flatMap((grant) => grant.scopes || [])),
  ];
  const chatgptDescription = chatgptUnavailable
    ? "Състоянието временно не е достъпно"
    : chatgptConnected
      ? `${chatgptGrants.length} активни MCP връзки · ${chatgptScopes.length} разрешения`
      : chatgptConfigured
        ? "Няма активна MCP връзка"
        : "OAuth връзката не е конфигурирана";
  return `
    <section class="connection-control-grid" aria-label="Управление на връзките">
      <article class="connection-control-card">
        <div>
          <strong>ChatGPT</strong>
          <p>${escapeHtml(chatgptDescription)}</p>
          ${chatgptScopes.length ? `<small>${escapeHtml(chatgptScopes.join(" · "))}</small>` : ""}
        </div>
        <button type="button" class="tool-connect-btn" data-${chatgptConnected ? "disconnect" : "connect"}-service="chatgpt" ${chatgptConfigured ? "" : "disabled"}>
          ${chatgptConnected ? "Спри достъпа" : "Отвори ChatGPT"}
        </button>
      </article>
      <article class="connection-control-card">
        <div><strong>Google</strong><p>Drive, Gmail, Calendar и Contacts</p></div>
        <button type="button" class="tool-connect-btn" data-${googleConnected ? "disconnect" : "connect"}-service="google">
          ${googleConnected ? "Спри достъпа" : "Свържи Google"}
        </button>
      </article>
      <article class="connection-control-card">
        <div><strong>GitHub</strong><p>Код, issues, Pull Request-и и Actions</p></div>
        <button type="button" class="tool-connect-btn" data-${githubConnected ? "disconnect" : "connect"}-service="github">
          ${githubConnected ? "Спри достъпа" : "Свържи GitHub"}
        </button>
      </article>
    </section>`;
}

async function openToolsDrawer() {
  openDataDrawer("Инструменти");
  renderDrawerLoading();
  try {
    const [healthResponse, googleResponse, githubResponse, chatgptResponse] =
      await Promise.all([
        fetch("/health/integrations", { cache: "no-store" }),
        fetch("/api/google/status", { cache: "no-store" }).catch(() => null),
        fetch("/api/github/status", { cache: "no-store" }).catch(() => null),
        fetch("/permissions/oauth/chatgpt", { cache: "no-store" }).catch(
          () => null,
        ),
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
    const chatgptData = chatgptResponse?.ok
      ? await chatgptResponse.json().catch(() => ({
          configured: false,
          connected: false,
          unavailable: true,
        }))
      : { configured: false, connected: false, unavailable: true };
    const tools = Array.isArray(data.tools) ? data.tools : [];
    const descriptions = {
      "github-read": "Проверява commit-и и файлове. Само за четене.",
      "github-write":
        "NovariumAI генерира ограничена кодова промяна и след точно потвърждение създава отделен branch, атомарен commit и Pull Request.",
      "github-confirmed-write":
        "Създава отделен branch, файл, commit или Pull Request само след точно потвърждение. Merge, secrets и production deployment са забранени.",
      "google-drive-read": "Чете разрешени файлове от Google Drive.",
      "google-calendar-read": "Показва събития от Google Calendar.",
      "gmail-read":
        "Търси и чете имейли и създава чернови. Изпращане и кошче се изпълняват само след точно потвърждение.",
      "google-contacts":
        "Търси контакти; добавяне и промяна стават само след потвърждение.",
      "synchron-tasks":
        "Пази задачи, бележки, проектни връзки и потвърждавани статуси.",
      "synchron-agent-chat":
        "Разговаря с NovariumAI до 10 последователни въпроса в една MCP нишка.",
      "openai-web-search": "Търси актуална информация в интернет.",
      "synchron-system-inspector":
        "Проверява ядрото и Google Cloud runtime настройките без техните стойности.",
      "google-cloud-read":
        "Проверява текущия Cloud Run runtime, Firestore режима и активната revision без стойности на secrets.",
      "google-firestore-memory":
        "Google Cloud Memory: постоянната памет на NovariumAI в Firestore.",
    };
    elements.dataDrawerBody.innerHTML = `
      <div class="permission-default">
        Показано е реалното състояние. „Регистриран“ не означава автоматично „работи“.
      </div>
      ${connectionControls(
        Boolean(googleData.connected),
        Boolean(githubData.connected),
        chatgptData,
      )}
      <section class="drawer-section permission-list">
        <button type="button" class="permission-card tool-status-card system-control-link" data-system-configuration>
          <div>
            <strong>Системен контрол</strong>
            <p>Ядро, инструменти и всички променливи без показване на тайните им стойности.</p>
          </div>
          <span class="permission-badge allow">Отвори</span>
        </button>
        <article class="permission-card tool-status-card">
          <div><strong>Снимки</strong><p>JPEG, PNG и WebP до 5 MB. Чете ги Claude.</p></div>
          <span class="permission-badge confirm" data-live-check="core:images">Проверявам…</span>
        </article>
        ${tools
          .map((tool) => {
            const status = toolState(
              tool,
              Boolean(googleData.connected),
              Boolean(githubData.connected),
            );
            const description =
              descriptions[tool.id] || "Инструмент на NovariumAI.";
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
    void checkToolsLive(elements.dataDrawerBody).finally(() => reportBrokenTools(elements.dataDrawerBody));
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
                    · Източник: ${escapeHtml(item.source || "не е наличен")}
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
        <p>Google Cloud runtime: ${configuration.googleCloud?.cloudRunDetected ? "Cloud Run е потвърден" : configuration.googleCloud?.configured ? "проектът е конфигуриран" : "не е достъпен"}.</p>
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
  const wasOpen = !elements.dataDrawer.hidden;
  elements.dataDrawer.hidden = true;
  elements.drawerBackdrop.hidden = true;
  if (wasOpen) {
    document.dispatchEvent(new CustomEvent("synchron:data-drawer-closed"));
  }
}

function renderDrawerLoading() {
  elements.dataDrawerBody.innerHTML =
    '<div class="drawer-state"><i class="fa-solid fa-circle-notch fa-spin"></i> Зареждане…</div>';
}

function renderDrawerError(message) {
  elements.dataDrawerBody.innerHTML = `<div class="drawer-state drawer-error">${escapeHtml(message)}</div>`;
}

function localizedMarkup(value) {
  return escapeHtml(chatText(value)).replace(/"/gu, "&quot;");
}

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = String(value ?? "");
  return div.innerHTML;
}

// The owner's „Активност“: daily counts of people, messages and visits
// from each ad variant. Numbers only; nothing about who.
async function openActivityDrawer() {
  openDataDrawer(chatText("Активност"));
  renderDrawerLoading();
  try {
    const response = await fetch("/api/activity?days=14", { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Активността временно не е достъпна.");
    const days = Array.isArray(data.days) ? data.days : [];
    const total = (field) => days.reduce((sum, day) => sum + (Number(day[field]) || 0), 0);
    const ads = (day) =>
      ["landing_variant_1", "landing_variant_2", "landing_variant_3"]
        .map((field) => Number(day[field]) || 0)
        .join(" / ");
    const peak = Math.max(1, ...days.map((day) => Number(day.active) || 0));
    const rows = days
      .map(
        (day) => `
        <tr>
          <td>${escapeHtml(day.date.slice(5).split("-").reverse().join("."))}</td>
          <td><span class="activity-bar" style="width:${Math.round(((Number(day.active) || 0) / peak) * 100)}%"></span>${Number(day.active) || 0}</td>
          <td>${Number(day.messages) || 0}</td>
          <td>${Number(day.registrations) || 0}</td>
          <td>${escapeHtml(ads(day))}</td>
        </tr>`,
      )
      .join("");
    elements.dataDrawerBody.innerHTML = `
      <div class="activity-totals">
        <div><strong>${total("active")}</strong><span>${localizedMarkup("активни (сбор по дни)")}</span></div>
        <div><strong>${total("messages")}</strong><span>${localizedMarkup("съобщения")}</span></div>
        <div><strong>${total("registrations")}</strong><span>${localizedMarkup("нови профили")}</span></div>
        ${Number.isFinite(data.accounts?.total)
          ? `<div><strong>${data.accounts.total}</strong><span>${localizedMarkup("регистрирани общо")}</span></div>
             <div><strong>${Number(data.accounts.signedInLast7Days) || 0}</strong><span>${localizedMarkup("влизали за 7 дни")}</span></div>
             ${Number.isFinite(data.accounts.ownerAccounts)
               ? `<div><strong>${data.accounts.ownerAccounts}</strong><span>${localizedMarkup("с твоя имейл")}</span></div>
                  <div><strong>${Number(data.accounts.otherAccounts) || 0}</strong><span>${localizedMarkup("други хора")}</span></div>`
               : ""}`
          : ""}
        <div><strong>${total("landing_variant_1") + total("landing_variant_2") + total("landing_variant_3")}</strong><span>${localizedMarkup("дошли от реклама")}</span></div>
      </div>
      <p class="activity-note">${localizedMarkup("Последните 14 дни. Само бройки, без имена и без текст от разговорите. Рекламата е по варианти 1 / 2 / 3.")}</p>
      ${data.accounts?.error ? `<p class="activity-note">${escapeHtml(data.accounts.error)}</p>` : ""}
      <div class="activity-table-wrap">
        <table class="activity-table">
          <thead><tr><th>${localizedMarkup("Ден")}</th><th>${localizedMarkup("Активни")}</th><th>${localizedMarkup("Съобщения")}</th><th>${localizedMarkup("Нови")}</th><th>${localizedMarkup("Реклама")}</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  } catch (error) {
    renderDrawerError(error.message);
  }
}

function openMyDataDrawer() {
  openDataDrawer(chatText("Моите данни"));
  elements.dataDrawerBody.innerHTML = `
    <section class="drawer-section">
      <h3>${localizedMarkup("Изтегли данните си")}</h3>
      <p>${localizedMarkup("Копие на паметта, разговорите, проектите, предложенията и връзките ти във формат JSON.")}</p>
      <a class="connection-copy my-data-download" href="/api/account/export" download>${localizedMarkup("Изтегли копие")}</a>
    </section>
    <section class="drawer-section my-data-danger">
      <h3>${localizedMarkup("Изтрий профила")}</h3>
      <p>${localizedMarkup("Изтрива окончателно паметта, разговорите, проектите, предложенията и профила за вход и прекъсва свързаните AI асистенти. Счетоводните документи за плащания се пазят, както изисква законът.")}</p>
      <form class="my-data-delete" data-account-delete>
        <label for="accountDeletePassword">${localizedMarkup("Парола (само ако влизаш с имейл и парола)")}</label>
        <input id="accountDeletePassword" type="password" autocomplete="current-password" />
        <label for="accountDeleteConfirm">${localizedMarkup("Напиши ИЗТРИЙ за потвърждение")}</label>
        <input id="accountDeleteConfirm" type="text" autocomplete="off" required />
        <button type="submit" class="connection-revoke">${localizedMarkup("Изтрий профила завинаги")}</button>
        <p class="my-data-status" role="status" hidden></p>
      </form>
    </section>
    <section class="drawer-section">
      <p><a href="/privacy">${localizedMarkup("Поверителност")}</a> · <a href="/terms">${localizedMarkup("Общи условия")}</a></p>
    </section>`;
  elements.dataDrawerBody
    .querySelector("[data-account-delete]")
    ?.addEventListener("submit", submitAccountDeletion);
}

async function submitAccountDeletion(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const status = form.querySelector(".my-data-status");
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  status.hidden = false;
  status.textContent = chatText("Изтриване…");
  try {
    const response = await fetch("/api/account/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        password: form.querySelector("#accountDeletePassword").value,
        confirm: form.querySelector("#accountDeleteConfirm").value.trim(),
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Профилът не беше изтрит.");
    status.textContent = chatText("Профилът е изтрит.");
    try {
      localStorage.clear();
    } catch {
      // Storage may be unavailable; the server-side data is already gone.
    }
    window.location.assign("/");
  } catch (error) {
    status.textContent = error.message;
    button.disabled = false;
  }
}

const PROVIDER_LABELS = Object.freeze({
  openai: "OpenAI",
  gemini: "Gemini",
  grok: "Grok",
  claude: "Claude",
});

function describeAiError(data) {
  const base = data?.message || chatText("AI агентът върна грешка.");
  const details = [];
  if (Array.isArray(data?.failures)) {
    for (const item of data.failures.slice(0, 5)) {
      const name = PROVIDER_LABELS[item?.provider] || "AI";
      details.push(item?.status ? `${name}: ${item.status}` : `${name}: ${item?.code || "?"}`);
    }
  } else if (Number.isInteger(data?.upstreamStatus)) {
    details.push(`${chatText("код")} ${data.upstreamStatus}`);
  }
  return details.length ? `${base} (${details.join(", ")})` : base;
}

const INBOX_SOURCES = Object.freeze({
  claude: "Claude",
  chatgpt: "ChatGPT",
  gemini: "Gemini",
  "novarium": "NovariumAI",
  other: "AI",
});

function setInboxCount(count) {
  if (!elements.inboxCount) return;
  elements.inboxCount.textContent = count > 99 ? "99+" : String(count);
  elements.inboxCount.hidden = !count;
}

async function refreshInboxCount() {
  if (!elements.inboxBtn) return;
  try {
    const response = await fetch("/api/memory-inbox", { cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json();
    setInboxCount(Array.isArray(data.items) ? data.items.length : 0);
  } catch {
    // The badge is optional; the drawer shows errors when opened.
  }
}

async function openInboxDrawer() {
  openDataDrawer(chatText("Входящи"));
  renderDrawerLoading();
  try {
    const response = await fetch("/api/memory-inbox", { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Входящите временно не са достъпни.");
    const items = Array.isArray(data.items) ? data.items : [];
    setInboxCount(items.length);
    renderInbox(items);
  } catch (error) {
    renderDrawerError(error.message);
  }
}

function renderInbox(items) {
  const list = items.length
    ? items
        .map(
          (item) => `
      <li class="inbox-item" data-inbox-id="${escapeHtml(item.id)}">
        <p class="inbox-fact">${escapeHtml(item.fact)}</p>
        <textarea class="inbox-edit" maxlength="500" hidden aria-label="${localizedMarkup("Редактирай факта")}">${escapeHtml(item.fact)}</textarea>
        <small>${escapeHtml(INBOX_SOURCES[item.source] || "AI")} · ${localizedMarkup(item.scope === "project" ? "Проект" : "Лично")} · ${escapeHtml(formatConnectionDate(item.createdAt))}</small>
        <div class="inbox-actions">
          <button type="button" class="inbox-approve" data-inbox-approve>${localizedMarkup("Запази")}</button>
          <button type="button" class="inbox-secondary" data-inbox-edit>${localizedMarkup("Редактирай")}</button>
          <button type="button" class="inbox-secondary" data-inbox-dismiss>${localizedMarkup("Отхвърли")}</button>
        </div>
      </li>`,
        )
        .join("")
    : `<li class="inbox-empty">
        <strong>${localizedMarkup("Няма нови предложения.")}</strong>
        <p>${localizedMarkup("Когато Claude, ChatGPT или NovariumAI предложат нещо за запомняне, ще го видиш тук и ще решиш дали да се запази.")}</p>
        <button type="button" class="connection-copy" data-open-connections>${localizedMarkup("Свържи AI")}</button>
      </li>`;
  elements.dataDrawerBody.innerHTML = `
    <section class="drawer-section">
      <p>${localizedMarkup("Тук AI асистентите ти предлагат какво да запомнят. Нищо не влиза в паметта без твоето одобрение.")}</p>
      <ul class="inbox-list">${list}</ul>
    </section>`;
}

async function handleInboxAction(event) {
  if (event.target.closest("[data-open-connections]")) {
    await openConnectionsDrawer();
    return true;
  }
  const item = event.target.closest("[data-inbox-id]");
  if (!item) return false;
  const id = item.dataset.inboxId;
  if (event.target.closest("[data-inbox-edit]")) {
    const editor = item.querySelector(".inbox-edit");
    editor.hidden = !editor.hidden;
    item.querySelector(".inbox-fact").hidden = !editor.hidden;
    if (!editor.hidden) editor.focus();
    return true;
  }
  const approve = event.target.closest("[data-inbox-approve]");
  const dismiss = event.target.closest("[data-inbox-dismiss]");
  if (!approve && !dismiss) return false;
  for (const button of item.querySelectorAll("button")) button.disabled = true;
  try {
    const editor = item.querySelector(".inbox-edit");
    const response = await fetch(
      `/api/memory-inbox/${encodeURIComponent(id)}/${approve ? "approve" : "dismiss"}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(approve && !editor.hidden ? { fact: editor.value } : {}),
      },
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Действието не беше изпълнено.");
    await openInboxDrawer();
  } catch (error) {
    for (const button of item.querySelectorAll("button")) button.disabled = false;
    renderDrawerError(error.message);
  }
  return true;
}

const CONNECTION_GUIDES = Object.freeze([
  {
    client: "Claude",
    steps: [
      "Отвори Claude → Настройки → Connectors.",
      "Натисни „Add custom connector“, име: NovariumAI.",
      "Постави адреса отгоре.",
      "В „Advanced settings“ въведи Client ID: novariumai-claude. Client secret остава празно.",
      "Натисни „Connect“, влез с този профил и натисни „Разреши“.",
    ],
  },
  {
    client: "ChatGPT",
    steps: [
      "Отвори ChatGPT → Settings → Apps & Connectors.",
      "Включи Developer mode и натисни „Create“.",
      "Постави адреса отгоре, удостоверяване: OAuth.",
      "Влез с този профил и натисни „Разреши“.",
    ],
  },
]);

function formatConnectionDate(value) {
  const time = Date.parse(value || "");
  if (!Number.isFinite(time)) return chatText("неизвестно");
  return new Date(time).toLocaleDateString(document.documentElement.lang || "bg", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

async function openConnectionsDrawer() {
  openDataDrawer(chatText("Свържи своите AI асистенти"));
  renderDrawerLoading();
  try {
    const response = await fetch("/api/connections", { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Връзките временно не са достъпни.");
    renderConnections(data);
  } catch (error) {
    renderDrawerError(error.message);
  }
}

function renderConnections(data) {
  const mcpUrl = String(data.mcpUrl || "https://novariumai.com/mcp");
  const connections = Array.isArray(data.connections) ? data.connections : [];
  const connected = connections.length
    ? connections
        .map(
          (item) => `
        <li class="connection-item">
          <span class="connection-dot" aria-hidden="true"></span>
          <span class="connection-text">
            <strong>${escapeHtml(item.client)}</strong>
            <small>${localizedMarkup("Свързан на")} ${escapeHtml(formatConnectionDate(item.issuedAt))}${
              item.lastUsedAt
                ? ` · ${localizedMarkup("последно ползван")} ${escapeHtml(formatConnectionDate(item.lastUsedAt))}`
                : ""
            }</small>
          </span>
          <button type="button" class="connection-revoke" data-revoke-connection="${escapeHtml(item.grantId)}">${localizedMarkup("Прекъсни")}</button>
        </li>`,
        )
        .join("")
    : `<li class="connection-empty">${localizedMarkup("Още няма свързани AI асистенти.")}</li>`;
  // Claude is the owner's personal connector; the server refuses members.
  const ownerView = document.body.dataset.userRole === "owner";
  const guides = CONNECTION_GUIDES.filter(
    (guide) => guide.client !== "Claude" || ownerView,
  ).map(
    (guide) => `
      <details class="connection-guide">
        <summary>${localizedMarkup("Свържи")} ${escapeHtml(guide.client)}</summary>
        <ol>${guide.steps.map((step) => `<li>${localizedMarkup(step)}</li>`).join("")}</ol>
      </details>`,
  ).join("");
  elements.dataDrawerBody.innerHTML = `
    <section class="drawer-section connections-intro">
      <p>${localizedMarkup("Свържи Claude, ChatGPT и други AI асистенти с NovariumAI. Всички ще работят с една и съща памет и проекти, а ти одобряваш какво се запазва.")}</p>
      <div class="connection-url">
        <code id="connectionMcpUrl">${escapeHtml(mcpUrl)}</code>
        <button type="button" class="connection-copy" data-copy-connection-url>${localizedMarkup("Копирай адреса")}</button>
      </div>
      ${data.configured === false ? `<p class="drawer-state">${localizedMarkup("Свързването временно не е налично.")}</p>` : ""}
    </section>
    <section class="drawer-section">
      <h3>${localizedMarkup("Как да свържеш")}</h3>
      ${guides}
    </section>
    <section class="drawer-section">
      <h3>${localizedMarkup("Свързани в момента")}</h3>
      <ul class="connection-list">${connected}</ul>
    </section>`;
}

async function handleConnectionAction(event) {
  const copy = event.target.closest("[data-copy-connection-url]");
  if (copy) {
    const url = document.getElementById("connectionMcpUrl")?.textContent || "";
    try {
      await navigator.clipboard.writeText(url);
      copy.textContent = chatText("Копирано");
    } catch {
      copy.textContent = chatText("Копирай ръчно");
    }
    return true;
  }
  const revoke = event.target.closest("[data-revoke-connection]");
  if (!revoke) return false;
  if (!window.confirm(chatText("Да прекъсна ли тази връзка? AI асистентът вече няма да вижда паметта ти."))) return true;
  revoke.disabled = true;
  try {
    const response = await fetch("/api/connections/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grantId: revoke.dataset.revokeConnection }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Връзката не беше прекъсната.");
    await openConnectionsDrawer();
  } catch (error) {
    revoke.disabled = false;
    renderDrawerError(error.message);
  }
  return true;
}

async function openMemoryDrawer() {
  openDataDrawer("Памет");
  renderDrawerLoading();
  try {
    const [response, workspaceResponse, knowledgeResponse, avatarResponse] = await Promise.all([
      fetch("/memory/profile", { cache: "no-store" }),
      fetch("/api/workspaces", { cache: "no-store" }),
      fetch("/memory/knowledge", { cache: "no-store" }).catch(() => null),
      fetch("/api/avatar-link", { cache: "no-store", credentials: "same-origin" }).catch(() => null),
    ]);
    if (!response.ok || !workspaceResponse.ok) {
      throw new Error("Паметта временно не е достъпна.");
    }
    const [data, workspace, knowledge] = await Promise.all([
      response.json(),
      workspaceResponse.json(),
      knowledgeResponse?.ok
        ? knowledgeResponse.json().catch(() => ({ items: [] }))
        : Promise.resolve({ items: [] }),
    ]);
    state.memoryItems = Array.isArray(data.items) ? data.items : [];
    state.knowledgeItems = Array.isArray(knowledge.items)
      ? knowledge.items
      : [];
    state.memoryWorkspace = workspace;
    const avatar = avatarResponse?.ok ? await avatarResponse.json().catch(() => null) : null;
    state.avatarLink = avatar
      ? { active: Boolean(avatar.active), knowledge: String(avatar.card?.knowledge || "") }
      : null;
    renderMemoryItems();
  } catch (error) {
    renderDrawerError(error.message);
  }
}

// Each remembered fact says when it was saved and who confirmed it, so an
// invented "fact" can be spotted and removed.
function memoryProvenance(item) {
  const source = String(item?.source || "");
  const who = source === "system-canonical"
    ? chatText("основа на системата")
    : /confirmed|confirmation|approved|import|own-chat-command/u.test(source)
      ? chatText("потвърдено от теб")
      : source
        ? chatText("източник: {source}", { source })
        : "";
  const when = item?.updatedAt || item?.createdAt;
  const date = when && !Number.isNaN(Date.parse(when))
    ? new Date(when).toLocaleDateString("bg-BG")
    : "";
  const text = [date && chatText("записано {date}", { date }), who].filter(Boolean).join(" · ");
  return text ? `<small class="memory-provenance">${escapeHtml(text)}</small>` : "";
}

function renderMemoryItems() {
  const personal = state.memoryItems.filter(
    (item) => (item.scope || "personal") === "personal",
  );
  const project = state.memoryItems.filter((item) => item.scope === "project");
  const memoryMode =
    state.memoryWorkspace?.state?.preferences?.memoryMode === "disabled"
      ? "disabled"
      : "confirm";
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
                          ${memoryProvenance(item)}
                          ${
                            !item.readOnly && state.avatarLink && isSharedWithAvatar(item.fact)
                              ? `<small class="memory-shared">${localizedMarkup("Споделено с „Питай моя аватар“")}</small>`
                              : ""
                          }
                        </div>
                        ${
                          item.readOnly
                            ? ""
                            : `<span class="memory-card-actions">
                                ${
                                  state.avatarLink
                                    ? `<button type="button" data-memory-share="${escapeHtml(item.id)}"
                                  aria-pressed="${isSharedWithAvatar(item.fact)}"
                                  aria-label="${escapeHtml(chatText(isSharedWithAvatar(item.fact) ? "Спри споделянето с аватара" : "Сподели с аватара"))}"
                                  title="${escapeHtml(chatText(isSharedWithAvatar(item.fact) ? "Споделено с „Питай моя аватар“. Натисни, за да го махнеш." : "Сподели с „Питай моя аватар“"))}">
                                  <i class="fa-solid fa-share-nodes"></i>
                                </button>`
                                    : ""
                                }
                                <button type="button" data-memory-edit="${escapeHtml(item.id)}"
                                  aria-label="Редактирай този спомен" title="Редактирай">
                                  <i class="fa-regular fa-pen-to-square"></i>
                                </button>
                                <button type="button" data-memory-delete="${escapeHtml(item.id)}"
                                  aria-label="Изтрий този спомен" title="Изтрий">
                                  <i class="fa-regular fa-trash-can"></i>
                                </button>
                              </span>`
                        }
                    </article>`,
                    )
                    .join("")
                : '<div class="drawer-empty">Няма записани спомени.</div>'
            }
        </section>`;
  elements.dataDrawerBody.innerHTML =
    `<p class="memory-intro">${escapeHtml(chatText("Това е всичко, което NovariumAI помни за теб. Нищо не се записва без твое „да“, а всеки запис можеш да поправиш, изтриеш или споделиш с „Питай моя аватар“."))}</p>
    <section class="memory-policy-card">
      <strong>${localizedMarkup("Правило за запомняне")}</strong>
      <p>${localizedMarkup("NovariumAI никога не запомня сам. Записва само когато кажеш „Запомни: …“ или натиснеш „Запомни“ под отговор. Можеш и напълно да забраниш записването.")}</p>
      <div class="memory-policy-actions">
        <button type="button" data-memory-policy="confirm" aria-pressed="${memoryMode === "confirm"}">${localizedMarkup("Само когато кажа")}</button>
        <button type="button" data-memory-policy="disabled" aria-pressed="${memoryMode === "disabled"}">${localizedMarkup("Не записвай")}</button>
      </div>
    </section>` +
    renderKnowledgeImportCard() +
    section("За теб", personal) +
    section("За проекта", project) +
    renderApprovedKnowledge();
}

function renderKnowledgeImportCard() {
  const preview = state.knowledgePreview;
  const pending = state.knowledgeImportConfirmation;
  const previewMarkup = preview.length
    ? `<div class="knowledge-preview-list">
        ${preview
          .map(
            (item, index) => `
          <label class="memory-card knowledge-preview-item">
            <input type="checkbox" data-knowledge-select="${escapeHtml(item.id)}" checked />
            <span>
              <span class="memory-badge">${escapeHtml(item.category)}/${escapeHtml(item.scope)}</span>
              <p>${escapeHtml(item.text)}</p>
              <small>${escapeHtml(item.sourceTitle || item.sourceId || "Архив")}</small>
            </span>
          </label>`,
          )
          .join("")}
        <div class="memory-policy-actions">
          <button type="button" data-knowledge-prepare>Подготви избраните</button>
        </div>
      </div>`
    : "";
  const pendingMarkup = pending
    ? `<div class="setup-guide">
        <p>Прегледът е готов. Нищо не е записано, докато не потвърдиш.</p>
        <code>${escapeHtml(pending.confirmationPhrase)}</code>
        <div class="memory-policy-actions">
          <button type="button" data-knowledge-confirm>Потвърди импорт</button>
          <button type="button" data-knowledge-cancel>Откажи</button>
        </div>
      </div>`
    : "";
  return `<section class="memory-policy-card knowledge-import-card">
      <strong>Архивно знание</strong>
      <p>Избери ChatGPT JSON архив. NovariumAI само предлага кандидати; записът е отделен и изисква твое потвърждение.</p>
      <input id="knowledgeArchiveInput" type="file" accept="application/json,.json" />
      <div class="memory-policy-actions">
        <button type="button" data-knowledge-preview>Прегледай архива</button>
      </div>
      ${previewMarkup}${pendingMarkup}
    </section>`;
}

function renderApprovedKnowledge() {
  const items = Array.isArray(state.knowledgeItems) ? state.knowledgeItems : [];
  if (!items.length) {
    return '<section class="drawer-section"><h3>Одобрено архивно знание <span>0</span></h3><div class="drawer-empty">Няма одобрени архивни бележки.</div></section>';
  }
  return `<section class="drawer-section">
      <h3>Одобрено архивно знание <span>${items.length}</span></h3>
      ${items
        .map(
          (item) => `<article class="memory-card">
            <div>
              <span class="memory-badge">${escapeHtml(item.category || "fact")}/${escapeHtml(item.scope || "project")}</span>
              <p>${escapeHtml(item.text)}</p>
              <small>${escapeHtml(item.sourceTitle || item.sourceId || "Архив")}</small>
            </div>
          </article>`,
        )
        .join("")}
    </section>`;
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
      chatgptResponse,
    ] = await Promise.all([
      fetch("/permissions", { cache: "no-store" }),
      fetch("/health/integrations", { cache: "no-store" }),
      fetch("/api/google/status", { cache: "no-store" }).catch(() => null),
      fetch("/api/github/status", { cache: "no-store" }).catch(() => null),
      fetch("/permissions/oauth/chatgpt", { cache: "no-store" }).catch(
        () => null,
      ),
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
    const chatgptData = chatgptResponse?.ok
      ? await chatgptResponse.json().catch(() => ({
          configured: false,
          connected: false,
          unavailable: true,
        }))
      : { configured: false, connected: false, unavailable: true };
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
            ${connectionControls(
              Boolean(googleData.connected),
              Boolean(githubData.connected),
              chatgptData,
            )}
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
        GitHub Read проверява хранилището. NovariumAI Code Write подготвя отделен branch, commit и Pull Request след точно потвърждение.
      </div>
      <article class="setup-step">
        <span><i class="fa-solid fa-check"></i></span>
        <div>
          <strong>Четенето е активно</strong>
          <p>NovariumAI може да проверява разрешеното хранилище, commit-и и Pull Request-и.</p>
        </div>
      </article>
      <article class="setup-step">
        <span><i class="fa-solid fa-lock"></i></span>
        <div>
          <strong>Писането е защитено</strong>
          <p>Първо виждаш точните файлове. Едва след потвърждение NovariumAI създава отделен branch, commit и Pull Request към main.</p>
        </div>
      </article>
      <div class="setup-note">
        Използва се свързаният GitHub OAuth профил. Не поставяй token или private key в чата.
      </div>
      <button type="button" class="permission-info-btn" data-back-tools>Назад към инструментите</button>
    </section>`;
}

function showPermissionInfo(action) {
  const messages = {
    "calendar.write":
      "Записът в Google Calendar е активен след свързване на Google. NovariumAI първо показва точните данни и записва събитието само след еднократно потвърждение.",
    "memory.write":
      "Записът в паметта е активен. Преди постоянен запис NovariumAI трябва да покаже точния текст и да поиска твоето потвърждение.",
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
  if (await handleConnectionAction(event)) return;
  if (await handleInboxAction(event)) return;
  if (event.target.closest("[data-knowledge-preview]")) {
    await previewKnowledgeArchive();
    return;
  }

  if (event.target.closest("[data-knowledge-prepare]")) {
    await prepareKnowledgeArchiveImport();
    return;
  }

  if (event.target.closest("[data-knowledge-confirm]")) {
    await confirmKnowledgeArchiveImport();
    return;
  }

  if (event.target.closest("[data-knowledge-cancel]")) {
    state.knowledgePreview = [];
    state.knowledgeImportConfirmation = null;
    renderMemoryItems();
    return;
  }

  const memoryPolicy = event.target.closest("[data-memory-policy]");
  if (memoryPolicy) {
    const mode = memoryPolicy.dataset.memoryPolicy;
    if (
      !["confirm", "disabled"].includes(mode) ||
      !state.memoryWorkspace?.state
    ) {
      return;
    }
    const previous = state.memoryWorkspace.state.preferences || {};
    state.memoryWorkspace.state.preferences = { ...previous, memoryMode: mode };
    try {
      const response = await fetch("/api/workspaces", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: state.memoryWorkspace.state }),
      });
      if (!response.ok)
        throw new Error("Настройката не можа да бъде запазена.");
      state.memoryWorkspace = await response.json();
      renderMemoryItems();
      logAction(
        mode === "disabled"
          ? "Записът в паметта е изключен"
          : "Паметта ще пита преди всеки запис",
      );
    } catch (error) {
      renderDrawerError(error.message);
    }
    return;
  }

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
    } else if (connectionButton.dataset.connectService === "chatgpt") {
      window.open("https://chatgpt.com/", "_blank", "noopener,noreferrer");
    }
    return;
  }

  const disconnectButton = event.target.closest("[data-disconnect-service]");
  if (disconnectButton) {
    const service = disconnectButton.dataset.disconnectService;
    const serviceName =
      service === "google"
        ? "Google"
        : service === "github"
          ? "GitHub"
          : "ChatGPT";
    if (
      !window.confirm(
        service === "chatgpt"
          ? "Да отнема ли всички активни права на ChatGPT до NovariumAI?"
          : `Да спра ли достъпа на NovariumAI до ${serviceName}?`,
      )
    ) {
      return;
    }
    disconnectButton.disabled = true;
    try {
      const response = await fetch(
        service === "google"
          ? "/api/google/disconnect"
          : service === "github"
            ? "/api/github/disconnect"
            : "/permissions/oauth/chatgpt/revoke",
        service === "chatgpt"
          ? {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ all: true }),
            }
          : { method: "POST" },
      );
      if (!response.ok) throw new Error("Връзката не можа да бъде прекъсната.");
      await openPermissionsDrawer();
      logAction(`Прекъсната е връзката с ${serviceName}`);
    } catch (error) {
      renderDrawerError(error.message);
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

  const shareButton = event.target.closest("button[data-memory-share]");
  if (shareButton) {
    const item = state.memoryItems.find(
      (candidate) => candidate.id === shareButton.dataset.memoryShare,
    );
    if (!item) return;
    const shared = isSharedWithAvatar(item.fact);
    shareButton.disabled = true;
    try {
      await shareWithAvatar(item.fact, !shared);
      renderMemoryItems();
      logAction(shared ? "Спомен е махнат от „Питай моя аватар“" : "Спомен е споделен с „Питай моя аватар“");
    } catch (error) {
      renderDrawerError(error.message);
    }
    return;
  }

  const editButton = event.target.closest("button[data-memory-edit]");
  if (editButton) {
    const item = state.memoryItems.find(
      (candidate) => candidate.id === editButton.dataset.memoryEdit,
    );
    if (!item) return;
    const nextFact = window.prompt(
      "Редактирай точния текст на спомена:",
      item.fact,
    );
    if (!nextFact || nextFact.trim() === item.fact) return;
    editButton.disabled = true;
    try {
      const preparedResponse = await fetch("/memory/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: state.sessionId,
          memoryId: item.id,
          fact: nextFact.trim(),
          scope: item.scope || "personal",
        }),
      });
      const prepared = await preparedResponse.json().catch(() => null);
      if (
        preparedResponse.status !== 409 ||
        prepared?.code !== "MEMORY_WRITE_CONFIRMATION_REQUIRED" ||
        !prepared?.confirmationId
      ) {
        throw new Error(
          prepared?.error || "Промяната не можа да бъде подготвена.",
        );
      }
      if (!window.confirm(`Да заменя ли спомена с:\n\n${nextFact.trim()}`)) {
        editButton.disabled = false;
        return;
      }
      const response = await fetch("/memory/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: state.sessionId,
          confirmationId: prepared.confirmationId,
        }),
      });
      const updated = await response.json().catch(() => null);
      if (!response.ok || !updated?.items?.[0]) {
        throw new Error(
          updated?.error || "Споменът не можа да бъде редактиран.",
        );
      }
      state.memoryItems = state.memoryItems.map((candidate) =>
        candidate.id === item.id ? updated.items[0] : candidate,
      );
      await refreshAvatarLink();
      renderMemoryItems();
      logAction("Редактиран е потвърден спомен");
    } catch (error) {
      renderDrawerError(error.message);
    }
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
    await refreshAvatarLink();
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
        <span class="thinking-label">${localizedMarkup("Приемам задачата…")}</span>
        <span class="thinking-dots" aria-hidden="true">
            <span></span><span></span><span></span>
        </span>
    `;
  elements.chatMessages.appendChild(div);
  scrollChatToBottom();
}

// The server streams its progress in Bulgarian; show it in the page language.
function taskProgressText(task) {
  if (Number.isInteger(task.step) && Number.isInteger(task.totalSteps) && task.capability) {
    return chatText("Стъпка {step} от {total}: {capability}", {
      step: task.step,
      total: task.totalSteps,
      capability: task.capability,
    });
  }
  const steps = /^Изпълнявам (\d+) проверени стъпки…$/u.exec(task.message);
  if (steps) return chatText("Изпълнявам {count} проверени стъпки…", { count: steps[1] });
  return chatText(task.message);
}

function updateTaskIndicator(task) {
  const indicator = document.getElementById("typingIndicator");
  const label = indicator?.querySelector(".thinking-label");
  if (!indicator || !label || typeof task?.message !== "string") return;
  label.textContent = taskProgressText(task);
  indicator.dataset.taskStatus = task.status || "executing";
  scrollChatToBottom();
}

function removeTypingIndicator() {
  document.getElementById("typingIndicator")?.remove();
}

globalThis.SynchronChat = {
  ...(globalThis.SynchronChat || {}),
  sessionId: () => state.sessionId,
  busy: () => state.chatBusy,
  renderMarkdown: (element, text) => renderAgentText(element, text),
  append: (role, text, options) => appendMessage(role, text, null, options),
  // The page's own picture and clip lines (daily-plan.js): marked, so the
  // server and retry tell them apart from what the person and the model wrote.
  remember: (role, text) => rememberConversationMessage(role, text, { page: true }),
  setBusy: (busy) => setChatBusy(busy),
  language: () => chatLocale?.language || "bg",
};

// „Спри“ stops the answer being written and the queued pictures and clips
// that have not started.
function stopGeneration() {
  state.chatAbort?.abort();
  cancelQueuedMedia();
}

function setChatBusy(isBusy) {
  state.chatBusy = isBusy;
  // While an answer streams the send button becomes "Stop", like ChatGPT.
  elements.sendBtn.disabled = false;
  elements.sendBtn.classList.toggle("is-stop", isBusy);
  elements.sendBtn.setAttribute("aria-label", chatText(isBusy ? "Спри" : "Изпрати"));
  const sendIcon = elements.sendBtn.querySelector("i");
  if (sendIcon) sendIcon.className = isBusy ? "fa-solid fa-stop" : "fa-solid fa-arrow-up";
  const sendLabel = elements.sendBtn.querySelector("span");
  if (sendLabel) sendLabel.textContent = chatText(isBusy ? "Спри" : "Изпрати");
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
        <button type="button" data-action="execute-council" class="council-execute-action" hidden>
            <i class="fa-solid fa-play"></i>
            <span class="action-label">${localizedMarkup("Изпълни препоръката")}</span>
        </button>
        <button type="button" data-action="copy" title="${localizedMarkup("Копирай")}" aria-label="${localizedMarkup("Копирай")}">
            <i class="fa-regular fa-copy"></i>
            <span class="action-label">${localizedMarkup("Копирай")}</span>
        </button>
        <button type="button" data-action="retry" class="retry-action" title="${localizedMarkup("Пробвай пак")}" aria-label="${localizedMarkup("Пробвай пак")}">
            <i class="fa-solid fa-rotate-right"></i>
        </button>
        <button type="button" data-action="retry-model" class="retry-action" title="${localizedMarkup("Пробвай с друг модел")}" aria-label="${localizedMarkup("Пробвай с друг модел")}">
            <i class="fa-solid fa-shuffle"></i>
        </button>
        <button type="button" data-action="save-google" title="${localizedMarkup("Запази в Google")}" aria-label="${localizedMarkup("Запази в Google")}">
            <i class="fa-brands fa-google-drive"></i>
        </button>
        <button type="button" data-action="remember" title="${localizedMarkup("Запомни")}" aria-label="${localizedMarkup("Запомни")}">
            <i class="fa-regular fa-bookmark"></i>
        </button>
        <button type="button" data-action="open-panel" title="${localizedMarkup("Отвори отстрани")}" aria-label="${localizedMarkup("Отвори отстрани")}">
            <i class="fa-solid fa-up-right-from-square"></i>
        </button>
        <button type="button" data-action="speak" title="${localizedMarkup("Прочети на глас")}" aria-label="${localizedMarkup("Прочети на глас")}">
            <i class="fa-solid fa-volume-high"></i>
        </button>
        <button type="button" data-action="like" title="${localizedMarkup("Добър отговор")}" aria-label="${localizedMarkup("Добър отговор")}">
            <i class="fa-regular fa-thumbs-up"></i>
        </button>
        <button type="button" data-action="dislike" title="${localizedMarkup("Лош отговор")}" aria-label="${localizedMarkup("Лош отговор")}">
            <i class="fa-regular fa-thumbs-down"></i>
        </button>
    `;

  turn.append(message, actions);
  elements.chatMessages.appendChild(turn);
  return { turn, message, actions };
}

function showCouncilExecutionAction(message, councilIntentId) {
  const turn = message?.closest(".assistant-turn");
  const button = turn?.querySelector('button[data-action="execute-council"]');
  if (!button || typeof councilIntentId !== "string" || !councilIntentId) {
    return;
  }
  button.dataset.councilIntentId = councilIntentId;
  button.hidden = false;
}

// Council answers side by side on a wide screen and as swipeable cards on a
// phone (Perplexity/ChatHub style). The answers move out of the long text
// into the cards; the comparison and recommendation stay below them.
function showCouncilColumns(message, council) {
  const responses = Array.isArray(council?.responses) ? council.responses : [];
  if (!message || responses.length < 2) return;
  const headings = Array.from(message.querySelectorAll("h3"));
  const isAnswerHeading = (node) =>
    node?.tagName === "H3" &&
    responses.some(({ model }) => model && node.textContent.includes(` · ${model}`));
  const isBoundary = (node) =>
    node.tagName === "H2" ||
    (node.tagName === "H3" &&
      (isAnswerHeading(node) || /^(✅|⚖️|💡)/u.test(node.textContent.trim())));
  const first = headings.find(isAnswerHeading);
  if (!first || first.parentElement !== message) return;

  const columns = document.createElement("div");
  columns.className = "council-columns";
  columns.setAttribute("aria-label", chatText("Отговорите на моделите"));
  let node = first;
  while (node && isAnswerHeading(node)) {
    const card = document.createElement("section");
    card.className = "council-card";
    let sibling = node.nextElementSibling;
    card.appendChild(node);
    while (sibling && !isBoundary(sibling)) {
      const after = sibling.nextElementSibling;
      card.appendChild(sibling);
      sibling = after;
    }
    columns.appendChild(card);
    node = sibling;
  }
  if (columns.children.length < 2) {
    // Unexpected layout: put everything back where it was.
    for (const card of Array.from(columns.children)) {
      for (const child of Array.from(card.children)) message.insertBefore(child, node);
    }
    return;
  }
  message.insertBefore(columns, node);
  message.classList.add("has-council-columns");
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

// "Откъде знам това": the person's own things the answer is connected to
// (a file, a remembered fact, an archive note). Shown only when there is one.
// A list in the answer (steps, a shopping list, a plan) can become the
// person's own tasks with one press; nothing is saved without it.
function listItemsFromAnswer(text) {
  const items = [];
  for (const line of String(text || "").split("\n")) {
    const match = /^\s{0,3}(?:[-*•]|\d{1,2}[.)])\s+(?:\[[ xX]\]\s+)?(.+)$/u.exec(line);
    if (!match) continue;
    const item = match[1]
      .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
      .replace(/[*_`]+/gu, "")
      .trim();
    if (item.length >= 2) items.push(item.slice(0, 200));
  }
  return items.slice(0, 12);
}

function offerTodos(message, text) {
  const turn = message?.closest(".assistant-turn");
  const items = listItemsFromAnswer(text);
  if (!turn || items.length < 2 || turn.querySelector(".answer-todos")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "answer-todos";
  button.innerHTML = '<i class="fa-solid fa-list-check" aria-hidden="true"></i><span></span>';
  const label = button.querySelector("span");
  label.textContent = `${chatText("Добави в Моите задачи")} (${items.length})`;
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const response = await fetch("/api/todos", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || chatText("Задачите не бяха записани."));
      label.textContent = chatText("Добавено в Моите задачи");
      button.classList.add("done");
    } catch (error) {
      label.textContent = error.message;
      button.disabled = false;
    }
  });
  const actions = turn.querySelector(".message-actions");
  turn.insertBefore(button, actions || null);
}

function showAnswerSources(message, sources) {
  const turn = message?.closest(".assistant-turn");
  const list = Array.isArray(sources) ? sources.slice(0, 4) : [];
  if (!turn || !list.length || turn.querySelector(".answer-sources")) return;
  const kinds = {
    file: { icon: "fa-regular fa-file-lines", text: "файл" },
    memory: { icon: "fa-solid fa-brain", text: "памет" },
    archive: { icon: "fa-solid fa-box-archive", text: "архив" },
  };
  const box = document.createElement("div");
  box.className = "answer-sources";
  const title = document.createElement("span");
  title.className = "answer-sources-title";
  title.textContent = chatText("Свързано с твоите неща:");
  box.appendChild(title);
  for (const { kind, label } of list) {
    const meta = kinds[kind];
    if (!meta || typeof label !== "string" || !label.trim()) continue;
    const chip = document.createElement("span");
    chip.className = `answer-source answer-source-${kind}`;
    const icon = document.createElement("i");
    icon.className = meta.icon;
    icon.setAttribute("aria-hidden", "true");
    chip.append(icon, ` ${chatText(meta.text)}: ${label.trim()}`);
    box.appendChild(chip);
  }
  if (box.children.length < 2) return;
  const actions = turn.querySelector(".message-actions");
  turn.insertBefore(box, actions || null);
}

function showAiResponseSource(message, provider, model, linkedProjectContext) {
  const turn = message?.closest(".assistant-turn");
  if (!turn || turn.querySelector(".ai-response-source")) return;

  const cleanProvider = typeof provider === "string" ? provider.trim() : "";
  const cleanModel = typeof model === "string" ? model.trim() : "";
  if (!cleanProvider && !cleanModel) return;

  turn.dataset.provider = cleanProvider;
  turn.dataset.model = cleanModel;
  const source = document.createElement("div");
  source.className = "ai-response-source";
  const context =
    linkedProjectContext === true
      ? chatText("Работа със свързани чатове")
      : linkedProjectContext === false
        ? chatText("Работа без заредени свързани чатове")
        : linkedProjectContext === null
          ? chatText("Работа без активен проект")
          : "";
  const providerNames = {
    openai: "OpenAI",
    gemini: "Gemini",
    "vertex-gemini": "Vertex Gemini",
    grok: "Grok",
    claude: "Claude",
  };
  source.textContent = [
    chatText("Отговаря агентът"),
    providerNames[cleanProvider] || cleanProvider,
    cleanModel,
    context,
  ]
    .filter(Boolean)
    .join(" · ");
  source.setAttribute("aria-label", chatText("AI доставчик и модел"));

  const actions = turn.querySelector(".message-actions");
  turn.insertBefore(source, actions || null);
}

function cleanNextStep(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/^[-*•#\s]+/gu, "")
    .replace(/\*\*/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 240);
}

// The model's "Следва:" or "Next:" line. The Bulgarian label counts in any
// case; the English one only as "Next" or "Next step" with a capital N, so
// code such as "next: () => …" is never taken for one.
const NEXT_LINE_BULGARIAN = /^(\s*(?:[-*•]\s*)?(?:\*\*)?)(?:Следва|Следваща стъпка)((?:\*\*)?\s*:)/iu;
const NEXT_LINE_ENGLISH = /^(\s*(?:[-*•]\s*)?(?:\*\*)?)Next(?: [Ss]tep)?((?:\*\*)?\s*:)/u;

function nextLineMarker(line) {
  return line.match(NEXT_LINE_BULGARIAN) || line.match(NEXT_LINE_ENGLISH);
}

// Code blocks as marked, which shows the answer, reads them. Three or more
// backticks or tildes open a block, also after a list marker ("- ```bash"); a
// backtick fence's info string cannot contain backticks, so a one-line
// "```npm test```" is not a fence. marked reads a list item's lines from the
// column where the item's text starts, so a block's fences are measured from
// there: from the text of the item whose marker the fence follows, or else of
// the innermost open item whose text starts at or left of the fence (column 0
// outside lists). A fence line four or more columns past that does not open a
// block, and only a bare run of the same character, at least as long as the
// opening one and at most three columns past it, closes the block. So a "```"
// line inside a "````" block, and an indented "    ```" in a Python string or
// a README example, are code. A closing fence left of the item's text still
// closes the block, as the model meant it to (marked would end the item
// there).
// A list item ends, with any block in it, at a non-blank line left of its
// text that follows a blank line, starts a new item, starts with ``` or ~~~,
// or comes right below a bare fence line (no info string) that opened a
// block in the item, while the fence is fewer columns past the item's text
// than that text is past its parent item's text (column 0 at the top
// level), as marked limits it. Such a bare line is often a closing fence
// read as an opening one. A line right below a fence with an info string
// does not end the item by being there, as the model meant it to be code
// (marked would end the item there). When that line is left of the item's
// text, the model wrote the block's code unindented: the block then stays
// open at the endings of its item while a line further down would close it.
// It ends at the next such line, normally its own closing fence (or a later
// block's fence line when its own is missing), or with its item when none
// follows. After such a block the fences pair as the model wrote them, no
// longer as marked pairs them, so a bare fence that could not be a closing
// fence outside a list, right after its item's marker ("2. ```") or on its
// own line four or more columns in, is unindented too when the line below
// it is left of the item's text: that line ends the item only when no line
// further down would close the block.
// marked's other item endings, such as a heading, an HTML block, a quote, a
// rule, or a line left of the item's text right below one four or more
// columns past it, are not read.
// The server (codeBlocksOfLines) uses the same rule.
const NEXT_LINE_FENCE_OPEN = /^([ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?)(?:(`{3,})[^`]*|(~{3,})[\s\S]*)$/u;
const NEXT_LINE_FENCE_CLOSE = /^([ \t]*)(`{3,}|~{3,}) *\r?$/u;
const NEXT_LINE_FENCE_START = /^[ \t]*(?:```|~~~)/u;
const NEXT_LINE_LIST_ITEM = /^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)/u;
// A line with a Google allow link: besides blank lines, the only line that may
// follow the answer's own Next line (older answers have the allow line last).
const NEXT_LINE_ALLOW_LINK = /\/api\/google\/connect/u;

// The column a line's leading spaces and tabs reach; a tab moves to the next
// multiple of four, as marked counts indentation.
function nextLineIndentWidth(text) {
  let column = 0;
  for (const char of text.match(/^[ \t]*/u)[0]) {
    column = char === "\t" ? column + 4 - (column % 4) : column + 1;
  }
  return column;
}

// The lines that could close a code block, read from the end of the answer
// up, only as far as a block needs. Of the lines with one fence character
// and run length, only those left of every such line below them are kept,
// the lowest first: the last such line at or left of a column is one of them.
function nextLineClosingLinesFromEnd(lines) {
  return { lines, next: lines.length - 1, groups: new Map() };
}

// The index of the last line that could close the block, when it is below
// the given line, else -1: one of the block's fence character, with a run at
// least as long as the opening one, at most three columns past the item's
// text.
function nextLineLastClosingLineBelow(closings, block, index) {
  const limit = block.base + 3;
  let last = -1;
  for (const group of closings.groups.values()) {
    if (group.char !== block.char || group.length < block.length) continue;
    const line = group.lines.find(({ indent }) => indent <= limit);
    if (line) last = Math.max(last, line.index);
  }
  // Read on up while no line read so far would close the block.
  while (last < 0 && closings.next > index) {
    const at = closings.next;
    closings.next -= 1;
    const close = closings.lines[at].match(NEXT_LINE_FENCE_CLOSE);
    if (!close) continue;
    const [, spaces, run] = close;
    const indent = nextLineIndentWidth(spaces);
    if (!closings.groups.has(run)) closings.groups.set(run, { char: run[0], length: run.length, lines: [] });
    const kept = closings.groups.get(run).lines;
    if (kept.length && kept.at(-1).indent <= indent) continue;
    kept.push({ index: at, indent });
    if (run[0] === block.char && run.length >= block.length && indent <= limit) last = at;
  }
  return last > index ? last : -1;
}

// For each line, the code block it is in (its fence lines too), or null
// outside code. A block is bare when its opening fence has no info string,
// on a marker when its fence follows its item's marker on the same line, and
// unindented when its code starts left of the item's text, as the rule above
// says. At an ending of its item, an unindented block stays open while the
// last line that would close it is further down. That line is looked up once
// for all blocks of one fence character, run length and item column: it is
// the answer's last such line, and when it is not below the block that asked
// first (-1), it is below no later block either. Only the first 16 kinds in
// an answer are looked up, so an answer made of many kinds costs no more than
// a plain one; a block of a further kind ends with its item. Real answers
// use at most three.
function nextLineCodeBlocks(lines) {
  // Where the text of each open list item starts, the innermost last.
  const items = [];
  // The open code block, null outside code.
  let fence = null;
  let afterBlank = false;
  // Whether a block so far was unindented.
  let hadUnindented = false;
  // For unindented blocks: the lines that could close a block, read from the
  // end of the answer up, as far as those blocks need them, and the last line
  // that would close a block, by fence character, run length and item column.
  let closings = null;
  const lastClosings = new Map();
  return lines.map((line, index) => {
    const followsBlank = afterBlank;
    afterBlank = !line.trim();
    // A blank line stays in the open block, or outside code.
    if (afterBlank) return fence;
    const indent = nextLineIndentWidth(line);
    const item = line.match(NEXT_LINE_LIST_ITEM);
    // Whether the line ends the list items whose text it is left of.
    const endsItems =
      followsBlank ||
      Boolean(item) ||
      NEXT_LINE_FENCE_START.test(line) ||
      Boolean(fence?.endsItemBelow && fence.line === index - 1);
    if (fence) {
      const block = fence;
      const close = line.match(NEXT_LINE_FENCE_CLOSE);
      if (
        close &&
        close[2][0] === block.char &&
        close[2].length >= block.length &&
        nextLineIndentWidth(close[1]) <= block.base + 3
      ) {
        fence = null;
        return block;
      }
      // Code right below its fence, left of the item's text: below a fence
      // with an info string or, after an unindented block, below a bare fence
      // right after its item's marker or four or more columns in.
      if (
        block.line === index - 1 &&
        indent < block.base &&
        (!block.bare || (hadUnindented && (block.onMarker || block.column >= 4)))
      ) {
        block.unindented = true;
        hadUnindented = true;
      }
      // Any other line ends the block only where it ends the block's item,
      // and an unindented block only when no line further down would close it.
      if (!endsItems || indent >= block.base) return block;
      if (block.unindented) {
        closings ??= nextLineClosingLinesFromEnd(lines);
        const key = `${block.char}${block.length} ${block.base}`;
        if (!lastClosings.has(key)) lastClosings.set(key, lastClosings.size < 16 ? nextLineLastClosingLineBelow(closings, block, index) : -1);
        if (lastClosings.get(key) > index) return block;
      }
      fence = null;
    }
    if (endsItems) while (items.length && items.at(-1) > indent) items.pop();
    if (item) items.push(nextLineIndentWidth(item[0].replace(/\S/gu, " ")));
    const open = line.match(NEXT_LINE_FENCE_OPEN);
    if (!open) return null;
    // Where the fence starts, and where the text of its item starts.
    const column = nextLineIndentWidth(open[1].replace(/\S/gu, " "));
    const base = items.at(-1) ?? 0;
    if (column - base >= 4) return null;
    const run = open[2] || open[3];
    const bare = !line.slice(open[1].length + run.length).trim();
    fence = {
      char: run[0],
      length: run.length,
      base,
      bare,
      onMarker: Boolean(item),
      column,
      unindented: false,
      line: index,
      endsItemBelow: bare && column - base < base - (items.at(-2) ?? 0),
    };
    return fence;
  });
}

// The answer's own Next line is its last such line outside code blocks (-1
// when there is none); earlier ones are content, and code never counts.
function answerNextLineIndex(lines) {
  const blocks = nextLineCodeBlocks(lines);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!blocks[index] && nextLineMarker(lines[index])) return index;
  }
  return -1;
}

// The answer's own "Следва:" line, when it is not the Next card (not the last
// line, or a restored answer), is shown with the page's label, "Next" on an
// English page. It is that line only where the answer's Next line goes: last,
// or followed only by blank lines and allow lines. Other "Следва:" lines, such
// as a Bulgarian text the person asked for, stay as they are.
function localizedNextLines(text) {
  const label = chatText("Следва");
  if (typeof text !== "string" || label === "Следва") return text;
  const lines = text.split("\n");
  const index = answerNextLineIndex(lines);
  if (index < 0) return text;
  const after = lines.slice(index + 1);
  if (!after.every((line) => !line.trim() || NEXT_LINE_ALLOW_LINK.test(line))) return text;
  // The model writes "Next:" on every page but a Bulgarian one, so on a German
  // or French page that line gets the page's label too, as the Next card does.
  const marker = NEXT_LINE_BULGARIAN.test(lines[index]) ? NEXT_LINE_BULGARIAN : NEXT_LINE_ENGLISH;
  if (marker === NEXT_LINE_ENGLISH && label === "Next") return text;
  lines[index] = lines[index].replace(marker, (match, start, end) => `${start}${label}${end}`);
  return lines.join("\n");
}

// The answer's own Next line becomes the Next card only while it is the last
// line; the text above it is then shown without it. The step is on that line,
// as the prompt asks: a bare "Следва:" with the step on the line below stays
// text.
function nextStepFromReply(text) {
  const value = typeof text === "string" ? text.trimEnd() : "";
  const lines = value.split("\n");
  const index = answerNextLineIndex(lines);
  const step =
    index >= 0 && index === lines.length - 1
      ? cleanNextStep(lines[index].slice(nextLineMarker(lines[index])[0].length))
      : "";
  const before = step ? lines.slice(0, index).join("\n").trimEnd() : "";
  return { step, displayText: before || localizedNextLines(value) };
}

function resolveNextStep(replyText, result = {}) {
  const next = structuredNextStep(replyText, result);
  // The pictures and video on this answer's card (done.media) are made by a
  // short yes to the answer's own last line, so that line is the step shown,
  // also when a project run, a council or a missing Google permission has a
  // step of its own: what a yes makes is always on screen (review r5). A
  // project's or a council's step still goes to the journal; the permission
  // link stays in the reply.
  const own = nextStepFromReply(replyText).step;
  if (own && next.step !== own && Array.isArray(result?.media?.items) && result.media.items.length) {
    return {
      step: own,
      displayText: next.displayText,
      mediaOffer: true,
      journalStep: next.chatOnly ? "" : next.step,
    };
  }
  return next;
}

function structuredNextStep(replyText, result = {}) {
  const parsedReply = nextStepFromReply(replyText);
  const projectStep = cleanNextStep(result?.projectRun?.nextStep);
  const councilStep = cleanNextStep(result?.council?.nextSteps?.[0]);
  if (projectStep || councilStep) {
    return {
      step: projectStep || councilStep,
      displayText: parsedReply.displayText,
    };
  }

  // Only a Google permission is missing: the reply already has the link, so
  // the step stays in the chat and does not go to the journal, even when the
  // answer ends with its own "Next:" line.
  const status = result?.task?.status;
  const failedSteps = (result?.task?.steps || []).filter((item) => item?.status === "failed");
  if (
    (status === "failed" || status === "partial") &&
    failedSteps.length &&
    failedSteps.every((item) => item.error === "GOOGLE_SCOPE_REQUIRED")
  ) {
    return {
      step: chatText("Натисни линка за разрешение по-горе и попитай отново."),
      displayText: parsedReply.displayText,
      chatOnly: true,
    };
  }
  if (parsedReply.step) {
    return { step: parsedReply.step, displayText: parsedReply.displayText };
  }

  if (result?.mode === "council") {
    return {
      step: chatText("Прегледай общата препоръка и натисни „Изпълни препоръката“, ако я одобряваш."),
      displayText: parsedReply.displayText,
    };
  }

  if (status === "waiting_confirmation") {
    return {
      step: chatText("Прегледай подготвеното действие и натисни „Потвърди“, ако е точно това."),
      displayText: parsedReply.displayText,
    };
  }
  if (status === "partial") {
    return {
      step: chatText("Отвори Дневника на задачите и продължи първата незавършена стъпка."),
      displayText: parsedReply.displayText,
    };
  }
  if (status === "failed") {
    return {
      step: chatText("Отвори Дневника на задачите и прегледай причината за неуспешната задача."),
      displayText: parsedReply.displayText,
    };
  }
  return { step: "", displayText: parsedReply.displayText };
}

function showNextStep(message, replyText, result) {
  const turn = message?.closest(".assistant-turn");
  if (!turn || turn.querySelector(".next-step-card")) return;

  const next = resolveNextStep(replyText, result);
  if (!next.step) return;
  if (next.displayText && next.displayText !== String(replyText).trimEnd()) {
    renderAgentText(message, next.displayText);
  }

  // Only steps that come from a real project run, council or task go to the
  // journal automatically. A step the model wrote in free text is shown but
  // saved only when Радко presses the button, so invented items never pile up.
  // The answer's own offer to make its pictures and video is such a step,
  // and the project's or council's step it stands in for is saved instead.
  const fromStructuredResult =
    !next.mediaOffer &&
    Boolean(
      result?.projectRun?.nextStep ||
        result?.council?.nextSteps?.[0] ||
        result?.task?.status,
    );
  if (fromStructuredResult && !next.chatOnly) {
    globalThis.SynchronTaskJournal?.setNextStep(next.step, {
      detail: "Записано автоматично от последния отговор на NovariumAI.",
    });
  }
  if (next.journalStep) {
    globalThis.SynchronTaskJournal?.setNextStep(next.journalStep, {
      detail: "Записано автоматично от последния отговор на NovariumAI.",
    });
  }

  const card = document.createElement("section");
  card.className = "next-step-card";
  card.setAttribute("aria-label", chatText("Следваща стъпка"));

  const label = document.createElement("strong");
  label.textContent = chatText("Следва");
  const step = document.createElement("p");
  step.textContent = next.step;
  const openButton = document.createElement("button");
  openButton.type = "button";
  openButton.textContent = chatText(
    fromStructuredResult ? "Отвори в Дневника" : "Добави в Дневника",
  );
  openButton.addEventListener("click", () => {
    if (!fromStructuredResult) {
      globalThis.SynchronTaskJournal?.setNextStep(next.step, {
        detail: "Добавено от Радко от отговор на NovariumAI.",
      });
    }
    globalThis.SynchronTaskJournal?.openCurrentNext();
  });
  card.append(label, step);
  // A prepared write (an event, a contact, an email) waits for the exact
  // command shown in the reply; "Потвърди" sends that command, so nobody has
  // to type the long code on a phone.
  const command =
    result?.task?.status === "waiting_confirmation"
      ? taskConfirmationCommand(replyText)
      : "";
  if (command) {
    const confirmButton = document.createElement("button");
    confirmButton.type = "button";
    confirmButton.className = "next-step-confirm";
    confirmButton.textContent = chatText("Потвърди");
    confirmButton.addEventListener("click", () => {
      if (state.chatBusy) return;
      confirmButton.disabled = true;
      elements.chatInput.value = command;
      resizeChatInput();
      void sendMessage();
    });
    card.append(confirmButton);
  }
  if (!next.chatOnly) card.append(openButton);

  const actions = turn.querySelector(".message-actions");
  turn.insertBefore(card, actions || null);
}

// The exact confirmation command a task reply asks for, in Bulgarian or
// English, or "" when there is none.
function taskConfirmationCommand(replyText) {
  const match = String(replyText || "").match(
    /(?:Потвърждавам NovariumAI задача|Confirm NovariumAI task):\s*[0-9a-f]{8}-[0-9a-f-]{27,}/iu,
  );
  return match ? match[0] : "";
}

// Pictures and video an answer described (done.media): a card under the
// answer with a button for each and „Направи всичко“. The page makes them with
// its own generators (daily-plan.js, the same as the "+" menu, with the same
// routes and units) only after a press on the card, or a short yes the server
// started (media.start). Each card keeps the state of its own items (idle,
// queued, running, made, failed), so a new card always starts fresh, also
// with a description an earlier card made. One queue for the whole page
// makes them one after another; „Спри“ cancels what has not started.
const MEDIA_BUSY_STATES = new Set(["queued", "running", "made"]);
let mediaQueue = Promise.resolve();
// The queued items that have not started yet: { card, key, cancelled }.
const waitingMedia = new Set();

// The items of done.media, once each: the card keeps one state per
// description, so the same description twice is one button (review r2).
function mediaItems(media) {
  const seen = new Set();
  return (Array.isArray(media?.items) ? media.items : [])
    .filter(
      (item) =>
        (item?.kind === "image" || item?.kind === "video") &&
        typeof item.prompt === "string" &&
        item.prompt.trim(),
    )
    .map((item) => ({
      kind: item.kind,
      prompt: item.prompt.trim(),
      units: Number.isFinite(item.units) && item.units > 0 ? Math.round(item.units) : 0,
      number: Number.isInteger(item.number) && item.number > 0 ? item.number : 0,
    }))
    .filter((item) => {
      const key = mediaKey(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function mediaKey(item) {
  return `${item.kind}:${item.prompt}`;
}

// A button stays pressed while all its items are queued, being made or made;
// an item that failed, or was cancelled, can be pressed again. A pressed
// button says which: made when all its items are made, being made when one
// of them is, waiting otherwise (review r5), so a queued picture does not
// look made.
const MEDIA_STATE_WORDS = { queued: "чака", running: "прави се", made: "готово" };

function mediaButtonState(card, keys) {
  const states = keys.map((key) => card.__mediaState.get(key));
  if (!states.length || !states.every((value) => MEDIA_BUSY_STATES.has(value))) return "";
  if (states.every((value) => value === "made")) return "made";
  return states.includes("running") ? "running" : "queued";
}

function refreshMediaCard(card) {
  for (const button of card.querySelectorAll("button")) {
    const state = mediaButtonState(card, button.__mediaKeys || []);
    button.disabled = Boolean(state);
    if ((button.dataset.mediaState || "") === state) continue;
    if (state) button.dataset.mediaState = state;
    else delete button.dataset.mediaState;
    const name = state
      ? `${button.__mediaName} · ${chatText(MEDIA_STATE_WORDS[state])}`
      : button.__mediaName;
    button.textContent = name;
    if (button.__mediaDescription) {
      button.title = `${name} — ${button.__mediaDescription}`;
      button.setAttribute("aria-label", button.title);
    }
  }
}

function setMediaState(card, key, value) {
  card.__mediaState.set(key, value);
  refreshMediaCard(card);
}

// The card's items that are queued, being made or made: sent with the next
// message, so a short yes never makes them again.
function busyMediaKeys(card) {
  return [...card.__mediaState]
    .filter(([, value]) => MEDIA_BUSY_STATES.has(value))
    .map(([key]) => key);
}

// The card of the latest answer the chat gave on screen, past the page's own
// picture and clip turns and its notes, and past the server's own replies to
// a yes that have no card (their items went to the card above them), as the
// server passes over them too; null when that answer has none.
function latestMediaCard() {
  const answers = elements.chatMessages.querySelectorAll(".assistant-turn.chat-answer");
  for (let index = answers.length - 1; index >= 0; index -= 1) {
    const card = answers[index].querySelector(":scope > .media-proposals");
    if (card) return card;
    if (!answers[index].classList.contains("media-yes-reply")) return null;
  }
  return null;
}

// Waits while an answer, or a picture from the "+" menu, is being made;
// false when „Спри“ cancelled the item meanwhile.
async function waitForFreeChat(entry) {
  while (state.chatBusy && !entry.cancelled) {
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return !entry.cancelled;
}

function queueMedia(card, items) {
  for (const item of items) {
    const key = mediaKey(item);
    if (MEDIA_BUSY_STATES.has(card.__mediaState.get(key))) continue;
    const entry = { card, key, cancelled: false };
    waitingMedia.add(entry);
    setMediaState(card, key, "queued");
    mediaQueue = mediaQueue.then(() => makeMediaItem(entry, item));
  }
  return mediaQueue;
}

async function makeMediaItem(entry, item) {
  const free = await waitForFreeChat(entry);
  waitingMedia.delete(entry);
  // A card no longer on screen (another conversation was opened) makes
  // nothing.
  if (!free || !entry.card.isConnected) return;
  setMediaState(entry.card, entry.key, "running");
  let made = false;
  try {
    const make = globalThis.SynchronMedia?.[item.kind === "video" ? "makeVideo" : "drawImage"];
    made = typeof make === "function" && (await make(item.prompt, { fromChat: true })) === true;
  } catch {
    made = false;
  }
  setMediaState(entry.card, entry.key, made ? "made" : "failed");
}

// „Спри“: the queued items that have not started go back to idle and their
// buttons can be pressed again; the one being made finishes (its units are
// already reserved).
function cancelQueuedMedia() {
  for (const entry of waitingMedia) {
    entry.cancelled = true;
    setMediaState(entry.card, entry.key, "idle");
  }
  waitingMedia.clear();
}

// The first characters of a description, for a button's name.
function mediaDescriptionStart(prompt) {
  const characters = Array.from(prompt);
  return characters.length > 60 ? `${characters.slice(0, 60).join("").trimEnd()}…` : prompt;
}

// Shows the card under an answer and returns it (null when there is none).
// made: the items an edited or retried question's removed cards had made
// (resendFrom); their pictures and clips stay on screen, so the card of the
// answer that replaces them shows them made and „Направи всичко“ makes only
// the rest (review r5). Any other card starts fresh.
function showMediaProposals(message, media, made = []) {
  const turn = message?.closest(".assistant-turn");
  const items = mediaItems(media);
  if (!turn || !items.length || turn.querySelector(":scope > .media-proposals")) return null;

  const card = document.createElement("section");
  card.className = "media-proposals";
  card.tabIndex = -1;
  const madeBefore = new Set(made);
  card.__mediaState = new Map(
    items.map((item) => [mediaKey(item), madeBefore.has(mediaKey(item)) ? "made" : "idle"]),
  );
  card.setAttribute("aria-label", chatText("Картинки и видео"));
  const label = document.createElement("strong");
  label.textContent = chatText("Картинки и видео");
  const buttons = document.createElement("div");
  buttons.className = "media-proposals-buttons";
  const addButton = (text, chosen, description = "", className = "") => {
    const button = document.createElement("button");
    button.type = "button";
    if (className) button.className = className;
    button.textContent = text;
    button.__mediaName = text;
    button.__mediaDescription = description;
    if (description) {
      button.title = `${text} — ${description}`;
      button.setAttribute("aria-label", button.title);
    }
    button.__mediaKeys = chosen.map(mediaKey);
    button.addEventListener("click", () => {
      void queueMedia(card, chosen);
      // The pressed button is now disabled; focus goes to the card itself,
      // never to another button, so one more Enter or Space makes nothing
      // the person did not choose (review r5).
      card.focus();
    });
    buttons.append(button);
  };
  // A picture keeps the answer's own number ("Картинка 2:") unless an earlier
  // picture on the card has it; any other picture takes the lowest number no
  // picture on the card has, so no two buttons have the same name.
  const numbers = new Map();
  const taken = new Set();
  for (const item of items) {
    if (item.kind === "image" && item.number && !taken.has(item.number)) {
      numbers.set(item, item.number);
      taken.add(item.number);
    }
  }
  let free = 1;
  for (const item of items) {
    if (item.kind !== "image" || numbers.has(item)) continue;
    while (taken.has(free)) free += 1;
    numbers.set(item, free);
    taken.add(free);
  }
  for (const item of items) {
    const name =
      item.kind === "video"
        ? `🎬 ${chatText("Видео")}`
        : `🎨 ${chatText("Картинка")} ${numbers.get(item)}`;
    // Only a member pays; the owner's items come with 0 units.
    const cost = item.units > 0 ? ` · ${item.units} ${chatText("единици")}` : "";
    addButton(`${name}${cost}`, [item], mediaDescriptionStart(item.prompt));
  }
  // A member sees what „Направи всичко“ costs together, like each item.
  const total = items.reduce((sum, item) => sum + item.units, 0);
  const totalCost = total > 0 ? ` · ${total} ${chatText("единици")}` : "";
  if (items.length > 1) addButton(`${chatText("Направи всичко")}${totalCost}`, items, "", "media-proposals-all");
  card.append(label, buttons);

  // Above the Next card, whose step usually offers to make them.
  turn.insertBefore(
    card,
    turn.querySelector(":scope > .next-step-card") ||
      turn.querySelector(":scope > .message-actions") ||
      null,
  );
  refreshMediaCard(card);
  return card;
}

function memoryCandidateCategoryLabel(category) {
  return (
    {
      identity: "Идентичност",
      preference: "Предпочитание",
      goal: "Цел",
      interest: "Интерес",
      "project-fact": "Проект",
    }[category] || "Факт"
  );
}

function showMemoryCandidates(message, candidates) {
  const turn = message?.closest(".assistant-turn");
  if (!turn || !Array.isArray(candidates) || candidates.length === 0) return;
  if (turn.querySelector(".memory-candidate-card")) return;

  const safeCandidates = candidates
    .filter(
      (candidate) =>
        candidate &&
        typeof candidate.fact === "string" &&
        candidate.fact.trim(),
    )
    .slice(0, 3)
    .map((candidate) => ({
      fact: candidate.fact.trim(),
      scope: candidate.scope === "project" ? "project" : "personal",
      category: candidate.category || "personal-fact",
      reason: candidate.reason || "Може да помогне в бъдещи разговори.",
    }));
  if (!safeCandidates.length) return;

  turn.__memoryCandidates = safeCandidates;
  const card = document.createElement("section");
  card.className = "memory-candidate-card";
  card.setAttribute("aria-label", "Предложения за постоянната памет");

  const title = document.createElement("strong");
  title.textContent = "Предложение за постоянната памет";
  const intro = document.createElement("p");
  intro.textContent =
    "Открих устойчив факт. Нищо не се записва автоматично — избери какво да направя.";
  card.append(title, intro);

  for (const [index, candidate] of safeCandidates.entries()) {
    const item = document.createElement("article");
    item.className = "memory-candidate-item";
    item.dataset.memoryCandidateIndex = String(index);

    const badge = document.createElement("span");
    badge.className = "memory-badge";
    badge.textContent = `${memoryCandidateCategoryLabel(candidate.category)} · ${candidate.scope === "project" ? "проект" : "личен"}`;
    const fact = document.createElement("p");
    fact.className = "memory-candidate-fact";
    fact.textContent = candidate.fact;
    const reason = document.createElement("small");
    reason.textContent = candidate.reason;

    const actions = document.createElement("div");
    actions.className = "memory-candidate-actions";
    for (const [action, label] of [
      ["memory-candidate-save", "Запази"],
      ["memory-candidate-edit", "Редактирай"],
      ["memory-candidate-reject", "Отхвърли"],
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.action = action;
      button.dataset.memoryCandidateIndex = String(index);
      button.textContent = label;
      actions.appendChild(button);
    }
    item.append(badge, fact, reason, actions);
    card.appendChild(item);
  }

  const actions = turn.querySelector(".message-actions");
  turn.insertBefore(card, actions || null);
}

function finishMemoryCandidateItem(item, message) {
  item.replaceChildren();
  item.classList.add("saved");
  const status = document.createElement("span");
  status.textContent = message;
  item.appendChild(status);
}

async function saveMemoryCandidate(button, factOverride = "") {
  const turn = button.closest(".assistant-turn");
  const item = button.closest(".memory-candidate-item");
  const index = Number(button.dataset.memoryCandidateIndex);
  const candidate = turn?.__memoryCandidates?.[index];
  if (!item || !candidate) return;

  const fact = (factOverride || candidate.fact).trim();
  if (!fact) return;
  const buttons = item.querySelectorAll("button");
  buttons.forEach((entry) => (entry.disabled = true));
  try {
    const preparedResponse = await fetch("/memory/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: state.sessionId,
        fact,
        scope: candidate.scope,
      }),
    });
    const prepared = await preparedResponse.json().catch(() => null);
    if (
      preparedResponse.status !== 409 ||
      prepared?.code !== "MEMORY_WRITE_CONFIRMATION_REQUIRED" ||
      !prepared?.confirmationId
    ) {
      throw new Error(
        prepared?.error || "Предложението не можа да бъде подготвено.",
      );
    }

    const response = await fetch("/memory/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: state.sessionId,
        confirmationId: prepared.confirmationId,
      }),
    });
    const saved = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(
        saved?.error || "Предложението не можа да бъде записано.",
      );
    }
    finishMemoryCandidateItem(item, "Записано в постоянната памет.");
    logAction("Запазено е предложение за паметта");
  } catch (error) {
    buttons.forEach((entry) => (entry.disabled = false));
    const errorNode = document.createElement("small");
    errorNode.className = "memory-candidate-error";
    errorNode.textContent = error.message;
    item.appendChild(errorNode);
  }
}

const TASK_RUN_STATUS_LABELS = Object.freeze({
  queued: "Чака планиране",
  planning: "Планиране",
  running: "Работи",
  paused: "Пауза",
  waiting_confirmation: "Чака потвърждение",
  partial: "Частично изпълнена",
  completed: "Завършена",
  failed: "Неуспешна",
  cancelled: "Отказана",
});

function taskRunStatusLabel(status) {
  return TASK_RUN_STATUS_LABELS[status] || "Неизвестен статус";
}

function renderTaskRuns(items) {
  if (!elements.taskRunList) return;
  elements.taskRunList.replaceChildren();
  if (!Array.isArray(items) || !items.length) {
    const empty = document.createElement("li");
    empty.textContent = chatText("Няма запазени изпълнения.");
    elements.taskRunList.appendChild(empty);
    return;
  }

  for (const run of items.slice(0, 10)) {
    const item = document.createElement("li");
    item.className = "task-run-item";
    const title = document.createElement("strong");
    title.textContent = run.title || chatText("AI задача");
    const status = document.createElement("small");
    status.textContent = `${taskRunStatusLabel(run.status)} · ${run.id}`;
    item.append(title, status);

    const actions = document.createElement("div");
    actions.className = "task-run-actions";
    const canPause = ["planning", "running", "partial"].includes(run.status);
    const canResume = ["paused", "partial", "failed"].includes(run.status);
    const canCancel = !["completed", "cancelled"].includes(run.status);
    for (const [action, label, enabled] of [
      ["pause", "Пауза", canPause],
      ["resume", "Продължи", canResume],
      ["cancel", "Спри", canCancel],
    ]) {
      if (!enabled) continue;
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.runId = run.id;
      button.dataset.runAction = action;
      button.textContent = label;
      actions.appendChild(button);
    }
    if (actions.childElementCount) item.appendChild(actions);
    elements.taskRunList.appendChild(item);
  }
}

async function previewKnowledgeArchive() {
  const input = document.getElementById("knowledgeArchiveInput");
  const file = input?.files?.[0];
  if (!file) {
    renderDrawerError("Първо избери JSON архив.");
    return;
  }
  if (file.size > 7_500_000) {
    renderDrawerError("Архивът е прекалено голям. Избери файл до 7,5 MB.");
    return;
  }
  try {
    const raw = JSON.parse(await file.text());
    const payload = Array.isArray(raw)
      ? { documents: raw, sessionId: state.sessionId }
      : raw && typeof raw === "object"
        ? { ...raw, sessionId: state.sessionId }
        : { documents: [], sessionId: state.sessionId };
    const response = await fetch("/memory/knowledge/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(data?.error || "Архивът не можа да бъде прегледан.");
    }
    state.knowledgePreview = Array.isArray(data?.candidates)
      ? data.candidates
      : [];
    state.knowledgeImportConfirmation = null;
    renderMemoryItems();
    logAction(
      `Прегледани са ${state.knowledgePreview.length} кандидата от архив`,
    );
  } catch (error) {
    renderDrawerError(error.message || "Невалиден JSON архив.");
  }
}

async function prepareKnowledgeArchiveImport() {
  const selectedIds = new Set(
    [...document.querySelectorAll("[data-knowledge-select]:checked")].map(
      (element) => element.dataset.knowledgeSelect,
    ),
  );
  const items = state.knowledgePreview.filter((item) =>
    selectedIds.has(item.id),
  );
  if (!items.length) {
    renderDrawerError("Избери поне един кандидат за импорт.");
    return;
  }
  try {
    const response = await fetch("/memory/knowledge/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: state.sessionId, items }),
    });
    const data = await response.json().catch(() => null);
    if (
      response.status !== 409 ||
      data?.code !== "KNOWLEDGE_IMPORT_CONFIRMATION_REQUIRED" ||
      !data.confirmationId
    ) {
      throw new Error(data?.error || "Импортът не можа да бъде подготвен.");
    }
    state.knowledgeImportConfirmation = {
      confirmationId: data.confirmationId,
      confirmationPhrase: data.confirmationPhrase || "Потвърди импорт",
    };
    state.knowledgePreview = data.items || items;
    renderMemoryItems();
  } catch (error) {
    renderDrawerError(error.message || "Импортът не можа да бъде подготвен.");
  }
}

async function confirmKnowledgeArchiveImport() {
  const confirmation = state.knowledgeImportConfirmation;
  if (!confirmation?.confirmationId) return;
  try {
    const response = await fetch("/memory/knowledge/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: state.sessionId,
        confirmationId: confirmation.confirmationId,
      }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !Array.isArray(data?.items)) {
      throw new Error(data?.error || "Импортът не можа да бъде записан.");
    }
    state.knowledgeItems = [...state.knowledgeItems, ...data.items];
    state.knowledgePreview = [];
    state.knowledgeImportConfirmation = null;
    renderMemoryItems();
    logAction(`Записани са ${data.items.length} одобрени архивни бележки`);
  } catch (error) {
    renderDrawerError(error.message || "Импортът не можа да бъде записан.");
  }
}

async function loadTaskRuns() {
  if (!elements.taskRunList) return;
  try {
    const response = await fetch("/api/task-runs?limit=10", {
      cache: "no-store",
    });
    if (!response.ok) return;
    const data = await response.json();
    renderTaskRuns(data.items);
  } catch {
    // The chat remains usable when task-run storage is temporarily unavailable.
  }
}

async function handleTaskRunAction(event) {
  const button = event.target.closest("button[data-run-action]");
  if (!button || !button.dataset.runId) return;
  button.disabled = true;
  const action = button.dataset.runAction;
  try {
    const response = await fetch(
      `/api/task-runs/${encodeURIComponent(button.dataset.runId)}/${action}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body:
          action === "pause"
            ? JSON.stringify({
                reason: "Потребителят спря задачата от панела.",
              })
            : "{}",
      },
    );
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      logAction(data?.error || "Task run действието беше отказано.");
      return;
    }
    logAction(
      action === "resume"
        ? "Task run продължи от последния checkpoint"
        : action === "pause"
          ? "Task run е поставен на пауза"
          : "Task run е спрян",
    );
    await loadTaskRuns();
  } catch {
    logAction("Task run действието временно не е достъпно.");
  } finally {
    button.disabled = false;
  }
}

async function handleMessageAction(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;

  const turn = button.closest(".assistant-turn, .user-turn");
  const message = turn?.querySelector(".message.agent, .message.user");
  const text = message?.dataset.rawText || message?.innerText || "";
  if (!text) return;

  const action = button.dataset.action;

  if (
    action === "memory-candidate-save" ||
    action === "memory-candidate-edit" ||
    action === "memory-candidate-reject"
  ) {
    const index = Number(button.dataset.memoryCandidateIndex);
    const candidate = turn?.__memoryCandidates?.[index];
    const item = button.closest(".memory-candidate-item");
    if (!candidate || !item) return;
    if (action === "memory-candidate-reject") {
      item.remove();
      if (!turn.querySelector(".memory-candidate-item")) {
        turn.querySelector(".memory-candidate-card")?.remove();
      }
      logAction("Отхвърлено е предложение за паметта");
      return;
    }
    if (action === "memory-candidate-edit") {
      const nextFact = window.prompt(
        "Редактирай точния текст преди запис:",
        candidate.fact,
      );
      if (!nextFact?.trim()) return;
      await saveMemoryCandidate(button, nextFact.trim());
      return;
    }
    await saveMemoryCandidate(button);
    return;
  }

  if (action === "retry" || action === "retry-model" || action === "edit") {
    if (state.chatBusy) return;
    const userTurn = action === "edit" ? turn : previousUserTurn(turn);
    if (!userTurn?.__request) return;
    if (action === "retry") {
      resendFrom(userTurn, userTurn.__request);
    } else if (action === "retry-model") {
      openRetryModelMenu(button, (modelId) =>
        resendFrom(userTurn, userTurn.__request, modelId),
      );
    } else {
      startEditingMessage(userTurn);
    }
    return;
  }

  if (action === "execute-council") {
    elements.chatInput.value = "Изпълни препоръката.";
    resizeChatInput();
    elements.chatInput.focus();
    await sendMessage({ councilIntentId: button.dataset.councilIntentId });
    return;
  }

  if (action === "save-google") {
    openSaveGoogleMenu(button, turn, text);
    return;
  }

  if (action === "remember") {
    openRememberForm(turn, text);
    return;
  }

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
    // Counted per model; no text is sent.
    if (button.classList.contains("active") && turn.dataset.provider) {
      void fetch("/api/feedback", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: action === "like" ? "up" : "down",
          provider: turn.dataset.provider,
          model: turn.dataset.model,
        }),
      }).catch(() => {});
    }
  }
}

// The person's question before a turn, past the page's own picture and clip
// lines.
function previousUserTurn(turn) {
  let node = turn?.previousElementSibling;
  while (node && (!node.classList.contains("user-turn") || node.classList.contains("media-turn"))) {
    node = node.previousElementSibling;
  }
  return node;
}

// The page's own picture and clip lines in the history (daily-plan.js through
// SynchronChat.remember), by the page's own mark: a typed message or an answer
// that starts with "🎨 " or "🎬 " is never one (review r2).
function isPageMediaLine(item) {
  return item?.page === true;
}

// Retry and edit replace a question and everything after it, like the big
// chat apps: the old turns leave the screen and the history sent to AI. The
// page's own pictures and clips stay, on the screen and in the history: they
// are made and paid for, and their card keeps them as made, so a yes sent
// again never makes them again.
function resendFrom(userTurn, request, modelOverride = "") {
  let removedUserTurns = 0;
  // What the removed cards made: those pictures and clips stay on screen.
  const madeBefore = new Set();
  let node = userTurn;
  while (node) {
    const next = node.nextElementSibling;
    if (!node.classList.contains("media-turn")) {
      // A question that got no answer left the history when it failed.
      if (node.classList.contains("user-turn") && !node.classList.contains("unsent-turn")) {
        removedUserTurns += 1;
      }
      for (const card of node.querySelectorAll(":scope > .media-proposals")) {
        for (const [key, value] of card.__mediaState || []) if (value === "made") madeBefore.add(key);
      }
      node.remove();
    }
    node = next;
  }
  const history = state.recentConversationMessages;
  let cut = history.length;
  for (let seen = 0; cut > 0 && seen < removedUserTurns; ) {
    cut -= 1;
    if (history[cut].role === "user" && !isPageMediaLine(history[cut])) seen += 1;
  }
  state.recentConversationMessages = [
    ...history.slice(0, cut),
    ...history.slice(cut).filter(isPageMediaLine),
  ];
  logAction(modelOverride ? "Нов опит с друг модел" : "Нов опит");
  return sendMessage({ resend: request, modelOverride, madeBefore: [...madeBefore] });
}

function openRetryModelMenu(button, onPick) {
  document.querySelector(".retry-model-menu")?.remove();
  const models = (globalThis.SynchronUi?.chatModels?.() || []).filter(
    (choice) => choice.id !== "auto" && choice.available !== false,
  );
  if (!models.length) return;
  const menu = document.createElement("div");
  menu.className = "retry-model-menu";
  menu.setAttribute("role", "menu");
  for (const choice of models) {
    const item = document.createElement("button");
    item.type = "button";
    item.setAttribute("role", "menuitem");
    item.textContent = chatText(choice.label);
    item.addEventListener("click", (event) => {
      event.stopPropagation();
      menu.remove();
      onPick(choice.id);
    });
    menu.appendChild(item);
  }
  button.closest(".message-actions")?.appendChild(menu);
  setTimeout(() => {
    document.addEventListener("click", () => menu.remove(), { once: true });
  });
}

// Saves an answer as a new Google Doc, or its tables as a Google Sheet, in
// the person's own Drive. Each account uses its own Google connection.
const ANSWER_TABLE_PATTERN = /^\s*\|.*\|\s*\n\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/mu;

// The same line the server keeps for a shared fact (avatarLinkService,
// sharedFactLine): one line, at most 500 characters, after „• “.
function avatarFactLine(fact) {
  const text = String(fact || "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 500);
  return text ? `• ${text}` : "";
}

// The server moves a shared line with its memory (corrected, replaced or
// deleted); read the visitors' text again so the share buttons show what
// visitors hear now.
async function refreshAvatarLink() {
  if (!state.avatarLink) return;
  try {
    const response = await fetch("/api/avatar-link", { cache: "no-store", credentials: "same-origin" });
    const avatar = response.ok ? await response.json() : null;
    if (avatar) state.avatarLink = { active: Boolean(avatar.active), knowledge: String(avatar.card?.knowledge || "") };
  } catch {
    // The drawer keeps the last known state; reopening reads it again.
  }
}

function isSharedWithAvatar(fact) {
  const line = avatarFactLine(fact);
  const knowledge = String(state.avatarLink?.knowledge || "");
  return Boolean(line) && knowledge.split("\n").some((entry) => entry.trim() === line);
}

// Writes one fact in the person's own memory. Pressing „Запомни“ is their
// „да“ (RADKO 28.11 04:30, 06:35), so the two steps run one after the other.
async function rememberFact(fact) {
  const preparedResponse = await fetch("/memory/profile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: state.sessionId, fact, scope: "personal" }),
  });
  const prepared = await preparedResponse.json().catch(() => null);
  if (
    preparedResponse.status !== 409 ||
    prepared?.code !== "MEMORY_WRITE_CONFIRMATION_REQUIRED" ||
    !prepared?.confirmationId
  ) {
    throw new Error(prepared?.error || chatText("Не можах да го запомня. Опитай пак."));
  }
  const response = await fetch("/memory/profile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: state.sessionId, confirmationId: prepared.confirmationId }),
  });
  const saved = await response.json().catch(() => null);
  if (!response.ok) throw new Error(saved?.error || chatText("Не можах да го запомня. Опитай пак."));
  return saved?.items?.[0]?.fact || fact;
}

// „Сподели с аватара“: the fact becomes one line of what visitors of the
// person's „Питай моя аватар“ link hear; shared=false takes it back.
async function shareWithAvatar(fact, shared = true) {
  const response = await fetch("/api/avatar-link/share", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fact, shared }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || chatText("Споделянето не стана. Опитай пак."));
  state.avatarLink = { active: Boolean(data?.active), knowledge: String(data?.card?.knowledge || "") };
  return data;
}

// The answer as one fact to start from: plain words, no marks, at most 500
// characters. The person changes it before pressing „Запомни“.
function rememberSuggestion(text) {
  return String(text || "")
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/[*_`#>|]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 500);
}

// „Запомни“ under an answer (RADKO 28.11 06:35 „бутон за паметта и за
// споделяне, ако иска“): the person decides what goes in and who hears it.
function openRememberForm(turn, text) {
  turn.querySelector(".remember-form")?.remove();
  const form = document.createElement("form");
  form.className = "remember-form";
  const field = document.createElement("textarea");
  field.maxLength = 500;
  field.rows = 3;
  field.required = true;
  field.value = rememberSuggestion(text);
  field.setAttribute("aria-label", chatText("Какво да запомня"));
  const shareLabel = document.createElement("label");
  shareLabel.className = "remember-share";
  const shareBox = document.createElement("input");
  shareBox.type = "checkbox";
  shareLabel.append(shareBox, " ", chatText("Сподели и с „Питай моя аватар“"));
  const buttons = document.createElement("div");
  buttons.className = "message-edit-buttons";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = chatText("Отказ");
  const save = document.createElement("button");
  save.type = "submit";
  save.className = "primary";
  save.textContent = chatText("Запомни");
  buttons.append(cancel, save);
  const note = document.createElement("small");
  note.className = "remember-note";
  note.setAttribute("role", "status");
  form.append(field, shareLabel, buttons, note);
  cancel.addEventListener("click", () => form.remove());
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const fact = field.value.replace(/\s+/gu, " ").trim();
    if (!fact) return;
    save.disabled = true;
    cancel.disabled = true;
    note.textContent = chatText("Запомням…");
    try {
      const saved = await rememberFact(fact);
      let message = chatText("Запомних: {fact}", { fact: saved });
      if (shareBox.checked) {
        try {
          const link = await shareWithAvatar(saved, true);
          message += " " + (link?.active
            ? chatText("Споделих го с „Питай моя аватар“.")
            : chatText("Добавих го в текста за „Питай моя аватар“; линкът ти още не е пуснат."));
        } catch (error) {
          message += " " + error.message;
        }
      }
      logAction(chatText("Запомнен е факт от отговор"));
      form.replaceChildren(note);
      note.textContent = message;
    } catch (error) {
      note.textContent = error.message;
      save.disabled = false;
      cancel.disabled = false;
    }
  });
  turn.querySelector(".message-actions")?.after(form);
  field.focus();
}

function openSaveGoogleMenu(button, turn, text) {
  document.querySelector(".retry-model-menu")?.remove();
  const menu = document.createElement("div");
  menu.className = "retry-model-menu save-google-menu";
  menu.setAttribute("role", "menu");
  const choices = [{ kind: "doc", label: "Google документ" }];
  if (ANSWER_TABLE_PATTERN.test(text)) choices.push({ kind: "sheet", label: "Google таблица" });
  for (const choice of choices) {
    const item = document.createElement("button");
    item.type = "button";
    item.setAttribute("role", "menuitem");
    item.dataset.saveKind = choice.kind;
    item.textContent = chatText(choice.label);
    item.addEventListener("click", (event) => {
      event.stopPropagation();
      menu.remove();
      void saveAnswerToGoogle(button, turn, text, choice.kind);
    });
    menu.appendChild(item);
  }
  button.closest(".message-actions")?.appendChild(menu);
  setTimeout(() => {
    document.addEventListener("click", () => menu.remove(), { once: true });
  });
}

function showSaveGoogleNote(turn, message, url = "", linkLabel = "") {
  const actions = turn.querySelector(".message-actions");
  let note = turn.querySelector(".save-google-note");
  if (!note) {
    note = document.createElement("div");
    note.className = "save-google-note";
    note.setAttribute("role", "status");
    actions?.after(note);
  }
  note.textContent = chatText(message);
  // An error may carry a "[Свържи Google](url)" link; only same-site links.
  const linked = /\[([^\]]+)\]\((https:\/\/(?:cloudaicore|novariumai)\.com\/[^)\s]*)\)/u.exec(message);
  if (linked) {
    note.textContent = chatText(message.replace(linked[0], "").trim()) + " ";
    url = linked[2];
    linkLabel = linked[1];
  }
  if (url) {
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = chatText(linkLabel || "Отвори");
    if (!/\s$/u.test(note.textContent)) note.append(" ");
    note.appendChild(link);
  }
}

async function saveAnswerToGoogle(button, turn, text, kind) {
  const question = previousUserTurn(turn)?.__request?.text || "";
  const title = (question || text).replace(/\s+/gu, " ").trim().slice(0, 80);
  button.disabled = true;
  showSaveGoogleNote(turn, "Запазвам в Google…");
  try {
    const response = await fetch("/api/google/save", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, title, text }),
    });
    const data = await response.json().catch(() => null);
    if (response.ok && data?.url) {
      showSaveGoogleNote(
        turn,
        kind === "sheet" ? "Запазено като Google таблица." : "Запазено като Google документ.",
        data.url,
        "Отвори",
      );
      logAction(kind === "sheet" ? "Отговорът е запазен като Google таблица" : "Отговорът е запазен като Google документ");
      return;
    }
    if (typeof data?.connect === "string" && data.connect.startsWith("/api/google/connect")) {
      showSaveGoogleNote(
        turn,
        "Запазването в Google иска еднократно разрешение.",
        data.connect,
        "Разреши",
      );
      return;
    }
    if (response.status === 401 && !data?.error?.includes("](")) {
      showSaveGoogleNote(turn, "Google не е свързан.", "/api/google/connect", "Свържи Google");
      return;
    }
    showSaveGoogleNote(turn, data?.error || "Google не прие файла. Опитай пак.");
  } catch {
    showSaveGoogleNote(turn, "Няма връзка. Опитай пак.");
  } finally {
    button.disabled = false;
  }
}

function startEditingMessage(userTurn) {
  if (userTurn.querySelector(".message-edit")) return;
  const message = userTurn.querySelector(".message.user");
  const editor = document.createElement("div");
  editor.className = "message-edit";
  const field = document.createElement("textarea");
  field.value = userTurn.__request.text;
  field.rows = Math.min(8, Math.max(2, field.value.split("\n").length));
  const buttons = document.createElement("div");
  buttons.className = "message-edit-buttons";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = chatText("Отказ");
  const save = document.createElement("button");
  save.type = "button";
  save.className = "primary";
  save.textContent = chatText("Изпрати");
  buttons.append(cancel, save);
  editor.append(field, buttons);
  message.hidden = true;
  userTurn.querySelector(".message-actions").hidden = true;
  userTurn.insertBefore(editor, message);
  field.focus();
  const close = () => {
    editor.remove();
    message.hidden = false;
    userTurn.querySelector(".message-actions").hidden = false;
  };
  cancel.addEventListener("click", close);
  save.addEventListener("click", () => {
    const text = field.value.trim();
    if (!text || state.chatBusy) return;
    resendFrom(userTurn, { ...userTurn.__request, text });
  });
  field.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      save.click();
    }
  });
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
  utterance.lang = chatLocale?.browserLocale || "bg-BG";
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

async function sendMessage({
  councilIntentId = "",
  resend = null,
  modelOverride = "",
  madeBefore = [],
} = {}) {
  const text = resend ? String(resend.text || "").trim() : elements.chatInput.value.trim();
  const image = resend ? resend.image || null : state.pendingImage;
  if ((!text && !image) || state.chatBusy) return;

  const messageText =
    text ||
    (image?.mimeType === "application/pdf"
      ? "Обобщи този документ."
      : "Какво виждаш на тази снимка?");
  const councilMode = resend ? false : state.councilMode;
  const councilProviders = Array.from(
    document.querySelectorAll('input[name="councilProvider"]:checked'),
    (input) => input.value,
  );
  if (councilMode && !councilProviders.length) {
    alert("Избери поне един AI двигател.");
    return;
  }
  setCouncilMode(false);
  const recentHistory = conversationWindow(state.recentConversationMessages);
  const interaction = globalThis.SynchronWorkMode?.getRequestPayload();
  const sentSessionId = state.sessionId;
  let talkReply = "";
  // The card under the answer this message replies to: the server starts
  // only the items it has not queued or made when the message is a short yes.
  const answeredCard = latestMediaCard();
  const sentTurn = appendMessage("user", messageText, image, { remember: false }).closest(".user-turn");
  const sentEntry = rememberConversationMessage("user", messageText);
  if (!resend) {
    elements.chatInput.value = "";
    resizeChatInput();
    clearPendingImage();
  }
  const abort = new AbortController();
  state.chatAbort = abort;
  logAction("Изпратено съобщение");
  showTypingIndicator();
  setChatBusy(true);

  let responseBubble = null;
  let responseActions = null;

  try {
    if (interaction?.workContext?.project.id) {
      await globalThis.SynchronWorkMode?.flushProjectContext();
    }
    const response = await fetch("/chat/chat", {
      method: "POST",
      signal: abort.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: sentSessionId,
        message: messageText,
        language: chatLocale?.language,
        image,
        council: councilMode,
        ...(councilMode ? { councilProviders } : {}),
        ...(councilIntentId ? { councilIntentId } : {}),
        recentHistory,
        ...(answeredCard ? { mediaCard: { made: busyMediaKeys(answeredCard) } } : {}),
        model: modelOverride || globalThis.SynchronUi?.chatModel?.() || "auto",
        ...(resend ? { rewrite: true } : {}),
        ...(globalThis.SynchronUi?.assistant?.()
          ? { assistant: globalThis.SynchronUi.assistant() }
          : {}),
        ...interaction,
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
      throw new Error(chatText("Сървърът върна неочакван формат."));
    }

    const assistantTurn = createAssistantTurn("", false);
    assistantTurn.turn.classList.add("chat-answer");
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
          throw new Error(describeAiError(parsed.data));
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
          globalThis.SynchronWorkMode?.onDone(parsed.data, {
            projectId: interaction?.workContext?.project.id,
            sessionId: sentSessionId,
            mode: interaction?.mode,
          });
          showAiResponseSource(
            responseBubble,
            parsed.data?.provider,
            parsed.data?.model,
            parsed.data?.linkedProjectContext,
          );
          showAnswerSources(responseBubble, parsed.data?.sources);
          if (interaction?.mode !== "work") offerTodos(responseBubble, fullText);
          showMemoryCandidates(responseBubble, parsed.data?.memoryCandidates);
          showNextStep(responseBubble, fullText, parsed.data);
          // The server's own reply to a yes: the next yes looks past it to
          // the card above when it has no card of its own.
          if (parsed.data?.mode === "media-yes") assistantTurn.turn.classList.add("media-yes-reply");
          // The answer's own pictures and video get a card. Those a short yes
          // started are queued on the card they came from and made once the
          // chat is free, after this turn.
          if (parsed.data?.media?.start === true) {
            const card = answeredCard || showMediaProposals(responseBubble, parsed.data.media, madeBefore);
            if (card) void queueMedia(card, mediaItems(parsed.data.media));
          } else {
            showMediaProposals(responseBubble, parsed.data?.media, madeBefore);
          }
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
          if (parsed.data?.mode === "council") {
            showCouncilColumns(responseBubble, parsed.data?.council);
            showCouncilExecutionAction(
              responseBubble,
              parsed.data?.councilIntentId,
            );
            logAction("Получен отговор от AI Council");
          }
          if (parsed.data?.taskRunId || parsed.data?.task?.taskRunId) {
            void loadTaskRuns();
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
      throw new Error(chatText("AI отговорът приключи неочаквано."));
    }

    rememberConversationMessage("assistant", fullText);
    responseActions.hidden = false;
    logAction("Получен AI отговор");
    talkReply = fullText;
    await loadConversations();
  } catch (error) {
    stopTalkMode();
    if (abort.signal.aborted) {
      // Stopped by the person: keep what arrived and let them retry.
      const partial = responseBubble?.dataset.rawText || responseBubble?.innerText || "";
      if (responseBubble && partial.trim()) {
        rememberConversationMessage("assistant", partial);
        if (responseActions) responseActions.hidden = false;
        responseBubble.closest(".assistant-turn")?.classList.add("is-stopped");
      } else {
        responseBubble?.closest(".assistant-turn")?.remove();
        appendMessage("agent", chatText("⏹ Спряно."), null, { remember: false });
      }
      logAction("Отговорът е спрян");
      return;
    }
    console.error(error);
    globalThis.SynchronWorkMode?.onError();
    const message = `❌ ${error?.message || chatText("Сървърна грешка. Опитай отново.")}`;
    // The question got no answer, and the error is no answer: neither goes to
    // the AI with the next message, so a „да“ typed again answers the answer
    // above them (review r2: the error line was read as that answer), and
    // retry and edit do not count the question.
    state.recentConversationMessages = state.recentConversationMessages.filter((item) => item !== sentEntry);
    sentTurn?.classList.add("unsent-turn");

    if (responseBubble) {
      responseBubble.textContent = message;
      responseBubble.dataset.rawText = message;
      if (responseActions) responseActions.hidden = true;
      // The next yes looks past this turn for the card above it.
      responseBubble.closest(".assistant-turn")?.classList.remove("chat-answer");
    } else {
      appendMessage("agent", message, null, { remember: false });
    }
    logAction("Грешка при AI отговор");
  } finally {
    if (state.chatAbort === abort) state.chatAbort = null;
    removeTypingIndicator();
    setChatBusy(false);
    elements.chatInput.focus();
    scrollChatToBottom();
  }
  if (talkReply && state.talkMode) talkSpeak(talkReply);
}

// The history sent to the AI: the last 12 turns, and among them at most 24 of
// the page's own picture and clip lines, which do not count as turns. A full
// card adds ten of them; counted as turns they pushed the request and the
// offer out, so a retry or an edit of the yes lost them (review r2). The
// server keeps the same window (normalizeRecentConversationHistory).
const RECENT_TURNS = 12;
const RECENT_PAGE_LINES = 24;

function conversationWindow(history) {
  const kept = [];
  let turns = 0;
  let pageLines = 0;
  for (let index = history.length - 1; index >= 0 && turns < RECENT_TURNS; index -= 1) {
    const item = history[index];
    if (isPageMediaLine(item)) {
      if (pageLines >= RECENT_PAGE_LINES) continue;
      pageLines += 1;
    } else {
      turns += 1;
    }
    kept.unshift(item);
  }
  return kept;
}

// Adds a turn to the history and returns its entry (null when there is
// nothing to add). options.page marks the page's own picture and clip lines.
function rememberConversationMessage(role, text, { page = false } = {}) {
  const normalizedRole = role === "agent" ? "assistant" : role;
  const content = typeof text === "string" ? text.trim() : "";
  if (
    (normalizedRole !== "user" && normalizedRole !== "assistant") ||
    !content
  ) {
    return null;
  }
  const entry = page ? { role: normalizedRole, content, page: true } : { role: normalizedRole, content };
  state.recentConversationMessages.push(entry);
  state.recentConversationMessages = conversationWindow(state.recentConversationMessages);
  return entry;
}

// options.remember: false keeps the text out of the history sent to the AI;
// options.media marks the page's own picture and clip turns (daily-plan.js),
// which get no retry or edit: those would remove a made clip and send its
// description as a chat message.
function appendMessage(role, text, image = null, options = {}) {
  if (options.remember !== false) rememberConversationMessage(role, text);
  if (role === "agent") {
    const assistantTurn = createAssistantTurn(text, true);
    if (options.media) {
      assistantTurn.turn.classList.add("media-turn");
      assistantTurn.actions
        .querySelectorAll('[data-action="retry"], [data-action="retry-model"]')
        .forEach((button) => button.remove());
    }
    scrollChatToBottom();
    return assistantTurn.message;
  }

  const turn = document.createElement("div");
  turn.className = "user-turn";

  const div = document.createElement("div");
  div.className = `message ${role}`;
  div.dataset.rawText = text;
  if (image?.dataUrl && image.mimeType === "application/pdf") {
    const file = document.createElement("div");
    file.className = "message-file";
    file.textContent = `📄 ${image.name || "документ.pdf"}`;
    div.appendChild(file);
  } else if (image?.dataUrl) {
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
        <button type="button" data-action="copy" title="${localizedMarkup("Копирай")}" aria-label="${localizedMarkup("Копирай")}">
            <i class="fa-regular fa-copy"></i>
            <span class="action-label">${localizedMarkup("Копирай")}</span>
        </button>
        ${options.media ? "" : `<button type="button" data-action="edit" title="${localizedMarkup("Редактирай")}" aria-label="${localizedMarkup("Редактирай")}">
            <i class="fa-solid fa-pen"></i>
        </button>`}
    `;

  if (options.media) turn.classList.add("media-turn");
  else turn.__request = { text, image };
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
    const [response, integrationsResponse] = await Promise.all([
      fetch("/health", { cache: "no-store" }),
      fetch("/health/integrations", { cache: "no-store" }).catch(() => null),
    ]);
    setServerStatus(response.ok);
    if (!elements.activeIntegrationsDisplay) return;
    if (!integrationsResponse?.ok) {
      elements.activeIntegrationsDisplay.textContent =
        "Проверката не е достъпна";
      elements.activeIntegrationsDisplay.className =
        "context-value status-yellow";
      return;
    }
    const data = await integrationsResponse.json().catch(() => ({}));
    const active = (Array.isArray(data.tools) ? data.tools : [])
      .filter((tool) => tool.enabled && tool.executable && tool.configured)
      .map((tool) => tool.name)
      .filter(Boolean);
    elements.activeIntegrationsDisplay.textContent = active.length
      ? active.join(" · ")
      : "Няма потвърдени връзки";
    elements.activeIntegrationsDisplay.className = `context-value ${active.length ? "status-green" : "status-yellow"}`;
  } catch {
    setServerStatus(false);
    if (elements.activeIntegrationsDisplay) {
      elements.activeIntegrationsDisplay.textContent =
        "Проверката не е достъпна";
      elements.activeIntegrationsDisplay.className =
        "context-value status-yellow";
    }
  }
}

function setServerStatus(isOnline) {
  state.serverOnline = isOnline;
  elements.agentStatusDot.className = isOnline ? "online" : "offline";
  elements.agentStatusText.textContent = isOnline
    ? chatText("Сървър онлайн")
    : chatText("Сървър офлайн");
  elements.serverStatusDisplay.textContent = isOnline ? chatText("Онлайн") : chatText("Офлайн");
  elements.serverStatusDisplay.className = `context-value ${isOnline ? "status-green" : "status-red"}`;
}

function logAction(actionName) {
  const time = new Date().toLocaleTimeString(chatLocale?.browserLocale || "bg-BG", {
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
    item.textContent = chatText("Няма скорошни действия");
    elements.actionsLog.appendChild(item);
    return;
  }

  for (const action of state.lastActions) {
    const item = document.createElement("li");
    item.textContent = action;
    elements.actionsLog.appendChild(item);
  }
}

window.addEventListener("load", async () => {
  await chatLocale?.ready;
  await init();
});
