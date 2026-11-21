export function replyLanguageInstruction(language) {
  let fallback = "Bulgarian";
  if (typeof language === "string" && /^[a-z]{2,3}$/u.test(language)) {
    try {
      fallback =
        new Intl.DisplayNames(["en"], {
          type: "language",
          fallback: "none",
        }).of(language) || fallback;
    } catch {
      // Unsupported or invalid locales keep the legacy default for API clients.
    }
  }
  return `Reply in the language explicitly requested in the latest user message. Otherwise reply in the language of that message. If its language is unclear, use ${fallback}.`;
}
