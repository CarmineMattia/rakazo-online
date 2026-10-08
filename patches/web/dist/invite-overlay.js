(() => {
  // Skip heavy DOM observers on auth pages (prevents login freezes).
  const __rkAuthPaths = new Set(["/sign-in", "/sign-up", "/forgot-password"]);
  if (__rkAuthPaths.has(location.pathname)) return;

  const SPACE_KEY = "rakazo:space-id";
  const STYLE_ID = "rk-invite-style";
  const ROOT_ID = "rk-invite-root";

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
      #${ROOT_ID}{position:fixed;inset:0;z-index:100000;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.55);padding:1rem;font:14px/1.4 ui-sans-serif,system-ui,sans-serif;color:#e8e8ea}
      #${ROOT_ID}.rk-open{display:flex}
      #${ROOT_ID} .rk-card{width:min(420px,100%);background:#161618;border:1px solid #2a2a2e;border-radius:16px;padding:1.1rem 1.15rem 1.2rem;box-shadow:0 20px 60px rgba(0,0,0,.5)}
      #${ROOT_ID} h2{margin:0 0 .35rem;font-size:1.05rem;font-weight:650;color:#f4f4f5}
      #${ROOT_ID} p{margin:0 0 .85rem;color:#a1a1aa;font-size:13px}
      #${ROOT_ID} .rk-row{display:flex;gap:.5rem;flex-wrap:wrap;margin:.6rem 0}
      #${ROOT_ID} button,#${ROOT_ID} a.rk-btn{appearance:none;border:1px solid #3f3f46;background:#232326;color:#f4f4f5;border-radius:999px;padding:.45rem .9rem;font:600 13px/1.2 ui-sans-serif,system-ui,sans-serif;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center}
      #${ROOT_ID} button.rk-primary{background:#3ec5a8;border-color:#3ec5a8;color:#06251d}
      #${ROOT_ID} button:disabled{opacity:.55;cursor:default}
      #${ROOT_ID} .rk-linkbox{width:100%;box-sizing:border-box;border-radius:10px;border:1px solid #2a2a2e;background:#0d0d0e;color:#d4d4d8;padding:.65rem .75rem;font:12px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}
      #${ROOT_ID} .rk-people{list-style:none;margin:.4rem 0 0;padding:0;display:flex;flex-direction:column;gap:.45rem;max-height:220px;overflow:auto}
      #${ROOT_ID} .rk-people li{display:flex;align-items:center;gap:.65rem;padding:.45rem .55rem;border-radius:10px;background:#1c1c1f}
      #${ROOT_ID} .rk-avatar{width:28px;height:28px;border-radius:999px;background:#3ec5a8;color:#06251d;display:inline-flex;align-items:center;justify-content:center;font:700 12px/1 ui-sans-serif,system-ui,sans-serif;flex:0 0 auto}
      #${ROOT_ID} .rk-meta{min-width:0;flex:1}
      #${ROOT_ID} .rk-meta strong{display:block;font-size:13px;color:#f4f4f5}
      #${ROOT_ID} .rk-meta span{display:block;font-size:11px;color:#71717a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      #${ROOT_ID} .rk-badge{font-size:11px;color:#a1a1aa;flex:0 0 auto}
      #${ROOT_ID} .rk-status{min-height:1.1em;font-size:12.5px;color:#86efac;margin-top:.55rem}
      #${ROOT_ID} .rk-status.rk-err{color:#fca5a5}
      #rk-invite-share{display:flex;align-items:center;gap:.55rem;width:auto;align-self:stretch;margin:0 .55rem .65rem;box-sizing:border-box;appearance:none;border:0;background:transparent;color:inherit;border-radius:11px;padding:.45rem .7rem;font:500 13.5px/1.2 ui-sans-serif,system-ui,sans-serif;cursor:pointer;text-align:left}
      #rk-invite-share:hover{background:var(--sidebar-accent,rgba(255,255,255,.06))}
      #rk-invite-share .rk-share-ico{display:inline-grid;place-items:center;width:28px;height:28px;border-radius:999px;background:var(--muted,rgba(255,255,255,.08));color:var(--foreground,currentColor);opacity:.8;flex:0 0 auto}
      #rk-invite-share .rk-share-ico svg{display:block}
      #rk-invite-page{position:fixed;inset:0;z-index:100001;display:flex;align-items:center;justify-content:center;background:#0d0d0e;padding:1rem;font:14px/1.45 ui-sans-serif,system-ui,sans-serif;color:#e8e8ea}
      #rk-invite-page .rk-card{width:min(440px,100%);background:#161618;border:1px solid #2a2a2e;border-radius:16px;padding:1.25rem}
    `;
    document.head.appendChild(style);
  }

  function initial(name) {
    const t = (name || "?").trim();
    return (t[0] || "?").toUpperCase();
  }

  function panelHtml() {
    return `
      <div class="rk-card" role="dialog" aria-modal="true" aria-labelledby="rk-invite-title">
        <h2 id="rk-invite-title">People & invites</h2>
        <p>Invite a colleague to join this space. Existing chats and bots stay private to their owners.</p>
        <div class="rk-row">
          <button type="button" class="rk-primary" data-rk="create">Invite colleague</button>
          <button type="button" data-rk="copy" disabled>Copy link</button>
          <button type="button" data-rk="close">Close</button>
        </div>
        <input class="rk-linkbox" data-rk="link" readonly placeholder="Create an invite to get a link" />
        <div class="rk-status" data-rk="status"></div>
        <h2 style="margin-top:1rem;font-size:.95rem">In this space</h2>
        <ul class="rk-people" data-rk="people"><li style="color:#71717a;background:transparent;padding-left:0">Loading…</li></ul>
      </div>`;
  }

  let lastUrl = "";

  function setStatus(el, text, isErr) {
    el.textContent = text || "";
    el.classList.toggle("rk-err", !!isErr);
  }

  async function refreshPeople(root) {
    const list = root.querySelector("[data-rk=people]");
    try {
      const data = await api("/api/space-members");
      if (!data.people?.length) {
        list.innerHTML = `<li style="color:#71717a;background:transparent;padding-left:0">Only you here so far</li>`;
        return;
      }
      list.innerHTML = data.people
        .map(
          (p) => `<li>
            <span class="rk-avatar">${
              p.image ? `<img src="${escapeHtml(p.image)}" alt="" referrerpolicy="no-referrer">` : initial(p.name)
            }</span>
            <div class="rk-meta"><strong>${escapeHtml(p.name)}${p.isYou ? " (you)" : ""}</strong><span>${escapeHtml(p.email || p.role)}</span></div>
            <span class="rk-badge">${escapeHtml(p.role)}</span>
          </li>`,
        )
        .join("");
    } catch (error) {
      list.innerHTML = `<li style="color:#fca5a5;background:transparent;padding-left:0">${escapeHtml(error.message)}</li>`;
    }
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function openPanel() {
    ensureStyles();
    let root = document.getElementById(ROOT_ID);
    if (!root) {
      root = document.createElement("div");
      root.id = ROOT_ID;
      root.innerHTML = panelHtml();
      document.body.appendChild(root);
      root.addEventListener("click", (e) => {
        if (e.target === root) closePanel();
      });
      root.querySelector("[data-rk=close]").addEventListener("click", closePanel);
      root.querySelector("[data-rk=create]").addEventListener("click", async () => {
        const status = root.querySelector("[data-rk=status]");
        const link = root.querySelector("[data-rk=link]");
        const copyBtn = root.querySelector("[data-rk=copy]");
        const createBtn = root.querySelector("[data-rk=create]");
        createBtn.disabled = true;
        setStatus(status, "Creating invite…");
        try {
          const invite = await api("/api/space-invites", { method: "POST", body: "{}" });
          lastUrl = invite.url || `${location.origin}${invite.urlPath || `/invite/${invite.token}`}`;
          // Prefer current page origin (web UI) over API-reported host
          if (invite.urlPath) lastUrl = `${location.origin}${invite.urlPath}`;
          else if (invite.token) lastUrl = `${location.origin}/invite/${invite.token}`;
          link.value = lastUrl;
          copyBtn.disabled = false;
          setStatus(status, `Invite ready · expires ${new Date(invite.expiresAt).toLocaleString()}`);
        } catch (error) {
          setStatus(status, error.message, true);
        } finally {
          createBtn.disabled = false;
        }
      });
      root.querySelector("[data-rk=copy]").addEventListener("click", async () => {
        const status = root.querySelector("[data-rk=status]");
        if (!lastUrl) return;
        try {
          await navigator.clipboard.writeText(lastUrl);
          setStatus(status, "Copied — send it to your colleague");
        } catch (_) {
          root.querySelector("[data-rk=link]").select();
          setStatus(status, "Select the link and copy it manually");
        }
      });
    }
    root.classList.add("rk-open");
    refreshPeople(root);
  }

  function closePanel() {
    document.getElementById(ROOT_ID)?.classList.remove("rk-open");
  }

  function shareIconSvg() {
    return `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M14 9V5l7 7-7 7v-4.1c-5 0-8.5 1.6-11 5.1 1-5 4-10 11-11z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>`;
  }

  function ensureShareControl() {
    document.getElementById("rk-invite-fab")?.remove();
    if (location.pathname.startsWith("/invite/")) return;
    if (!document.getElementById("root")?.children?.length) return;

    const trigger = document.querySelector('[data-testid="user-menu-trigger"]');
    if (!trigger?.parentElement) return;
    // Never attach under the app shell — only inside the sidebar that owns the profile row
    if (!trigger.closest("[data-testid=bots-sidebar], aside")) return;

    let btn = document.getElementById("rk-invite-share");
    // Drop a misplaced Share left outside the sidebar from an earlier insert
    if (btn && !btn.closest("[data-testid=bots-sidebar], aside")) {
      btn.remove();
      btn = null;
    }
    if (!btn) {
      btn = document.createElement("button");
      btn.id = "rk-invite-share";
      btn.type = "button";
      btn.title = "Invite colleagues & see people in this space";
      btn.innerHTML = `<span class="rk-share-ico">${shareIconSvg()}</span><span>Share</span>`;
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openPanel();
      });
    }

    // Radix Popover.Root has no DOM node — insert Share right under the profile trigger
    if (btn.previousElementSibling !== trigger || btn.parentElement !== trigger.parentElement) {
      trigger.insertAdjacentElement("afterend", btn);
    }
  }

  async function handleInviteRoute() {
    const m = location.pathname.match(/^\/invite\/([a-f0-9]+)$/i);
    if (!m) return false;
    ensureStyles();
    const token = m[1];
    const page = document.createElement("div");
    page.id = "rk-invite-page";
    page.innerHTML = `<div class="rk-card"><h2 style="margin-top:0">Space invite</h2><p data-rk="msg">Loading invite…</p><div class="rk-row" data-rk="actions"></div><div class="rk-status" data-rk="status"></div></div>`;
    document.body.appendChild(page);
    const msg = page.querySelector("[data-rk=msg]");
    const actions = page.querySelector("[data-rk=actions]");
    const status = page.querySelector("[data-rk=status]");

    let preview = null;
    try {
      preview = await api(`/api/space-invites/preview/${token}`);
      msg.textContent = `${preview.inviterName} invited you to “${preview.spaceName}”.`;
    } catch (error) {
      msg.textContent = error.message;
      return true;
    }

    const goApp = (spaceId) => {
      try {
        if (spaceId) localStorage.setItem(SPACE_KEY, spaceId);
      } catch (_) {}
      location.href = "/app";
    };

    const redeemBtn = document.createElement("button");
    redeemBtn.type = "button";
    redeemBtn.className = "rk-primary";
    redeemBtn.textContent = "Join space";
    redeemBtn.addEventListener("click", async () => {
      redeemBtn.disabled = true;
      setStatus(status, "Joining…");
      try {
        const result = await api("/api/space-invites/redeem", {
          method: "POST",
          body: JSON.stringify({ token }),
        });
        setStatus(status, `Joined “${result.spaceName}”. Opening…`);
        setTimeout(() => goApp(result.spaceId), 400);
      } catch (error) {
        if (/Unauthorized/i.test(error.message)) {
          setStatus(status, "Sign in or create an account first, then open this link again.", true);
          actions.innerHTML = "";
          const login = document.createElement("a");
          login.className = "rk-btn rk-primary";
          login.href = `/sign-in?next=${encodeURIComponent(location.pathname)}`;
          login.textContent = "Sign in";
          actions.appendChild(login);
        } else {
          setStatus(status, error.message, true);
          redeemBtn.disabled = false;
        }
      }
    });
    actions.appendChild(redeemBtn);
    return true;
  }

  function boot() {
    ensureStyles();
    handleInviteRoute().then((handled) => {
      if (handled) return;
      // Poll until the sidebar profile row mounts, then keep Share attached
      let tries = 0;
      const timer = setInterval(() => {
        tries += 1;
        ensureShareControl();
        if (document.getElementById("rk-invite-share") || tries > 60) {
          clearInterval(timer);
          if (document.getElementById("rk-invite-share")) {
            const obs = new MutationObserver(() => ensureShareControl());
            obs.observe(document.getElementById("root") || document.body, {
              childList: true,
              subtree: true,
            });
          }
        }
      }, 400);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
  document.addEventListener("rakazo:social-changed", () => {
    const root = document.getElementById(ROOT_ID);
    if (root?.classList.contains("rk-open")) void refreshPeople(root);
  });
})();
