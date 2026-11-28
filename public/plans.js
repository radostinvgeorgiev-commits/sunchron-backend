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
  let usageState = null;
  // A message about the person's own payment stays on screen; the general
  // "how to pay" text does not replace it.
  let paymentNotice = "";
  function paymentsAvailable() {
    return Boolean(catalog?.paymentsEnabled || usageState?.payments?.available);
  }
  function testPayments() {
    return (
      usageState?.payments?.mode === "test" &&
      usageState?.payments?.available === true
    );
  }
  function renderPayments() {
    if (!catalog) return;
    const available = paymentsAvailable();
    if (paymentNotice) paymentStatus.textContent = paymentNotice;
    else if (!available)
      paymentStatus.textContent = plansText(
        "Платените покупки още не са активирани. Няма да бъде начислена сума.",
      );
    else if (testPayments())
      paymentStatus.textContent = plansText(
        "Тестов режим: плащане с тестови пари на Stripe, без истинско таксуване.",
      );
    else
      paymentStatus.textContent = plansText(
        "Плащане с Google Pay, Apple Pay или карта чрез Stripe. Единиците се добавят сами веднага след потвърждението.",
      );
    for (const b of document.querySelectorAll("[data-plan]")) {
      b.disabled = !available;
      b.textContent = available
        ? plansText("Избери пакет")
        : plansText("Плащанията предстоят");
    }
  }
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
      usageState = usage;
      renderPayments();
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
      renderPayments();
    } catch {
      if (!paymentNotice)
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
      if (!plan || !paymentsAvailable()) return;
      const price = new Intl.NumberFormat(plansLocale.browserLocale, {
        style: "currency",
        currency: "EUR",
      }).format(plan.amountCents / 100);
      const question = plansText(
        "{name}: {price}, {credits} AI единици за 30 дни. Еднократно плащане, без автоматично подновяване. Плащаш на страницата на Stripe с Google Pay, Apple Pay или карта. Да продължим ли?",
        { name: plansText(plan.name), price, credits: plan.credits },
      );
      if (
        !window.confirm(
          testPayments()
            ? `${plansText("Тестово плащане, без истински пари.")} ${question}`
            : question,
        )
      )
        return;
      button.disabled = true;
      try {
        const r = await fetch("/api/product/checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            plan: plan.id,
            confirmed: true,
            language: plansLocale.language,
          }),
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
  // After paying, the page asks by itself whether Stripe's confirmation has
  // arrived and says so as soon as the units are added.
  async function watchPayment(sessionId) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolve) =>
        setTimeout(resolve, attempt === 0 ? 1000 : 2000),
      );
      try {
        const r = await fetch(
          `/api/product/payment-status?session=${encodeURIComponent(sessionId)}`,
          { cache: "no-store" },
        );
        if (r.status === 400 || r.status === 401) return;
        if (!r.ok) continue;
        const result = await r.json();
        if (result.status === "applied") {
          paymentNotice = plansText(
            "Готово: {credits} AI единици са добавени към профила ти.",
            { credits: result.credits },
          );
          paymentStatus.textContent = paymentNotice;
          refreshUsage();
          return;
        }
      } catch {
        // Keep waiting; the confirmation usually arrives within seconds.
      }
    }
  }
  const paidSession = params.get("session_id");
  if (params.get("payment") === "processing") {
    if (/^cs_(?:test|live)_[A-Za-z0-9]{1,200}$/.test(paidSession || "")) {
      paymentNotice = plansText(
        "Плащането още се потвърждава. Единиците ще се появят сами, щом Stripe го потвърди.",
      );
      void watchPayment(paidSession);
    } else
      paymentNotice = plansText(
        "Плащането се обработва. Връщането на тази страница не доказва плащане. Обнови потреблението след потвърждение.",
      );
  }
  if (params.get("payment") === "cancelled")
    paymentNotice = plansText(
      "Плащането е прекратено. Можеш да опиташ отново.",
    );
  if (paymentNotice) paymentStatus.textContent = paymentNotice;
  loadPlans();
  refreshUsage();
});
