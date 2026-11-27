// The contact form on /help: keeps the chosen language, shows the result
// after sending and brings back an unsent draft if sending did not work.
(() => {
  const form = document.getElementById("contact-form");
  const status = document.getElementById("contact-status");
  if (!form || !status) return;
  const params = new URLSearchParams(window.location.search);
  const lang = params.get("lang");
  if (lang && /^[a-z]{2,3}$/u.test(lang)) {
    form.action = `/api/contact?${new URLSearchParams({ lang })}`;
  }

  // A link such as /help?topic=data#contact opens the form on that topic.
  const topic = params.get("topic");
  if ([...form.elements.topic.options].some((option) => option.value === topic))
    form.elements.topic.value = topic;

  const draftKey = "novarium-contact-draft";
  const fields = ["name", "email", "topic", "message"];
  form.addEventListener("submit", () => {
    try {
      const draft = Object.fromEntries(
        fields.map((field) => [field, form.elements[field]?.value || ""]),
      );
      sessionStorage.setItem(draftKey, JSON.stringify(draft));
    } catch {
      // Without storage the form still sends; only the draft is not kept.
    }
  });

  const result = params.get("contact");
  try {
    if (result === "received") {
      sessionStorage.removeItem(draftKey);
    } else if (result) {
      const draft = JSON.parse(sessionStorage.getItem(draftKey) || "null");
      for (const field of fields) {
        if (typeof draft?.[field] === "string" && form.elements[field])
          form.elements[field].value = draft[field];
      }
    }
  } catch {
    // A missing or broken draft only means the fields start empty.
  }

  const locale = globalThis.NovariumLocale;
  const text = (value, values) => (locale ? locale.text(value, values) : value);
  const show = () => {
    const ticket = params.get("ticket") || "";
    const messages = {
      received: /^[A-F0-9]{8}$/u.test(ticket)
        ? text("Благодарим! Съобщението е изпратено под номер {ticket}. Ще ти отговорим на посочения имейл.", { ticket })
        : text("Благодарим! Съобщението е изпратено. Ще ти отговорим на посочения имейл."),
      invalid: text("Провери имейла и напиши съобщение от поне 10 знака."),
      limited: text("Твърде много съобщения за кратко време. Опитай отново след час."),
      unavailable: text("Съобщението не беше изпратено. Опитай отново след малко."),
    };
    if (!Object.hasOwn(messages, result)) return;
    status.textContent = messages[result];
    status.hidden = false;
    status.dataset.result = result;
  };
  if (locale?.ready) void locale.ready.then(show);
  else show();
})();
