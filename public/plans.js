const params = new URLSearchParams(window.location.search);
const source = document.getElementById("request-source");
if (params.get("utm_source") === "chatgpt") source.value = "chatgpt";

const campaignParams = new URLSearchParams();
for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_content"]) {
  if (params.has(key)) campaignParams.set(key, params.get(key));
}
if (campaignParams.has("utm_campaign")) {
  const registration = document.querySelector('a[href="/register"]');
  const requestForm = document.querySelector(
    'form[action="/api/early-access"]',
  );
  registration.search = campaignParams.toString();
  requestForm.action = `/api/early-access?${campaignParams}`;
}

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
