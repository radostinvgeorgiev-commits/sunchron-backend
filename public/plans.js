const params = new URLSearchParams(window.location.search);
const source = document.getElementById("request-source");
if (params.get("utm_source") === "chatgpt") source.value = "chatgpt";

const messages = new Map([
  [
    "received",
    "Заявката е получена. Ако има свободно място, ще получиш покана по имейл.",
  ],
  [
    "invalid",
    "Въведи валиден имейл и потвърди, че можем да го използваме за отговор.",
  ],
  ["unavailable", "Заявката не беше записана. Опитай отново след малко."],
]);
const message = messages.get(params.get("request"));
if (message) {
  const status = document.getElementById("request-status");
  status.textContent = message;
  status.hidden = false;
}
