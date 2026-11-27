(() => {
  const normalizeCode = (code) => (code === "ns" ? "nso" : code);
  const supported = new Set((window.AiCoreLanguages || ["bg", "en"]).map(normalizeCode));
  const preferenceKey = "ai-core-language";
  const url = new URL(window.location.href);
  const requested = normalizeCode(url.searchParams.get("lang"));
  const english = new Map(window.AiCoreEnglish);
  english.set("Сървър онлайн", "Server online");
  english.set("Сървър офлайн", "Server offline");
  english.set("Действия за разговора", "Conversation actions");
  english.set("Изтегли разговора", "Download conversation");
  let saved;
  try {
    if (supported.has(requested))
      localStorage.setItem(preferenceKey, requested);
    saved = normalizeCode(localStorage.getItem(preferenceKey));
  } catch {
    // The URL preference also works when storage is unavailable.
  }
  const browserLanguage = navigator.language?.toLowerCase().split("-")[0];
  let language = [requested, saved, browserLanguage, "en"].find((code) =>
    supported.has(code),
  );
  // A language the person chose here is not translated again by the
  // browser (Chrome's "always translate" would turn English back into
  // Bulgarian, for example).
  let noTranslateMeta = null;
  if (language === requested || language === saved) {
    document.documentElement.setAttribute("translate", "no");
    if (!document.querySelector('meta[name="google"][content="notranslate"]')) {
      noTranslateMeta = document.createElement("meta");
      noTranslateMeta.name = "google";
      noTranslateMeta.content = "notranslate";
      document.head.append(noTranslateMeta);
    }
  }
  let catalog = english;
  const normalize = (value) => value.replace(/\s+/gu, " ").trim();
  const attributes = [
    "aria-label",
    "title",
    "placeholder",
    "alt",
    "content",
    "data-starter",
  ];
  const rtl = new Set(["ar", "fa", "he", "ps", "sd", "ur", "yi"]);

  const currentLabels = {
    de: ["Server ist online", "Server ist offline", "Unterhaltungsaktionen", "Unterhaltung herunterladen"],
    es: ["Servidor en línea", "Servidor sin conexión", "Acciones de conversación", "Descargar conversación"],
    fr: ["Serveur en ligne", "Serveur hors ligne", "Actions de la conversation", "Télécharger la conversation"],
  };
  const currentLabelKeys = [
    "Server online",
    "Server offline",
    "Conversation actions",
    "Download conversation",
  ];

  async function load() {
    if (language !== "en" && language !== "bg") {
      try {
        const response = await fetch(`/locales/${language}.json`);
        if (!response.ok) throw new Error("Language catalog is unavailable.");
        const translated = await response.json();
        currentLabels[language]?.forEach((label, index) => {
          translated[currentLabelKeys[index]] = label;
        });
        catalog = new Map(
          Array.from(english, ([key, fallback]) => [
            key,
            Object.hasOwn(translated, fallback)
              ? translated[fallback]
              : fallback,
          ]),
        );
      } catch {
        language = "en";
        // The chosen language did not load, so the page is English the person
        // did not choose: the browser may offer to translate it again.
        document.documentElement.removeAttribute("translate");
        noTranslateMeta?.remove();
      }
    }
    document.documentElement.lang = language;
    document.documentElement.dir = rtl.has(language) ? "rtl" : "ltr";
    // "Свържи Google" opens Google's screens in the same language.
    try {
      document.cookie = `ai_core_language=${language}; Path=/api/google; Max-Age=31536000; SameSite=Lax${
        location.protocol === "https:" ? "; Secure" : ""
      }`;
    } catch {
      // Without it, Google shows its screens in the account's language.
    }
  }

  function text(value, values = {}) {
    const translated =
      language === "bg" ? value : (catalog.get(normalize(value)) ?? value);
    return translated.replace(/\{(\w+)\}/gu, (match, name) =>
      Object.hasOwn(values, name) ? String(values[name]) : match,
    );
  }

  function makeSwitch() {
    const select = document.createElement("select");
    select.className = "language-select";
    select.setAttribute("aria-label", text("Език на интерфейса"));
    const names = new Intl.DisplayNames(["en"], { type: "language" });
    const prettyName = (code) =>
      code === "nso" ? "Northern Sotho" : names.of(code);
    for (const code of [...supported].sort((a, b) =>
      prettyName(a).localeCompare(prettyName(b), "en"),
    )) {
      const nativeName =
        code === "nso"
          ? "Sesotho sa Leboa"
          : new Intl.DisplayNames([code], { type: "language" }).of(code);
      const option = new Option(
        nativeName === prettyName(code)
          ? nativeName
          : `${nativeName} · ${prettyName(code)}`,
        code,
        false,
        code === language,
      );
      option.lang = code;
      select.add(option);
    }
    select.addEventListener("change", () => {
      const destination = new URL(window.location.href);
      destination.searchParams.set("lang", select.value);
      window.location.assign(destination.href);
    });
    return select;
  }

  function applyDocumentLanguage() {
    // The authored document is translated before loading chat history or other
    // user data. Runtime UI strings opt in through text().
    if (language !== "bg") {
      const walker = document.createTreeWalker(
        document.documentElement,
        NodeFilter.SHOW_TEXT,
      );
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (
          node.parentElement?.closest(
            "script, style, pre, code, [data-user-content]",
          )
        )
          continue;
        const translated = catalog.get(normalize(node.data));
        if (translated) {
          const [, leading, trailing] = /^(\s*)[\s\S]*?(\s*)$/u.exec(node.data);
          node.data = leading + translated + trailing;
        }
      }
      const selector = attributes
        .map((attr) => (attr === "content" ? "meta[content]" : `[${attr}]`))
        .join(",");
      for (const element of document.querySelectorAll(selector)) {
        for (const attr of attributes) {
          if (element.hasAttribute(attr))
            element.setAttribute(attr, text(element.getAttribute(attr)));
        }
      }
      document
        .querySelector('meta[property="og:locale"]')
        ?.setAttribute("content", language === "en" ? "en_US" : language);
    }
    for (const slot of document.querySelectorAll("[data-language-switch]"))
      slot.append(makeSwitch());

    // Preserve shareable language URLs even when storage is unavailable.
    if (supported.has(requested)) {
      for (const link of document.querySelectorAll("a[href]")) {
        const target = new URL(link.href, location.href);
        if (
          target.origin !== location.origin ||
          !["/", "/plans", "/register", "/help", "/developers"].includes(
            target.pathname,
          ) ||
          link.getAttribute("href").startsWith("#")
        )
          continue;
        target.searchParams.set("lang", language);
        link.href = target.href;
      }
    }
  }

  const documentReady = new Promise((resolve) =>
    document.addEventListener("DOMContentLoaded", resolve, { once: true }),
  );
  const ready = Promise.all([load(), documentReady]).then(
    applyDocumentLanguage,
  );
  window.AiCoreLocale = Object.freeze({
    get language() {
      return language;
    },
    get browserLocale() {
      return language === "bg" ? "bg-BG" : language;
    },
    text,
    ready,
  });
})();
