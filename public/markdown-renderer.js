(function registerSafeMarkdownRenderer(globalObject) {
  const SANITIZE_OPTIONS = Object.freeze({
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["iframe", "style"],
    FORBID_ATTR: ["style"],
  });

  function showPlainText(element, text) {
    element.textContent = text;
    return { mode: "text" };
  }

  function renderSafeMarkdown(element, value, dependencies = {}) {
    const text = String(value ?? "");
    element.dataset.rawText = text;

    const markdownParser = dependencies.markdownParser || globalObject.marked;
    const sanitizer = dependencies.sanitizer || globalObject.DOMPurify;
    if (
      typeof markdownParser?.parse !== "function" ||
      typeof sanitizer?.sanitize !== "function"
    ) {
      return showPlainText(element, text);
    }

    try {
      const unsafeHtml = markdownParser.parse(text);
      const safeHtml = sanitizer.sanitize(unsafeHtml, SANITIZE_OPTIONS);
      element.innerHTML = safeHtml;
      return { mode: "html" };
    } catch (error) {
      console.error("[Markdown] Safe rendering failed:", error);
      return showPlainText(element, text);
    }
  }

  globalObject.SynchronMarkdown = Object.freeze({
    renderSafeMarkdown,
  });
})(globalThis);
