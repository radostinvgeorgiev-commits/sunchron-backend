(() => {
  const list = document.getElementById("sharedMessages");
  const title = document.getElementById("sharedTitle");
  const meta = document.getElementById("sharedMeta");
  const token = location.pathname.split("/").filter(Boolean)[1] || "";

  const render = (element, value) => {
    if (globalThis.SynchronMarkdown?.renderSafeMarkdown) {
      globalThis.SynchronMarkdown.renderSafeMarkdown(element, value);
    } else {
      element.textContent = value;
    }
  };

  fetch(`/api/shared/${encodeURIComponent(token)}`, { credentials: "omit" })
    .then(async (response) => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Връзката не може да се отвори.");
      return data;
    })
    .then((data) => {
      if (data.title) {
        title.textContent = data.title;
        document.title = `${data.title} · NovariumAI`;
      }
      if (data.createdAt) {
        meta.textContent = `Споделен на ${new Date(data.createdAt).toLocaleDateString("bg-BG", {
          day: "numeric",
          month: "long",
          year: "numeric",
        })}`;
      }
      list.replaceChildren(
        ...data.messages.map((message) => {
          const item = document.createElement("article");
          item.className = `shared-message ${message.role === "user" ? "user" : "agent"}`;
          const who = document.createElement("div");
          who.className = "shared-who";
          who.textContent = message.role === "user" ? "Човек" : "NovariumAI";
          const body = document.createElement("div");
          body.className = "shared-body";
          if (message.role === "user") body.textContent = message.content;
          else render(body, message.content);
          item.append(who, body);
          return item;
        }),
      );
    })
    .catch((error) => {
      title.textContent = "Разговорът не е достъпен";
      list.textContent = error.message;
    });
})();
