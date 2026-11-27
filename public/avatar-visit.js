(() => {
  // A visitor talks to someone's avatar through the link they were given.
  const token = location.pathname.split("/").filter(Boolean)[1] || "";
  const $ = (id) => document.getElementById(id);
  const list = $("avatarMessages");
  const form = $("avatarAsk");
  const input = $("avatarQuestion");
  const status = (text) => ($("avatarStatus").textContent = text || "");
  const history = [];
  let name = "";

  const render = (element, value) => {
    if (globalThis.SynchronMarkdown?.renderSafeMarkdown) globalThis.SynchronMarkdown.renderSafeMarkdown(element, value);
    else element.textContent = value;
  };
  const add = (role, text) => {
    const item = document.createElement("article");
    item.className = `shared-message ${role === "user" ? "user" : "agent"}`;
    const who = document.createElement("div");
    who.className = "shared-who";
    who.textContent = role === "user" ? "Ти" : `Аватарът на ${name}`;
    const body = document.createElement("div");
    body.className = "shared-body";
    if (role === "user") body.textContent = text;
    else render(body, text);
    item.append(who, body);
    list.appendChild(item);
    item.scrollIntoView({ block: "end", behavior: "smooth" });
    return body;
  };

  const api = async (path, options) => {
    const response = await fetch(`/api/avatar-visit/${encodeURIComponent(token)}${path}`, { credentials: "omit", ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Аватарът не е достъпен.");
    return data;
  };

  api("")
    .then((card) => {
      name = card.name || "човека";
      $("avatarName").textContent = `Питай аватара на ${name}`;
      document.title = `Аватарът на ${name} · Novarium`;
      $("avatarIntro").textContent = card.intro || "";
      add("agent", `Здравей! Аз съм AI аватарът на ${name}. Питай ме нещо. Знам само това, което ${name} ми е разрешил да казвам.`);
      form.hidden = false;
      input.focus();
    })
    .catch((error) => {
      $("avatarName").textContent = "Аватарът не е достъпен";
      status(error.message);
    });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const question = input.value.trim();
    if (!question || form.dataset.busy) return;
    form.dataset.busy = "1";
    input.value = "";
    add("user", question);
    const bubble = add("agent", "…");
    try {
      const { answer } = await api("/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, history: history.slice(-6) }),
      });
      render(bubble, answer);
      history.push({ role: "user", content: question }, { role: "assistant", content: answer });
    } catch (error) {
      bubble.textContent = error.message;
    } finally {
      delete form.dataset.busy;
      input.focus();
    }
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
})();
