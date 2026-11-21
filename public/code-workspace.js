(() => {
  const byId = (suffix) => document.getElementById(`codeWorkspace${suffix}`);
  const dialog = byId("");
  const repository = byId("Repository");
  const message = byId("Message");
  const start = byId("Start");
  const status = byId("Status");
  const review = byId("Review");
  const confirm = byId("Confirm");
  const connect = byId("Connect");
  const reload = byId("Reload");
  const resultBox = byId("Result");
  const refreshChecks = byId("RefreshChecks");
  const checks = byId("Checks");
  const checkLabels = {
    passed: "Минала",
    failed: "Неуспешна",
    skipped: "Пропусната",
  };
  let draft;
  let result;
  let busy = false;
  let expiresTimer;

  function setStatus(text, error = false) {
    status.textContent = text;
    status.dataset.error = String(error);
  }

  function updateControls() {
    repository.disabled = busy || repository.options.length < 2;
    message.disabled = busy;
    start.disabled = busy || !repository.value || !message.value.trim();
    confirm.hidden = !draft?.confirmationId;
    confirm.disabled = busy;
    reload.disabled = busy;
  }

  function clearDraft() {
    clearTimeout(expiresTimer);
    draft = null;
    review.replaceChildren();
    updateControls();
  }

  async function request(path, body) {
    const response = await fetch(
      `/api/code-workspace/${path}`,
      body === undefined
        ? { cache: "no-store" }
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || "Заявката временно е недостъпна.");
      error.code = data.code;
      throw error;
    }
    return data;
  }

  async function loadRepository() {
    busy = true;
    connect.hidden = reload.hidden = true;
    updateControls();
    setStatus("Зареждане на GitHub хранилището…");
    try {
      const data = await request("repository");
      repository.add(
        new Option(`${data.repository} · ${data.base}`, data.repository),
      );
      setStatus("Избери хранилището и опиши задачата.");
    } catch (error) {
      connect.hidden = error.code !== "GITHUB_SESSION_REQUIRED";
      reload.hidden = !connect.hidden;
      setStatus(error.message, true);
    } finally {
      busy = false;
      updateControls();
    }
  }

  function open() {
    if (dialog.open) return;
    dialog.showModal();
    if (!busy && repository.options.length < 2) void loadRepository();
  }

  function appendText(parent, type, text) {
    const element = document.createElement(type);
    element.textContent = text;
    parent.append(element);
    return element;
  }

  function renderReview(plan) {
    review.replaceChildren();
    appendText(review, "h3", plan.title);
    appendText(review, "p", plan.summary);
    appendText(review, "p", `Основа main · ${plan.baseSha.slice(0, 12)}`);
    for (const [index, file] of plan.review.entries()) {
      const details = document.createElement("details");
      details.open = index === 0;
      appendText(details, "summary", file.path);
      appendText(details, "p", file.reason);
      appendText(
        details,
        "p",
        `${checkLabels[file.check.status]} · ${file.check.name}`,
      );
      const diff = appendText(details, "pre", file.diff);
      diff.tabIndex = 0;
      review.append(details);
    }
    appendText(
      review,
      "p",
      "Пълните тестове се изпълняват в GitHub след създаване на PR.",
    );
  }

  async function prepare(event) {
    event.preventDefault();
    if (start.disabled) return;
    clearDraft();
    result = null;
    resultBox.hidden = true;
    busy = true;
    updateControls();
    setStatus("Четене на избрания комит, подготовка на diff и проверки…");
    try {
      draft = await request("prepare", {
        repository: repository.value,
        message: message.value.trim(),
      });
      renderReview(draft);
      if (draft.confirmationId) {
        setStatus("Прегледай точните промени, преди да създадеш PR към main.");
        const remainingTime = new Date(draft.expiresAt).getTime() - Date.now();
        expiresTimer = setTimeout(
          () => {
            draft = null;
            updateControls();
            setStatus(
              "Времето за потвърждение изтече. Подготви промените отново.",
            );
          },
          Math.max(0, remainingTime),
        );
      } else {
        setStatus(
          "Има неуспешна проверка. Уточни задачата и подготви промените отново.",
          true,
        );
      }
    } catch (error) {
      clearDraft();
      setStatus(error.message, true);
    } finally {
      busy = false;
      updateControls();
    }
  }

  async function loadChecks() {
    if (!result || refreshChecks.disabled) return;
    const currentResult = result;
    refreshChecks.disabled = true;
    checks.replaceChildren();
    appendText(checks, "li", "Зареждане на GitHub проверките…");
    try {
      const { checks: items } = await request(
        `checks/${encodeURIComponent(currentResult.commitSha)}`,
      );
      if (result !== currentResult) return;
      checks.replaceChildren();
      if (!items.length)
        appendText(checks, "li", "GitHub още не е отчел проверки.");
      for (const item of items) {
        const label =
          item.status !== "completed"
            ? "В ход"
            : {
                success: "Минала",
                skipped: "Пропусната",
                cancelled: "Отменена",
                neutral: "Без оценка",
              }[item.conclusion] || "Неуспешна";
        appendText(checks, "li", `${label} · ${item.name}`);
      }
    } catch (error) {
      if (result !== currentResult) return;
      checks.replaceChildren();
      appendText(checks, "li", error.message);
    } finally {
      refreshChecks.disabled = false;
    }
  }

  async function createPullRequest() {
    if (busy || !draft?.confirmationId) return;
    const confirmationId = draft.confirmationId;
    clearTimeout(expiresTimer);
    draft = null;
    busy = true;
    updateControls();
    setStatus("Създаване на отделен клон, комит и PR…");
    try {
      result = await request("confirm", { confirmationId });
      const url = new URL(result.url);
      if (url.origin !== "https://github.com")
        throw new Error("GitHub върна невалиден адрес.");
      const link = byId("Pr");
      link.href = url.href;
      link.textContent = `Отвори PR #${result.pullRequestNumber} в GitHub`;
      resultBox.hidden = false;
      setStatus(
        result.auditWarning || "PR е създаден и чака преглед.",
        Boolean(result.auditWarning),
      );
      void loadChecks();
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      busy = false;
      updateControls();
    }
  }

  byId("Btn").addEventListener("click", open);
  reload.addEventListener("click", loadRepository);
  byId("Form").addEventListener("submit", prepare);
  message.addEventListener("input", () => {
    if (draft) {
      clearDraft();
      setStatus("Задачата е променена. Подготви нов преглед.");
    }
    updateControls();
  });
  repository.addEventListener("change", updateControls);
  confirm.addEventListener("click", createPullRequest);
  refreshChecks.addEventListener("click", loadChecks);
  connect.addEventListener("click", () => {
    try {
      sessionStorage.setItem("synchronReturnToCode", "true");
    } catch {}
  });
  globalThis.SynchronCodeWorkspace = Object.freeze({
    afterSignIn() {
      try {
        if (!sessionStorage.getItem("synchronReturnToCode")) return;
        sessionStorage.removeItem("synchronReturnToCode");
        open();
      } catch {}
    },
  });
})();
