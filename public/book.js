(() => {
  // "Писател": the memory of a book. The AI only suggests facts; a fact is
  // kept when the person saves it. A chapter check shows the two lines side
  // by side and the person decides: a mistake, or an intended change.
  const text = (value) => globalThis.NovariumLocale?.text?.(value) ?? value;
  const KINDS = [
    ["character", "Герой"],
    ["place", "Място"],
    ["rule", "Правило на света"],
    ["event", "Събитие"],
  ];
  // Each specialist keeps its own project memory: the writer keeps the
  // book's words, the others name things in their own field.
  let domain = "writer";
  let profile = null;
  const pick = (writerWords, otherWords) => text(domain === "writer" ? writerWords : otherWords);
  const kinds = () => (domain === "writer" || !profile?.kinds ? KINDS : KINDS.map(([id]) => [id, profile.kinds[id] || id]));
  const kindLabel = (kind) => text((kinds().find(([id]) => id === kind) || kinds()[3])[1]);
  const dialog = document.createElement("div");
  dialog.className = "share-dialog book-dialog";
  dialog.hidden = true;
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.innerHTML = `
    <div class="share-card book-card">
      <div class="share-head"><h2></h2><button type="button" class="share-close"></button></div>
      <p class="share-note book-intro"></p>
      <div class="book-pick">
        <select class="book-select"></select>
        <button type="button" class="book-delete"></button>
      </div>
      <form class="book-new">
        <input class="book-new-title" type="text" maxlength="120" autocomplete="off" />
        <button type="submit"></button>
      </form>
      <div class="book-body" hidden>
        <div class="book-tabs" role="tablist">
          <button type="button" role="tab" data-tab="facts" aria-selected="true"></button>
          <button type="button" role="tab" data-tab="check" aria-selected="false"></button>
          <button type="button" role="tab" data-tab="chapters" aria-selected="false"></button>
        </div>
        <section class="book-pane" data-pane="facts">
          <ul class="book-facts"></ul>
          <form class="book-add">
            <select class="book-add-kind"></select>
            <input class="book-add-name" type="text" maxlength="80" autocomplete="off" />
            <input class="book-add-text" type="text" maxlength="400" autocomplete="off" />
            <input class="book-add-chapter" type="number" min="1" max="999" inputmode="numeric" />
            <button type="submit"></button>
          </form>
          <details class="book-extract">
            <summary></summary>
            <textarea class="book-extract-text" rows="5" maxlength="50000"></textarea>
            <div class="share-actions">
              <input class="book-extract-chapter" type="number" min="1" max="999" inputmode="numeric" />
              <button type="button" class="book-extract-run primary"></button>
            </div>
            <div class="book-suggestions" hidden>
              <ul></ul>
              <div class="share-actions"><button type="button" class="book-keep primary"></button></div>
            </div>
          </details>
        </section>
        <section class="book-pane" data-pane="check" hidden>
          <div class="share-actions">
            <input class="book-check-chapter" type="number" min="1" max="999" inputmode="numeric" />
          </div>
          <textarea class="book-check-text" rows="8" maxlength="50000"></textarea>
          <div class="share-actions"><button type="button" class="book-check-run primary"></button></div>
          <div class="book-result" hidden>
            <p class="book-score"></p>
            <ul class="book-issues"></ul>
          </div>
        </section>
        <section class="book-pane" data-pane="chapters" hidden>
          <ul class="book-chapters"></ul>
          <form class="book-chapter-form">
            <div class="book-row">
              <input class="book-chapter-number" type="number" min="1" max="999" inputmode="numeric" required />
              <input class="book-chapter-title" type="text" maxlength="120" autocomplete="off" />
            </div>
            <textarea class="book-chapter-text" rows="8" maxlength="50000"></textarea>
            <div class="share-actions"><button type="submit" class="primary book-chapter-save"></button></div>
          </form>
          <details class="book-draft">
            <summary></summary>
            <textarea class="book-draft-plan" rows="4" maxlength="4000"></textarea>
            <div class="share-actions"><button type="button" class="primary book-draft-run"></button></div>
            <p class="book-draft-check"></p>
          </details>
          <details class="book-upload">
            <summary></summary>
            <p class="share-note book-upload-note"></p>
            <input class="book-upload-file" type="file" accept=".txt,.md,.docx,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document" />
            <div class="book-upload-preview" hidden>
              <p class="book-upload-count"></p>
              <div class="share-actions"><button type="button" class="primary book-upload-save"></button></div>
            </div>
          </details>
          <div class="book-export">
            <span class="book-export-title"></span>
            <a class="book-export-docx" download>Word (DOCX)</a>
            <a class="book-export-epub" download>EPUB</a>
            <a class="book-export-pdf" target="_blank" rel="noopener">PDF</a>
          </div>
        </section>
      </div>
      <p class="share-status" role="status"></p>
    </div>`;
  document.body.appendChild(dialog);
  const $ = (selector) => dialog.querySelector(selector);
  const applyWords = () => {
  $("h2").textContent = text(domain === "writer" ? "Паметта на книгата" : profile?.memory || "Паметта на проекта");
  $(".share-close").textContent = "✕";
  $(".share-close").setAttribute("aria-label", text("Затвори"));
  $(".book-intro").textContent = pick(
    "Тук се пазят героите, местата, правилата и събитията на книгата ти. Аватарът само предлага; факт влиза в паметта, когато го запазиш. Паметта е само твоя.",
    "Тук се пазят важните факти по проекта ти. Аватарът само предлага; факт влиза в паметта, когато го запазиш. Паметта е само твоя.",
  );
  $(".book-select").setAttribute("aria-label", pick("Книга", "Проект"));
  $(".book-delete").textContent = pick("Изтрий книгата", "Изтрий проекта");
  $(".book-new-title").placeholder = pick("Име на нова книга", "Име на нов проект");
  $(".book-new button").textContent = pick("Нова книга", "Нов проект");
  $('[data-tab="facts"]').textContent = text("Факти");
  $('[data-tab="check"]').textContent = pick("Провери глава", "Провери текст");
  $(".book-add-kind").replaceChildren(
    ...kinds().map(([id, label]) => {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = text(label);
      return option;
    }),
  );
  $(".book-add-kind").setAttribute("aria-label", text("Вид"));
  $(".book-add-name").placeholder = pick("Име (напр. Мила)", "Име");
  $(".book-add-text").placeholder = pick("Фактът (напр. Мила има зелени очи)", "Фактът в едно изречение");
  $(".book-add-chapter").placeholder = pick("От глава", "От част");
  $(".book-add-chapter").setAttribute("aria-label", pick("От глава", "От част"));
  $(".book-add button").textContent = text("Запази факта");
  $(".book-extract summary").textContent = text("Извади факти от текст");
  $(".book-extract-text").placeholder = pick("Постави глава или откъс. Аватарът ще предложи факти, а ти избираш кои да запазиш.", "Постави текст или откъс. Аватарът ще предложи факти, а ти избираш кои да запазиш.");
  $(".book-extract-chapter").placeholder = pick("Глава", "Част");
  $(".book-extract-chapter").setAttribute("aria-label", pick("Глава", "Част"));
  $(".book-extract-run").textContent = text("Предложи факти");
  $(".book-keep").textContent = text("Запази избраните");
  $(".book-check-chapter").placeholder = pick("Номер на главата", "Номер на частта");
  $(".book-check-chapter").setAttribute("aria-label", pick("Номер на главата", "Номер на частта"));
  $(".book-check-text").placeholder = pick("Постави текста на главата.", "Постави текста.");
  $(".book-check-run").textContent = pick("Провери главата", "Провери текста");
  $('[data-tab="chapters"]').textContent = pick("Глави", "Части");
  $(".book-chapter-number").placeholder = pick("Глава", "Част");
  $(".book-chapter-number").setAttribute("aria-label", pick("Номер на главата", "Номер на частта"));
  $(".book-chapter-title").placeholder = text("Заглавие (по желание)");
  $(".book-chapter-text").placeholder = pick("Текстът на главата.", "Текстът на частта.");
  $(".book-chapter-save").textContent = pick("Запази главата", "Запази частта");
  $(".book-draft summary").textContent = text("Напиши чернова по план");
  $(".book-draft-plan").placeholder = pick("Какво става в главата: кой, къде, какво. Черновата спазва паметта на книгата и се проверява, преди да я видиш.", "Какво трябва да има в тази част. Черновата спазва паметта на проекта и се проверява, преди да я видиш.");
  $(".book-draft-run").textContent = text("Напиши чернова");
  $(".book-upload summary").textContent = pick("Качи ръкопис", "Качи файл");
  $(".book-upload-note").textContent = pick("Файл .docx или .txt. Разделям го на глави по заглавията „Глава 1“, „Глава 2“… Нищо не се пази, докато не натиснеш „Запази главите“.", "Файл .docx или .txt. Разделям го на части по заглавията „Част 1“, „Раздел 2“, „Урок 3“… Нищо не се пази, докато не натиснеш „Запази частите“.");
  $(".book-upload-save").textContent = pick("Запази главите", "Запази частите");
  $(".book-export-title").textContent = pick("Изтегли книгата:", "Изтегли проекта:");
  };
  applyWords();
  const status = (message) => ($(".share-status").textContent = message || "");

  let books = [];
  let currentId = "";
  const current = () => books.find((book) => book.id === currentId) || null;

  const call = async (method, path = "", body) => {
    const response = await fetch(`/api/books${path}`, {
      method,
      credentials: "same-origin",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || text("Нещо се обърка. Опитай отново."));
    return data;
  };
  const run = async (work, busy) => {
    status(busy);
    try {
      await work();
      status("");
    } catch (error) {
      status(error.message);
    }
  };
  const bookPath = (suffix = "") => `/${encodeURIComponent(currentId)}${suffix}`;
  const chapterOf = (selector) => {
    const value = Number.parseInt($(selector).value, 10);
    return Number.isInteger(value) && value > 0 ? value : undefined;
  };
  const range = (fact) =>
    fact.untilChapter
      ? `${pick("гл.", "ч.")} ${fact.fromChapter || 1}–${fact.untilChapter}`
      : `${pick("от гл.", "от ч.")} ${fact.fromChapter || 1}`;

  const renderFacts = () => {
    const book = current();
    const facts = book?.facts || [];
    $(".book-facts").replaceChildren(
      ...facts.map((fact) => {
        const row = document.createElement("li");
        row.className = `book-fact${fact.untilChapter ? " book-fact-old" : ""}`;
        const kind = document.createElement("small");
        kind.className = "book-kind";
        kind.textContent = `${kindLabel(fact.kind)} · ${range(fact)}`;
        const words = document.createElement("span");
        words.textContent = fact.name ? `${fact.name}: ${fact.text}` : fact.text;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "todo-remove book-fact-remove";
        remove.dataset.id = fact.id;
        remove.textContent = "✕";
        remove.setAttribute("aria-label", text("Изтрий факта"));
        row.append(kind, words, remove);
        return row;
      }),
    );
    if (!facts.length) {
      const empty = document.createElement("li");
      empty.className = "todo-empty";
      empty.textContent = pick("Паметта на тази книга е празна. Добави първия факт или го извади от текст.", "Паметта на този проект е празна. Добави първия факт или го извади от текст.");
      $(".book-facts").appendChild(empty);
    }
  };
  const renderBooks = () => {
    if (!books.some((book) => book.id === currentId)) currentId = books[0]?.id || "";
    $(".book-select").replaceChildren(
      ...books.map((book) => {
        const option = document.createElement("option");
        option.value = book.id;
        option.textContent = book.title;
        return option;
      }),
    );
    $(".book-select").value = currentId;
    $(".book-pick").hidden = !books.length;
    $(".book-body").hidden = !books.length;
    $(".book-chapter-number").value = "";
    renderFacts();
    renderChapters();
  };
  const renderChapters = () => {
    const book = current();
    const chapters = book?.chapters || [];
    $(".book-chapters").replaceChildren(
      ...chapters.map((chapter) => {
        const row = document.createElement("li");
        row.className = "book-chapter";
        const open = document.createElement("button");
        open.type = "button";
        open.className = "book-chapter-open";
        open.dataset.number = String(chapter.number);
        open.textContent = `${chapter.number}. ${chapter.title || pick("Глава", "Част")} · ${chapter.words} ${text("думи")}`;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "todo-remove book-chapter-remove";
        remove.dataset.number = String(chapter.number);
        remove.textContent = "✕";
        remove.setAttribute("aria-label", pick("Изтрий главата", "Изтрий частта"));
        row.append(open, remove);
        return row;
      }),
    );
    if (!chapters.length) {
      const empty = document.createElement("li");
      empty.className = "todo-empty";
      empty.textContent = pick("Още няма глави. Напиши, качи ръкопис или поискай чернова.", "Още няма части. Напиши, качи файл или поискай чернова.");
      $(".book-chapters").appendChild(empty);
    }
    const base = book ? `/api/books/${encodeURIComponent(book.id)}/export?format=` : "";
    $(".book-export").hidden = !chapters.length;
    $(".book-export-docx").href = `${base}docx`;
    $(".book-export-epub").href = `${base}epub`;
    $(".book-export-pdf").href = `${base}html`;
    const next = chapters.length ? chapters.at(-1).number + 1 : 1;
    if (!$(".book-chapter-number").value) $(".book-chapter-number").value = String(next);
  };
  const replaceBook = (book) => {
    books = books.map((item) => (item.id === book.id ? book : item));
    renderFacts();
    renderChapters();
  };

  $(".book-select").addEventListener("change", () => {
    currentId = $(".book-select").value;
    $(".book-result").hidden = true;
    $(".book-chapter-number").value = "";
    renderFacts();
    renderChapters();
  });
  $(".book-new").addEventListener("submit", (event) => {
    event.preventDefault();
    const title = $(".book-new-title").value.trim();
    if (!title) return;
    void run(async () => {
      const { book } = await call("POST", "", { title, domain });
      books = [book, ...books];
      currentId = book.id;
      $(".book-new-title").value = "";
      renderBooks();
    }, text("Записване…"));
  });
  // Deleting a whole book takes a second press on the same button.
  let armed = false;
  $(".book-delete").addEventListener("click", () => {
    if (!currentId) return;
    if (!armed) {
      armed = true;
      $(".book-delete").textContent = text("Натисни пак, за да изтриеш");
      setTimeout(() => {
        armed = false;
        $(".book-delete").textContent = pick("Изтрий книгата", "Изтрий проекта");
      }, 4000);
      return;
    }
    armed = false;
    $(".book-delete").textContent = pick("Изтрий книгата", "Изтрий проекта");
    void run(async () => {
      // The server answers with every project of the person; this panel
      // shows only the open specialist's (an old book belongs to the writer).
      books = ((await call("DELETE", bookPath())).books || []).filter((book) => (book.domain || "writer") === domain);
      renderBooks();
    }, text("Изтриване…"));
  });
  dialog.querySelectorAll("[data-tab]").forEach((tab) =>
    tab.addEventListener("click", () => {
      dialog.querySelectorAll("[data-tab]").forEach((item) => item.setAttribute("aria-selected", String(item === tab)));
      dialog.querySelectorAll("[data-pane]").forEach((pane) => (pane.hidden = pane.dataset.pane !== tab.dataset.tab));
    }),
  );
  $(".book-facts").addEventListener("click", (event) => {
    const button = event.target.closest(".book-fact-remove");
    if (button)
      void run(async () => replaceBook((await call("DELETE", bookPath(`/facts/${encodeURIComponent(button.dataset.id)}`))).book), "");
  });
  $(".book-add").addEventListener("submit", (event) => {
    event.preventDefault();
    const fact = {
      kind: $(".book-add-kind").value,
      name: $(".book-add-name").value.trim(),
      text: $(".book-add-text").value.trim(),
      fromChapter: chapterOf(".book-add-chapter"),
    };
    if (!fact.text) {
      status(text("Напиши факта."));
      return;
    }
    void run(async () => {
      replaceBook((await call("POST", bookPath("/facts"), { facts: [fact] })).book);
      $(".book-add-name").value = "";
      $(".book-add-text").value = "";
    }, text("Записване…"));
  });

  let suggestions = [];
  $(".book-extract-run").addEventListener("click", () => {
    const source = $(".book-extract-text").value.trim();
    if (!source) {
      status(pick("Постави текст от книгата.", "Постави текст."));
      return;
    }
    void run(async () => {
      suggestions = (await call("POST", bookPath("/suggest"), { text: source, chapter: chapterOf(".book-extract-chapter") })).suggestions || [];
      if (!suggestions.length) throw new Error(text("Не намерих факти в текста."));
      $(".book-suggestions ul").replaceChildren(
        ...suggestions.map((fact, index) => {
          const row = document.createElement("li");
          const label = document.createElement("label");
          const box = document.createElement("input");
          box.type = "checkbox";
          box.checked = true;
          box.value = String(index);
          const words = document.createElement("span");
          words.textContent = `${kindLabel(fact.kind)} · ${fact.name ? `${fact.name}: ` : ""}${fact.text}`;
          label.append(box, words);
          row.appendChild(label);
          return row;
        }),
      );
      $(".book-suggestions").hidden = false;
    }, text("Чета текста…"));
  });
  $(".book-keep").addEventListener("click", () => {
    const chosen = [...dialog.querySelectorAll(".book-suggestions input:checked")].map((box) => suggestions[Number(box.value)]).filter(Boolean);
    if (!chosen.length) {
      status(text("Избери поне един факт."));
      return;
    }
    void run(async () => {
      replaceBook((await call("POST", bookPath("/facts"), { facts: chosen })).book);
      $(".book-suggestions").hidden = true;
      $(".book-extract-text").value = "";
    }, text("Записване…"));
  });

  const quoteLine = (label, words, className) => {
    const line = document.createElement("p");
    line.className = className;
    const strong = document.createElement("strong");
    strong.textContent = `${label} `;
    const span = document.createElement("span");
    span.textContent = words;
    line.append(strong, span);
    return line;
  };
  const renderIssues = (result) => {
    const { score, issues = [], models, chapter } = result;
    $(".book-score").textContent = `${text("Съвпадение с паметта")}: ${score}/100 · ${
      issues.length ? `${text("противоречия")}: ${issues.length}` : text("няма противоречия")
    } · ${models === 2 ? text("проверено от два модела") : text("проверено от един модел")}`;
    $(".book-issues").replaceChildren(
      ...issues.map((issue) => {
        const row = document.createElement("li");
        row.className = "book-issue";
        row.append(
          quoteLine(`${text("Паметта")} (${kindLabel(issue.kind)}, ${pick("от гл.", "от ч.")} ${issue.fromChapter}):`, issue.name ? `${issue.name}: ${issue.fact}` : issue.fact, "book-issue-fact"),
          quoteLine(`${pick("Главата", "Текстът")}:`, `„${issue.quote}“`, "book-issue-quote"),
        );
        if (issue.why) {
          const why = document.createElement("p");
          why.className = "book-issue-why";
          why.textContent = issue.why;
          row.appendChild(why);
        }
        const actions = document.createElement("div");
        actions.className = "share-actions";
        const mistake = document.createElement("button");
        mistake.type = "button";
        mistake.textContent = text("Грешка, ще я поправя");
        mistake.addEventListener("click", () => {
          row.classList.add("book-issue-done");
          actions.replaceChildren(Object.assign(document.createElement("small"), { textContent: text("Отбелязано. Паметта остава същата.") }));
        });
        const change = document.createElement("button");
        change.type = "button";
        change.className = "primary";
        change.textContent = text("Нарочна промяна");
        change.addEventListener("click", () => {
          const form = document.createElement("form");
          form.className = "book-change";
          const input = document.createElement("input");
          input.type = "text";
          input.maxLength = 400;
          input.value = issue.fact;
          input.setAttribute("aria-label", text("Какво е новото"));
          const save = document.createElement("button");
          save.type = "submit";
          save.className = "primary";
          save.textContent = chapter > 1 ? `${pick("Запази от глава", "Запази от част")} ${chapter}` : text("Запази промяната");
          form.append(input, save);
          form.addEventListener("submit", (event) => {
            event.preventDefault();
            if (!chapter || chapter < 2) {
              status(pick("Напиши номера на главата (2 или повече), за да запазиш промяна.", "Напиши номера на частта (2 или повече), за да запазиш промяна."));
              return;
            }
            void run(async () => {
              replaceBook(
                (await call("POST", bookPath(`/facts/${encodeURIComponent(issue.factId)}/change`), { chapter, text: input.value, quote: issue.quote })).book,
              );
              row.classList.add("book-issue-done");
              actions.replaceChildren(Object.assign(document.createElement("small"), { textContent: `${pick("Паметта е обновена от глава", "Паметта е обновена от част")} ${chapter}.` }));
            }, text("Записване…"));
          });
          actions.replaceChildren(form);
          input.focus();
        });
        actions.append(mistake, change);
        row.appendChild(actions);
        return row;
      }),
    );
    $(".book-result").hidden = false;
  };
  $(".book-check-run").addEventListener("click", () => {
    const source = $(".book-check-text").value.trim();
    if (!source) {
      status(pick("Постави текста на главата.", "Постави текста."));
      return;
    }
    void run(async () => {
      renderIssues((await call("POST", bookPath("/check"), { text: source, chapter: chapterOf(".book-check-chapter") })).result);
    }, pick("Проверявам главата…", "Проверявам текста…"));
  });

  // Chapters: open one into the editor, save, delete.
  $(".book-chapters").addEventListener("click", (event) => {
    const open = event.target.closest(".book-chapter-open");
    const remove = event.target.closest(".book-chapter-remove");
    if (open)
      void run(async () => {
        const { chapter } = await call("GET", bookPath(`/chapters/${open.dataset.number}`));
        $(".book-chapter-number").value = String(chapter.number);
        $(".book-chapter-title").value = chapter.title;
        $(".book-chapter-text").value = chapter.text;
        $(".book-chapter-text").focus();
      }, text("Зареждане…"));
    if (remove)
      void run(async () => replaceBook((await call("DELETE", bookPath(`/chapters/${remove.dataset.number}`))).book), text("Изтриване…"));
  });
  $(".book-chapter-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const chapter = {
      number: chapterOf(".book-chapter-number"),
      title: $(".book-chapter-title").value.trim(),
      text: $(".book-chapter-text").value,
    };
    if (!chapter.number || !chapter.text.trim()) {
      status(pick("Напиши номера и текста на главата.", "Напиши номера и текста на частта."));
      return;
    }
    void run(async () => {
      replaceBook((await call("POST", bookPath("/chapters"), { chapters: [chapter] })).book);
      status(`${pick("Главата е запазена", "Частта е запазена")}: ${chapter.number}`);
    }, text("Записване…"));
  });
  // A draft fills the editor and shows its check; it is saved only with
  // "Запази главата".
  $(".book-draft-run").addEventListener("click", () => {
    const number = chapterOf(".book-chapter-number");
    const plan = $(".book-draft-plan").value.trim();
    if (!number || !plan) {
      status(pick("Напиши номера на главата и плана.", "Напиши номера на частта и плана."));
      return;
    }
    void run(async () => {
      const { draft } = await call("POST", bookPath("/draft"), { number, plan });
      $(".book-chapter-text").value = draft.text;
      const check = draft.check;
      $(".book-draft-check").textContent = check
        ? `${text("Проверка на черновата")}: ${check.score}/100 · ${
            check.issues.length
              ? `${text("противоречия")}: ${check.issues.length} — ${check.issues.map((issue) => `„${issue.quote}“ ↔ ${issue.fact}`).join("; ")}`
              : text("няма противоречия")
          }`
        : pick("Паметта на книгата е празна, затова черновата не е проверена.", "Паметта на проекта е празна, затова черновата не е проверена.");
      status(pick("Черновата е в полето отгоре. Прочети я и натисни „Запази главата“, ако я искаш.", "Черновата е в полето отгоре. Прочети я и натисни „Запази частта“, ако я искаш."));
    }, text("Пиша черновата…"));
  });
  // A manuscript is read in the browser and split at its chapter headings.
  const HEADING = /^\s*(?:глава|chapter|kapitel|capítulo|capitulo|chapitre|capitolo|capitolul|розділ|bölüm)(?=[\s\d.:-]|$)[^\n]{0,80}$/iu;
  const PART_HEADING =
    /^\s*(?:глава|част|раздел|урок|документ|chapter|part|section|lesson|teil|abschnitt|parte|sección|seccion|partie|bölüm|kısım|частина|розділ)\s+(?:\d+|[IVXLCDM]+)\b[^\n]{0,80}$/iu;
  const splitManuscript = (source) => {
    const heading = domain === "writer" ? HEADING : PART_HEADING;
    const chapters = [];
    let currentChapter = null;
    for (const line of String(source).replace(/\r\n?/gu, "\n").split("\n")) {
      if (heading.test(line)) {
        if (currentChapter) chapters.push(currentChapter);
        currentChapter = { title: line.trim().replace(/^\s*\S+\s+(?:\d+|[IVXLCDM]+)\b[.:\s-]*/iu, "").trim().slice(0, 120), lines: [] };
      } else {
        currentChapter ||= { title: "", lines: [] };
        currentChapter.lines.push(line);
      }
    }
    if (currentChapter) chapters.push(currentChapter);
    return chapters
      .map((chapter) => ({ title: chapter.title, text: chapter.lines.join("\n").trim().slice(0, 50000) }))
      .filter((chapter) => chapter.text)
      .slice(0, 60)
      .map((chapter, index) => ({ number: index + 1, ...chapter }));
  };
  const decodeXml = (value) =>
    value
      .replace(/&lt;/gu, "<")
      .replace(/&gt;/gu, ">")
      .replace(/&quot;/gu, '"')
      .replace(/&apos;/gu, "'")
      .replace(/&#(\d+);/gu, (_, code) => String.fromCodePoint(Number(code)))
      .replace(/&amp;/gu, "&");
  const readDocx = async (file) => {
    const reader = globalThis.NovariumArchive;
    if (!reader?.listZipEntries || typeof DecompressionStream === "undefined") {
      throw new Error(text("Този браузър не може да отвори .docx. Запази го като .txt или опитай с по-нов браузър."));
    }
    const entry = (await reader.listZipEntries(file)).find(({ name }) => name === "word/document.xml");
    if (!entry) throw new Error(text("Файлът не е документ на Word."));
    const xml = await reader.readZipText(file, entry);
    return decodeXml(
      xml
        .replace(/<w:tab\/>/gu, "\t")
        .replace(/<w:br\/>/gu, "\n")
        .replace(/<\/w:p>/gu, "\n")
        .replace(/<[^>]+>/gu, ""),
    );
  };
  let pending = [];
  $(".book-upload-file").addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    void run(async () => {
      const source = /\.docx$/iu.test(file.name) ? await readDocx(file) : await file.text();
      pending = splitManuscript(source);
      if (!pending.length) throw new Error(text("Файлът е празен."));
      $(".book-upload-count").textContent = `${pick("Намерих глави", "Намерих части")}: ${pending.length} · ${pending
        .slice(0, 5)
        .map((chapter) => `${chapter.number}. ${chapter.title || pick("Глава", "Част")}`)
        .join(", ")}${pending.length > 5 ? "…" : ""}`;
      $(".book-upload-preview").hidden = false;
    }, pick("Чета ръкописа…", "Чета файла…"));
  });
  $(".book-upload-save").addEventListener("click", () => {
    if (!pending.length) return;
    void run(async () => {
      replaceBook((await call("POST", bookPath("/chapters"), { chapters: pending })).book);
      status(`${pick("Запазени глави", "Запазени части")}: ${pending.length}. ${text("Сега можеш да извадиш факти от тях в „Факти“.")}`);
      pending = [];
      $(".book-upload-preview").hidden = true;
    }, text("Записване…"));
  });

  const close = () => (dialog.hidden = true);
  $(".share-close").addEventListener("click", close);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !dialog.hidden) close();
  });
  // Another specialist opens its own memory on a clean panel: nothing of
  // the previous one stays on screen, and it starts on "Факти".
  const resetPanel = () => {
    armed = false;
    books = [];
    currentId = "";
    pending = [];
    for (const field of [".book-check-text", ".book-check-chapter", ".book-chapter-text", ".book-chapter-title", ".book-chapter-number", ".book-draft-plan", ".book-extract-text", ".book-extract-chapter", ".book-new-title", ".book-upload-file"]) {
      $(field).value = "";
    }
    for (const box of [".book-result", ".book-suggestions", ".book-upload-preview"]) $(box).hidden = true;
    $(".book-draft-check").textContent = "";
    dialog.querySelector('[data-tab="facts"]').click();
    applyWords();
    renderBooks();
  };
  let opening = 0;
  document.addEventListener("novarium:book", (event) => {
    const asked = String(event.detail?.assistant || "writer").replace(/[^a-z_-]/gu, "").slice(0, 40) || "writer";
    if (asked !== domain) {
      domain = asked;
      profile = null;
      resetPanel();
    }
    dialog.hidden = false;
    const ticket = (opening += 1);
    void run(async () => {
      const data = await call("GET", `?domain=${encodeURIComponent(asked)}`);
      // An older answer that arrives after the person switched specialists
      // is dropped.
      if (ticket !== opening) return;
      books = data.books || [];
      profile = data.profile || null;
      if (profile?.id && profile.id !== domain) domain = profile.id;
      applyWords();
      renderBooks();
    }, text("Зареждане…"));
  });
})();
