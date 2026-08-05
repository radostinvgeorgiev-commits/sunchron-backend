/**
 * Billing UI — token balance display and purchase modal.
 *
 * This script runs after app.js has authenticated the user.
 * It reads the token balance and manages the purchase modal.
 */
(function () {
  "use strict";

  const tokenBalanceSection = document.getElementById("tokenBalanceSection");
  const tokenBalanceDisplay = document.getElementById("tokenBalanceDisplay");
  const buyTokensBtn = document.getElementById("buyTokensBtn");
  const purchaseTokensModal = document.getElementById("purchaseTokensModal");
  const purchaseTokensForm = document.getElementById("purchaseTokensForm");
  const purchaseEuros = document.getElementById("purchaseEuros");
  const purchaseTokensMessage = document.getElementById("purchaseTokensMessage");
  const confirmPurchaseBtn = document.getElementById("confirmPurchaseBtn");
  const cancelPurchaseBtn = document.getElementById("cancelPurchaseBtn");

  if (
    !tokenBalanceSection ||
    !tokenBalanceDisplay ||
    !buyTokensBtn ||
    !purchaseTokensModal ||
    !purchaseTokensForm
  ) {
    return;
  }

  let currentBalance = null;

  function formatBalance(n) {
    return typeof n === "number" ? n.toLocaleString("bg-BG") + " токена" : "—";
  }

  function setBalanceDisplay(n) {
    currentBalance = n;
    tokenBalanceDisplay.textContent = formatBalance(n);
    if (typeof n === "number" && n < 20) {
      tokenBalanceDisplay.classList.add("token-balance-low");
    } else {
      tokenBalanceDisplay.classList.remove("token-balance-low");
    }
  }

  async function loadBalance() {
    try {
      const resp = await fetch("/api/billing/balance", { cache: "no-store" });
      if (!resp.ok) return;
      const data = await resp.json();
      if (typeof data.balance === "number") {
        setBalanceDisplay(data.balance);
        tokenBalanceSection.hidden = false;
      }
    } catch {
      // Billing storage may not be configured yet.
    }
  }

  // Show balance section only for non-owner authenticated users.
  // We poll app state via a custom event dispatched by app.js.
  function onAuthStateChange(event) {
    const user = event?.detail?.user;
    if (!user) {
      tokenBalanceSection.hidden = true;
      return;
    }
    if (user.role !== "owner") {
      loadBalance();
    } else {
      tokenBalanceSection.hidden = true;
    }
  }

  document.addEventListener("synchron:auth", onAuthStateChange);

  // Purchase modal
  buyTokensBtn.addEventListener("click", () => {
    purchaseTokensMessage.textContent = "";
    purchaseEuros.value = "1";
    purchaseTokensModal.showModal?.();
    if (!purchaseTokensModal.open) {
      purchaseTokensModal.setAttribute("open", "");
    }
  });

  cancelPurchaseBtn.addEventListener("click", () => {
    purchaseTokensModal.close?.();
    if (purchaseTokensModal.open) {
      purchaseTokensModal.removeAttribute("open");
    }
  });

  purchaseTokensForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const euros = Number(purchaseEuros.value);
    if (!Number.isInteger(euros) || euros < 1) {
      purchaseTokensMessage.textContent = "Въведи цяло число евро (минимум 1).";
      return;
    }

    confirmPurchaseBtn.disabled = true;
    purchaseTokensMessage.textContent = "Обработва се…";

    try {
      const resp = await fetch("/api/billing/purchase-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ euros }),
      });
      const data = await resp.json();

      if (!resp.ok) {
        purchaseTokensMessage.textContent =
          data?.error || `Грешка HTTP ${resp.status}`;
        confirmPurchaseBtn.disabled = false;
        return;
      }

      setBalanceDisplay(data.newBalance);
      purchaseTokensMessage.textContent = `✓ Добавени ${data.tokens?.toLocaleString("bg-BG")} токена. Нов баланс: ${formatBalance(data.newBalance)}`;

      setTimeout(() => {
        purchaseTokensModal.close?.();
        if (purchaseTokensModal.open) {
          purchaseTokensModal.removeAttribute("open");
        }
        purchaseTokensMessage.textContent = "";
      }, 2500);
    } catch {
      purchaseTokensMessage.textContent = "Неуспешна връзка. Опитай отново.";
    }

    confirmPurchaseBtn.disabled = false;
  });

  // Listen for "Insufficient tokens" errors from the chat UI.
  document.addEventListener("synchron:insufficient_tokens", () => {
    loadBalance();
  });
})();
