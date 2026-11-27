(() => {
  // "Каузи": propose a social cause and show with a like where you would want
  // the money to go. Only a list and votes; no money moves here.
  const text = (value) => globalThis.NovariumLocale?.text?.(value) ?? value;

  const dialog = document.createElement("div");
  dialog.className = "share-dialog causes-dialog";
  dialog.hidden = true;
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.innerHTML = `
    <div class="share-card">
      <div class="share-head"><h2></h2><button type="button" class="share-close" aria-label="${text("Затвори")}">✕</button></div>
      <p class="share-note"></p>
      <ul class="causes-list"></ul>
      <form class="causes-form">
        <input type="text" maxlength="90" required />
        <textarea rows="3" maxlength="800" required></textarea>
        <button type="submit" class="primary"></button>
      </form>
      <p class="share-status" role="status"></p>
    </div>`;
  document.body.appendChild(dialog);
  const $ = (selector) => dialog.querySelector(selector);
  $("h2").textContent = text("Каузи");
  $(".share-note").textContent = text(
    "Ползването е безплатно. Идеята е всичко над реалните разходи да отива за каузи, които хората сами избират. Тук всеки може да предложи кауза и да покаже с харесване къде иска да отидат парите. Засега това е само списък и гласове; пари още не се събират и не се движат.",
  );
  $(".causes-form input").placeholder = text("Име на каузата");
  $(".causes-form textarea").placeholder = text("Какво ще се направи, за кого и защо");
  $(".causes-form button").textContent = text("Предложи кауза");
  const status = (message) => ($(".share-status").textContent = message || "");

  let moderator = false;
  const call = async (method, path = "", body) => {
    const response = await fetch(`/api/causes${path}`, {
      method,
      credentials: "same-origin",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || text("Нещо се обърка. Опитай отново."));
    moderator = data.moderator === true;
    return data.causes || [];
  };
  const act = async (work, done = "") => {
    try {
      render(await work());
      status(done);
    } catch (error) {
      status(error.message);
    }
  };
  const button = (label, className, onClick) => {
    const element = document.createElement("button");
    element.type = "button";
    element.className = className;
    element.textContent = label;
    element.addEventListener("click", onClick);
    return element;
  };
  function render(causes) {
    const list = $(".causes-list");
    if (!causes.length) {
      const empty = document.createElement("li");
      empty.className = "knowledge-empty";
      empty.textContent = text("Още няма каузи. Предложи първата.");
      list.replaceChildren(empty);
      return;
    }
    list.replaceChildren(
      ...causes.map((cause) => {
        const item = document.createElement("li");
        if (cause.hidden) item.classList.add("cause-hidden");
        const body = document.createElement("div");
        const title = document.createElement("strong");
        title.textContent = cause.title;
        const description = document.createElement("p");
        description.textContent = cause.description;
        const author = document.createElement("small");
        author.textContent = `${text("Предложена от")} ${cause.author}${cause.hidden ? ` · ${text("скрита")}` : ""}`;
        body.append(title, description, author);
        if (cause.project) {
          const project = document.createElement("details");
          project.className = "cause-project";
          const summary = document.createElement("summary");
          summary.textContent = text("Проект, подготвен от агента");
          const content = document.createElement("div");
          content.className = "cause-project-text";
          content.textContent = cause.project;
          project.append(summary, content);
          body.append(project);
        } else {
          body.append(
            button(text("Подготви проект"), "cause-prepare", (event) => {
              event.currentTarget.disabled = true;
              status(text("Агентът подготвя проекта… това отнема до минута."));
              act(
                () => call("POST", `/${encodeURIComponent(cause.id)}/prepare`),
                text("Проектът е готов. Отвори „Проект, подготвен от агента“."),
              );
            }),
          );
        }
        const actions = document.createElement("div");
        actions.className = "cause-actions";
        const like = button(`❤ ${cause.likes}`, `cause-like${cause.liked ? " on" : ""}`, () =>
          act(() => call("POST", `/${encodeURIComponent(cause.id)}/like`, { on: !cause.liked })),
        );
        like.setAttribute("aria-pressed", String(cause.liked));
        like.setAttribute("aria-label", `${text("Харесай")}: ${cause.title}`);
        actions.append(like);
        if (cause.mine) {
          actions.append(
            button(text("Изтрий"), "cause-remove", () =>
              act(() => call("DELETE", `/${encodeURIComponent(cause.id)}`), text("Каузата е изтрита.")),
            ),
          );
        } else if (moderator) {
          actions.append(
            button(cause.hidden ? text("Покажи") : text("Скрий"), "cause-remove", () =>
              act(() => call("DELETE", `/${encodeURIComponent(cause.id)}`)),
            ),
          );
        }
        item.append(body, actions);
        return item;
      }),
    );
  }

  $(".causes-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const title = $(".causes-form input");
    const description = $(".causes-form textarea");
    status(text("Изпращане…"));
    act(async () => {
      const causes = await call("POST", "", { title: title.value, description: description.value });
      title.value = "";
      description.value = "";
      return causes;
    }, text("Каузата е предложена."));
  });
  const close = () => (dialog.hidden = true);
  $(".share-close").addEventListener("click", close);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !dialog.hidden) close();
  });
  document.addEventListener("novarium:causes", () => {
    dialog.hidden = false;
    status(text("Зареждане…"));
    act(() => call("GET"));
  });
})();
