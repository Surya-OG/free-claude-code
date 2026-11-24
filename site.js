(() => {
  "use strict";

  const commands = {
    unix: 'curl -fsSL "https://raw.githubusercontent.com/Alishahryar1/free-claude-code/main/scripts/install.sh" | sh',
    windows: '& ([scriptblock]::Create((irm "https://raw.githubusercontent.com/Alishahryar1/free-claude-code/main/scripts/install.ps1")))',
  };
  const tabs = [...document.querySelectorAll(".platform-tab")];
  const panel = document.getElementById("install-panel");
  const command = document.getElementById("install-command");
  const status = document.getElementById("copy-status");

  function selectPlatform(tab) {
    tabs.forEach((item) => {
      const selected = item === tab;
      item.classList.toggle("active", selected);
      item.setAttribute("aria-selected", String(selected));
      item.tabIndex = selected ? 0 : -1;
    });
    panel.setAttribute("aria-labelledby", tab.id);
    command.textContent = commands[tab.dataset.platform];
    status.textContent = "";
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => selectPlatform(tab));
    tab.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const next = tabs[(index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
      next.focus();
      selectPlatform(next);
    });
  });

  document.getElementById("copy-command").addEventListener("click", async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(command.textContent);
      status.textContent = "Command copied.";
    } catch {
      const selection = window.getSelection();
      if (selection) {
        const range = document.createRange();
        range.selectNodeContents(command);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      status.textContent = "Could not copy automatically. Select and copy the command above.";
    }
  });

  const mobileMenu = document.querySelector(".mobile-nav");
  mobileMenu.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => { mobileMenu.open = false; });
  });
})();
