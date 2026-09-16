(() => {
  const STYLE_ID = "rk-ui-tweaks-style";

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      /* Keep only Create new Group in the + picker */
      [data-testid="create-new-space"] {
        display: none !important;
      }

      /* Tighter name + last-access stack in the chat header */
      button[data-testid="bot-settings-trigger"] {
        align-items: center !important;
      }
      button[data-testid="bot-settings-trigger"] > span.min-w-0 {
        display: flex !important;
        flex-direction: column !important;
        justify-content: center !important;
        gap: 1px !important;
        line-height: 1.15 !important;
        min-height: 26px !important;
      }
      button[data-testid="bot-settings-trigger"] > span.min-w-0 > span.block:first-child {
        line-height: 1.2 !important;
      }
      [data-testid="chat-header-status"] {
        margin-top: 0 !important;
        line-height: 1.15 !important;
        font-size: 11.5px !important;
        opacity: 0.85;
      }
    `;
    document.documentElement.appendChild(style);
  }

  ensureStyle();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ensureStyle, { once: true });
  }
})();
