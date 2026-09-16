(() => {
  const SPACE_KEY = "rakazo:space-id";
  const STYLE_ID = "rk-computer-style";

  function spaceHeaders(init) {
    const headers = new Headers(init || {});
    try {
      const spaceId = localStorage.getItem(SPACE_KEY);
      if (spaceId) headers.set("x-rakazo-space-id", spaceId);
    } catch (_) {}
    return headers;
  }

  async function api(path, options = {}) {
    const res = await fetch(path, {
      credentials: "include",
      ...options,
      headers: spaceHeaders({
        "content-type": "application/json",
        ...(options.headers || {}),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      [data-rk-computer-panel]{color:inherit}
      .rk-comp-title{margin:0 0 .35rem;font-size:15px;font-weight:600;color:var(--foreground,inherit)}
      .rk-comp-copy{margin:0 0 1rem;font-size:13px;line-height:1.45;color:var(--muted-foreground,#a1a1aa)}
      .rk-comp-row{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;padding:.85rem 0;border-top:1px solid var(--border,rgba(255,255,255,.08))}
      .rk-comp-row:first-of-type{border-top:0;padding-top:0}
      .rk-comp-label{font-size:13.5px;font-weight:550;color:var(--foreground,inherit)}
      .rk-comp-hint{margin:.25rem 0 0;font-size:12.5px;line-height:1.4;color:var(--muted-foreground,#a1a1aa)}
      .rk-comp-toggle{appearance:none;width:44px;height:26px;border-radius:999px;border:0;background:#3f3f46;position:relative;cursor:pointer;flex:0 0 auto;transition:background .15s ease}
      .rk-comp-toggle[aria-checked="true"]{background:#3ec5a8}
      .rk-comp-toggle:disabled{opacity:.55;cursor:default}
      .rk-comp-toggle::after{content:"";position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:999px;background:#fff;transition:transform .15s ease}
      .rk-comp-toggle[aria-checked="true"]::after{transform:translateX(18px)}
      .rk-comp-status{margin-top:.75rem;min-height:1.2em;font-size:12.5px;color:#86efac}
      .rk-comp-status.rk-err{color:#fca5a5}
    `;
    document.head.appendChild(style);
  }

  function renderPanel(host, state) {
    ensureStyles();
    const canEdit = !!state.canEdit;
    const on = !!state.allowLocalAccess;
    host.innerHTML = `
      <h3 class="rk-comp-title">Computer</h3>
      <p class="rk-comp-copy">Each bot keeps its own private computer. Turn on local access only if you want bots to also reach files you put in <code>~/rakazo-local</code> on this machine.</p>
      <div class="rk-comp-row">
        <div>
          <div class="rk-comp-label">Allow local access</div>
          <p class="rk-comp-hint">${
            on
              ? "On — bots keep <code>/home/rakazo</code> and can also use <code>/mnt/local</code> (your <code>~/rakazo-local</code> folder)."
              : "Off by default — bots stay only inside their own computer space."
          }</p>
        </div>
        <button type="button" class="rk-comp-toggle" role="switch" aria-checked="${on}" aria-label="Allow local access" ${
          canEdit ? "" : "disabled"
        } data-rk="toggle"></button>
      </div>
      <div class="rk-comp-status" data-rk="status"></div>
    `;
    const toggle = host.querySelector("[data-rk=toggle]");
    const status = host.querySelector("[data-rk=status]");
    toggle?.addEventListener("click", async () => {
      if (!canEdit || toggle.disabled) return;
      const next = toggle.getAttribute("aria-checked") !== "true";
      toggle.disabled = true;
      status.textContent = "Saving…";
      status.classList.remove("rk-err");
      try {
        const data = await api("/api/computer-settings", {
          method: "POST",
          body: JSON.stringify({ allowLocalAccess: next }),
        });
        renderPanel(host, data);
        const s = host.querySelector("[data-rk=status]");
        if (s) s.textContent = data.note || (next ? "Local access enabled." : "Local access disabled.");
      } catch (error) {
        toggle.disabled = false;
        status.textContent = error.message || "Could not save";
        status.classList.add("rk-err");
      }
    });
  }

  async function hydrate(host) {
    if (host.dataset.rkHydrated === "1") return;
    host.dataset.rkHydrated = "1";
    host.textContent = "Loading computer settings…";
    try {
      const data = await api("/api/computer-settings");
      renderPanel(host, data);
    } catch (error) {
      host.dataset.rkHydrated = "0";
      host.textContent = error.message || "Could not load computer settings";
    }
  }

  function scan() {
    const settings = document.querySelector('[data-testid="user-settings"]');
    if (!settings) return;
    const section = settings.getAttribute("data-settings-section");
    if (section !== "computer") return;
    const host =
      settings.querySelector("[data-rk-computer-panel]") ||
      settings.querySelector('[data-testid="computers-setup-settings"]');
    if (!host) return;
    if (!host.hasAttribute("data-rk-computer-panel")) {
      host.setAttribute("data-rk-computer-panel", "1");
    }
    // Settings remounts the panel on each section visit — rehydrate when empty/loading
    if (!host.querySelector("[data-rk=toggle]") && host.dataset.rkHydrated === "1") {
      host.dataset.rkHydrated = "0";
    }
    hydrate(host);
  }

  const obs = new MutationObserver(() => scan());
  obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
  scan();
  setInterval(scan, 1200);
})();
