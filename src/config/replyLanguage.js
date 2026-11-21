const languageNames = new Intl.DisplayNames(["en"], {
  type: "language",
  fallback: "none",
});

function getReplyLanguageName(language) {
  if (typeof language === "string" && /^[a-z]{2,3}$/u.test(language)) {
    try {
      return languageNames.of(language);
    } catch {
      // Unsupported or invalid locales keep the legacy default for API clients.
    }
  }
}

export function useEnglishReplyFallback(language) {
  return language !== "bg" && Boolean(getReplyLanguageName(language));
}

export function replyLanguageInstruction(language) {
  const fallback = getReplyLanguageName(language) || "Bulgarian";
  return `Reply in the language explicitly requested in the latest user message. Otherwise reply in the language of that message. If its language is unclear, use ${fallback}.`;
}
