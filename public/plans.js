const plansLocale = globalThis.NovariumLocale;
const plansText = (value, values) => plansLocale.text(value, values);
const params = new URLSearchParams(window.location.search);
const source = document.getElementById("request-source");
if (params.get("utm_source") === "chatgpt") source.value = "chatgpt";

const campaignParams = new URLSearchParams();
for (const key of [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "lang",
]) {
  if (params.has(key)) campaignParams.set(key, params.get(key));
}
if (campaignParams.has("utm_campaign") || campaignParams.has("lang")) {
  for (const registration of document.querySelectorAll('a[href="/register"]')) {
    registration.search = campaignParams.toString();
  }
  const requestForm = document.querySelector(
    'form[action="/api/early-access"]',
  );
  requestForm.action = `/api/early-access?${campaignParams}`;
}

void plansLocale.ready.then(() => {
  const usageStatus = document.getElementById("usage-status");
  const paymentStatus = document.getElementById("payment-status");
  let catalog = null;
  async function refreshUsage() {
    usageStatus.textContent = plansText("Проверка на потреблението…");
    try {
      const r = await fetch("/api/product/usage", { cache: "no-store" });
      if (r.status === 401) {
        usageStatus.textContent = plansText(
          "Влез в профила си, за да видиш останалите AI единици.",
        );
        return;
      }
      if (!r.ok) throw new Error();
      const usage = await r.json();
      usageStatus.textContent = usage.owner
        ? plansText(
            "Профил на собственик — потребителските пакети не се прилагат.",
          )
        : plansText("{remaining} AI единици остават · валидни до {expires}", {
            remaining: usage.remaining,
            expires: new Date(usage.expiresAt).toLocaleDateString(
              plansLocale.browserLocale,
            ),
          });
    } catch {
      usageStatus.textContent = plansText(
        "Не успяхме да заредим потреблението. Опитай отново.",
      );
    }
  }
  async function loadPlans() {
    try {
      const r = await fetch("/api/product/plans", { cache: "no-store" });
      if (!r.ok) throw new Error();
      catalog = await r.json();
      paymentStatus.textContent = catalog.paymentsEnabled
        ? plansText(
            "Плащане с карта чрез Stripe. Пакетът се активира след потвърждение от платежния оператор.",
          )
        : plansText(
            "Платените покупки още не са активирани. Няма да бъде начислена сума.",
          );
      for (const b of document.querySelectorAll("[data-plan]")) {
        b.disabled = !catalog.paymentsEnabled;
        b.textContent = catalog.paymentsEnabled
          ? plansText("Избери пакет")
          : plansText("Плащанията предстоят");
      }
    } catch {
      paymentStatus.textContent = plansText(
        "Не можем да проверим плащанията. Опитай по-късно.",
      );
    }
  }
  document
    .getElementById("usage-refresh")
    .addEventListener("click", refreshUsage);
  for (const button of document.querySelectorAll("[data-plan]"))
    button.addEventListener("click", async () => {
      const plan = catalog?.plans.find((p) => p.id === button.dataset.plan);
      if (!plan || !catalog.paymentsEnabled) return;
      const price = new Intl.NumberFormat(plansLocale.browserLocale, {
        style: "currency",
        currency: "EUR",
      }).format(plan.amountCents / 100);
      if (
        !window.confirm(
          plansText(
            "{name}: {price}, {credits} AI единици за 30 дни. Еднократно плащане, без автоматично подновяване. Да продължим ли към Stripe?",
            { name: plansText(plan.name), price, credits: plan.credits },
          ),
        )
      )
        return;
      button.disabled = true;
      try {
        const r = await fetch("/api/product/checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ plan: plan.id, confirmed: true }),
        });
        if (r.status === 401) {
          window.location.assign(
            document.querySelector(".plans-grid a.plans-button").href,
          );
          return;
        }
        const data = await r.json();
        if (!r.ok)
          throw new Error(
            (plansLocale.language === "bg" && data.error) ||
              plansText("Плащането не е достъпно."),
          );
        const url = new URL(data.url);
        if (url.protocol !== "https:" || url.hostname !== "checkout.stripe.com")
          throw new Error(plansText("Невалиден платежен адрес."));
        window.location.assign(url.href);
      } catch (error) {
        paymentStatus.textContent = error.message;
        button.disabled = false;
      }
    });
  const messages = {
    received: plansText("Запитването е записано."),
    invalid: plansText(
      "Въведи валиден имейл и потвърди използването му за отговор.",
    ),
    unavailable: plansText("Запитването не беше записано. Опитай отново."),
  };
  const status = document.getElementById("request-status");
  if (Object.hasOwn(messages, params.get("request"))) {
    status.textContent = messages[params.get("request")];
    status.hidden = false;
  }
  if (params.get("payment") === "processing")
    paymentStatus.textContent = plansText(
      "Плащането се обработва. Връщането на тази страница не доказва плащане. Обнови потреблението след потвърждение.",
    );
  if (params.get("payment") === "cancelled")
    paymentStatus.textContent = plansText(
      "Плащането е прекратено. Можеш да опиташ отново.",
    );
  loadPlans();
  refreshUsage();
});
