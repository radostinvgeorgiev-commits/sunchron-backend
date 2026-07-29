const commandBar = document.querySelector(".mobile-command-bar");

function activateCommand(command) {
  if (!commandBar) return;
  for (const button of commandBar.querySelectorAll("button")) {
    button.classList.toggle("active", button.dataset.command === command);
  }
}

function forwardClick(targetId, command) {
  const target = document.getElementById(targetId);
  if (!target) return;
  target.click();
  activateCommand(command);
}

commandBar?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-command]");
  if (!button) return;

  const command = button.dataset.command;
  if (command === "chat") {
    document.getElementById("closeDataDrawerBtn")?.click();
    document.getElementById("closeContextBtn")?.click();
    document.getElementById("chatInput")?.focus();
    activateCommand("chat");
  } else if (command === "memory") {
    forwardClick("memoryBtn", "memory");
  } else if (command === "tasks") {
    forwardClick("focusBtn", "tasks");
  } else if (command === "connections") {
    forwardClick("toolsBtn", "connections");
  }
});

document.getElementById("closeDataDrawerBtn")?.addEventListener("click", () => {
  activateCommand("chat");
});

activateCommand("chat");
