const id = document.getElementById("confirmation");
const details = document.getElementById("details");
const status = document.getElementById("status");
const confirmButton = document.getElementById("confirm");
let inspectedId = "";

id.addEventListener("input", () => {
  inspectedId = "";
  confirmButton.disabled = true;
  details.textContent = "";
});

async function post(action, confirmationId) {
  const response = await fetch(`/api/claude-confirmation/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmationId }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Заявката не беше успешна.");
  return data;
}

document.getElementById("inspect").addEventListener("click", async () => {
  const value = id.value.trim();
  confirmButton.disabled = true;
  inspectedId = "";
  details.textContent = "";
  status.textContent = "";
  try {
    const data = await post("inspect", value);
    if (id.value.trim() !== value) return;
    details.textContent = JSON.stringify(data, null, 2);
    inspectedId = value;
    confirmButton.disabled = false;
  } catch (error) {
    status.textContent = error.message;
  }
});

confirmButton.addEventListener("click", async () => {
  confirmButton.disabled = true;
  try {
    await post("confirm", inspectedId);
    status.textContent = "Промяната е изпълнена.";
  } catch (error) {
    status.textContent = error.message;
  }
  inspectedId = "";
});
