export function isCalendarReadRequest(message) {
  const text = typeof message === "string" ? message.toLowerCase() : "";
  return /(?:календар|събития|ангажимент|срещи|програмата ми)/u.test(text);
}
