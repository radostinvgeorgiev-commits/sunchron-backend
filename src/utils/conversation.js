export function conversationTitleFromMessages(messages) {
  const firstUserMessage = messages.find(
    (message) =>
      message?.role === "user" && typeof message.content === "string",
  );
  const title = firstUserMessage?.content?.trim().replace(/\s+/g, " ");
  if (!title) return "Нов разговор";
  return title.length > 52 ? `${title.slice(0, 49).trimEnd()}…` : title;
}
