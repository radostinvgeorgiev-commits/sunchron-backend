export function extractTextContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      return [part.text, part.input_text, part.output_text].find(
        (value) => typeof value === "string",
      ) || "";
    })
    .join("");
}

export function normalizeChatMessages(input) {
  return (Array.isArray(input) ? input : [])
    .map((item) => ({
      role:
        item?.role === "assistant" || item?.role === "model"
          ? "assistant"
          : item?.role === "system"
            ? "system"
            : "user",
      content: extractTextContent(item?.content),
    }))
    .filter((item) => item.content.trim());
}

export function extractGeminiOutputText(data) {
  return (Array.isArray(data?.candidates) ? data.candidates : [])
    .flatMap((candidate) =>
      Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [],
    )
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("");
}
