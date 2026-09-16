(() => {
  const STYLE_ID = "rk-magic-auth-style";
  const BANNER_ID = "rk-magic-auth-banner";
  const AUTH_PATHS = new Set(["/sign-in", "/sign-up", "/forgot-password"]);

  let caps = null;
  let capsPromise = null;
  let enhancing = false;
  let lastSignature = "";
  let formBound = false;
  let debounceTimer = 0;

  function isAuthPath() {
    return AUTH_PATHS.has(location.pathname);
  }
  function isSignUp() {
    return location.pathname === "/sign-up";
  }
  function isSignIn() {
    return location.pathname === "/sign-in";
  }

  async function loadCaps() {
    if (caps) return caps;
    if (!capsPromise) {
      capsPromise = fetch("/api/auth/capabilities", { credentials: "include" })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          caps = data || { magicLink: false };
          return caps;
        })
        .catch(() => {
          caps = { magicLink: false };
          return caps;
        });
    }
    return capsPromise;
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${BANNER_ID}{margin:0 0 .85rem;padding:.7rem .85rem;border-radius:12px;border:1px solid color-mix(in oklab, var(--border, #2a2a2e) 80%, transparent);background:color-mix(in oklab, var(--muted, #1c1c1f) 70%, transparent);color:var(--muted-foreground, #a1a1aa);font:13px/1.4 ui-sans-serif,system-ui,sans-serif}
      #${BANNER_ID} strong{color:var(--foreground, #f4f4f5);font-weight:650}
      #${BANNER_ID} a{color:var(--foreground, #f4f4f5);font-weight:600}
      body.rk-auth-signin{--rk-auth-accent:#3ec5a8;--rk-auth-accent-fg:#06251d}
      body.rk-auth-signin #${BANNER_ID}{border-color:color-mix(in oklab, #3ec5a8 35%, var(--border,#2a2a2e));background:linear-gradient(160deg,rgba(62,197,168,.14),transparent 70%),color-mix(in oklab, var(--muted,#1c1c1f) 70%, transparent)}
      body.rk-auth-signin form button[type="submit"]{background:var(--rk-auth-accent)!important;border-color:var(--rk-auth-accent)!important;color:var(--rk-auth-accent-fg)!important}
      body.rk-auth-signup{--rk-auth-accent:#e8a54b;--rk-auth-accent-fg:#2a1a05}
      body.rk-auth-signup #${BANNER_ID}{border-color:color-mix(in oklab, #e8a54b 40%, var(--border,#2a2a2e));background:linear-gradient(160deg,rgba(232,165,75,.16),transparent 70%),color-mix(in oklab, var(--muted,#1c1c1f) 70%, transparent)}
      body.rk-auth-signup form button[type="submit"]{background:var(--rk-auth-accent)!important;border-color:var(--rk-auth-accent)!important;color:var(--rk-auth-accent-fg)!important}
      /* Magic-only: never show password fields on auth pages */
      body.rk-magic-auth [data-rk-password-wrap],
      body.rk-magic-auth input#current-password,
      body.rk-magic-auth input#new-password,
      body.rk-magic-auth input[name="password"],
      body.rk-magic-auth input[type="password"],
      body.rk-magic-auth label[for="current-password"],
      body.rk-magic-auth label[for="new-password"],
      body.rk-magic-auth label[for="password"],
      body.rk-magic-auth a[href="/forgot-password"],
      body.rk-magic-auth a[href*="forgot-password"]{display:none !important}
      body.rk-auth-signin.rk-magic-auth #name,
      body.rk-auth-signin.rk-magic-auth label[for="name"]{display:none !important}
      body.rk-auth-signup #name,
      body.rk-auth-signup label[for="name"]{display:revert !important}
      .rk-handle-hint{margin:.15rem 0 .55rem;font-size:12px;color:var(--muted-foreground,#a1a1aa)}
      .rk-existing-banner{margin:0 0 .85rem;padding:.75rem .9rem;border-radius:12px;border:1px solid color-mix(in oklab,#3ec5a8 45%,transparent);background:rgba(62,197,168,.12);color:var(--foreground,#f4f4f5);font:13px/1.4 ui-sans-serif,system-ui,sans-serif}
    `;
    document.documentElement.appendChild(style);
  }

  function findAuthForm() {
    const email = document.querySelector('form input#email, form input[name="email"]');
    return email ? email.closest("form") : null;
  }

  function wrapPasswordFields(form) {
    const password = form.querySelector(
      'input#current-password, input#new-password, input[name="password"], input[type="password"]',
    );
    if (!password) return;
    let wrap = password.closest("[data-rk-password-wrap]");
    if (wrap) return;
    wrap = password.parentElement;
    if (!wrap || wrap === form) return;
    // climb to include label if present
    let node = wrap;
    while (node && node !== form && !node.querySelector("label")) {
      node = node.parentElement;
    }
    const target = node && node !== form ? node : wrap;
    if (!target.getAttribute("data-rk-password-wrap")) {
      target.setAttribute("data-rk-password-wrap", "1");
    }
  }

  function normalizeHandle(raw) {
    let v = String(raw || "").trim();
    if (v.startsWith("@")) v = v.slice(1);
    v = v.replace(/[^a-zA-Z0-9_]/g, "");
    return v.slice(0, 32);
  }

  function setSubmitLabel(form, text) {
    const btn = form.querySelector('button[type="submit"]');
    if (!btn || btn.getAttribute("data-rk-submit-label") === text) return;
    btn.setAttribute("data-rk-submit-label", text);
    const span = btn.querySelector("span");
    if (span && span.childElementCount === 0) {
      span.textContent = text;
      return;
    }
    if (btn.childElementCount === 0) {
      btn.textContent = text;
      return;
    }
    for (const node of btn.childNodes) {
      if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
        node.textContent = text;
        return;
      }
    }
  }

  function ensureHumanNameField(form) {
    const nameInput = form.querySelector('input#name, input[name="name"]');
    if (!nameInput) return null;
    if (nameInput.placeholder !== "@yourname") nameInput.placeholder = "@yourname";
    nameInput.autoComplete = "username";
    nameInput.maxLength = 32;
    const label = form.querySelector('label[for="name"]');
    if (label && label.textContent !== "@human name") label.textContent = "@human name";
    let hint = form.querySelector("[data-rk-handle-hint]");
    if (!hint && isSignUp()) {
      hint = document.createElement("p");
      hint.className = "rk-handle-hint";
      hint.setAttribute("data-rk-handle-hint", "1");
      hint.textContent = "How others will see you — letters, numbers, _ (e.g. @crime).";
      nameInput.insertAdjacentElement("afterend", hint);
    }
    if (hint) hint.style.display = isSignUp() ? "" : "none";
    return nameInput;
  }

  function ensureExistingEmailBanner() {
    const params = new URLSearchParams(location.search);
    if (!isSignIn() || params.get("existing") !== "1") {
      document.getElementById("rk-existing-email")?.remove();
      return;
    }
    const form = findAuthForm();
    if (!form || document.getElementById("rk-existing-email")) return;
    const el = document.createElement("div");
    el.id = "rk-existing-email";
    el.className = "rk-existing-banner";
    el.innerHTML =
      "<strong>You already have an account</strong> with that email — sign in here instead.";
    form.prepend(el);
    const email = params.get("email");
    const emailInput = form.querySelector('input#email, form input[name="email"]');
    if (email && emailInput && !emailInput.value) emailInput.value = email;
  }

  function ensureBanner(form) {
    let banner = document.getElementById(BANNER_ID);
    if (!banner) {
      banner = document.createElement("div");
      banner.id = BANNER_ID;
      form.prepend(banner);
    }
    const emulatorHint = caps?.emailEmulator
      ? ` Dev: open <a href="/api/dev/emails" target="_blank" rel="noreferrer">/api/dev/emails</a> for the link.`
      : "";
    const html = isSignUp()
      ? `<strong>Create your account</strong> — email + @human name, then we email you a magic link.${emulatorHint}`
      : `<strong>Welcome back</strong> — enter your email and we’ll send a magic link.${emulatorHint}`;
    if (banner.dataset.rkHtml !== html) {
      banner.dataset.rkHtml = html;
      banner.innerHTML = html;
    }
    setSubmitLabel(form, "Send magic link");
  }

  function destinationUrls() {
    const params = new URLSearchParams(location.search);
    const next = params.get("next");
    const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : null;
    const origin = (caps && caps.webOrigin) || location.origin;
    return {
      callbackURL: `${origin}${safeNext || "/app"}`,
      newUserCallbackURL: `${origin}/onboarding`,
      errorCallbackURL: `${origin}/sign-in`,
    };
  }

  async function checkEmailExists(email) {
    const res = await fetch("/api/auth/check-email", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Could not check email");
    return Boolean(data.exists);
  }

  async function sendMagicLink(email, name) {
    const { callbackURL, newUserCallbackURL, errorCallbackURL } = destinationUrls();
    const body = { email, callbackURL, newUserCallbackURL, errorCallbackURL };
    if (name) body.name = name;
    const res = await fetch("/api/auth/sign-in/magic-link", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json", origin: location.origin },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg =
        data.message || data.error || data.statusText || `Could not send link (${res.status})`;
      throw new Error(typeof msg === "string" ? msg : "Could not send link");
    }
    return data;
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async function latestEmulatorLink(forEmail) {
    try {
      const res = await fetch("/api/dev/emails", { credentials: "include" });
      if (!res.ok) return null;
      const list = await res.json();
      if (!Array.isArray(list)) return null;
      const match = list.find(
        (m) =>
          String(m.to || "").toLowerCase() === String(forEmail || "").toLowerCase() &&
          /magic-link\/verify/.test(String(m.text || m.html || "")),
      );
      const raw = match?.text || match?.html || "";
      const m = String(raw).match(/https?:\/\/[^\s"'<>]+magic-link\/verify[^\s"'<>]*/);
      if (!m) return null;
      try {
        const u = new URL(m[0].replace(/&amp;/g, "&"));
        const origin = (caps && caps.webOrigin) || location.origin;
        return `${origin}${u.pathname}${u.search}`;
      } catch {
        return m[0].replace(/&amp;/g, "&");
      }
    } catch {
      return null;
    }
  }

  async function showSentState(form, email) {
    const stayOn = (caps && caps.webOrigin) || location.origin;
    form.innerHTML = `
      <div id="${BANNER_ID}" style="text-align:center">
        <strong>Check your email</strong>
        <p style="margin:.5rem 0 0">We sent a link to <strong>${escapeHtml(email)}</strong>. Click it to continue.</p>
        <p style="margin:.55rem 0 0;font-size:12.5px;opacity:.8">Stay on <strong>${escapeHtml(stayOn)}</strong> after clicking.</p>
        <p data-rk="emu" style="margin:.75rem 0 0;font-size:13px;opacity:.85"></p>
        <p style="margin:1rem 0 0"><a href="/sign-in">Back to sign in</a></p>
      </div>`;
    lastSignature = "sent:" + email;
    formBound = false;
    const emu = form.querySelector("[data-rk=emu]");
    if (!caps?.emailEmulator || !emu) return;
    emu.textContent = "Loading local sign-in link…";
    const link = await latestEmulatorLink(email);
    if (link) emu.innerHTML = `Local mail: <a href="${escapeHtml(link)}">Open magic link</a>`;
    else emu.innerHTML = `Open <a href="/api/dev/emails" target="_blank" rel="noreferrer">/api/dev/emails</a>.`;
  }

  function showAlert(form, message) {
    let alert = form.querySelector('[role="alert"]');
    if (!alert) {
      alert = document.createElement("p");
      alert.setAttribute("role", "alert");
      alert.style.cssText = "margin-top:.75rem;font-size:13px;color:#fca5a5";
      const btn = form.querySelector('button[type="submit"]');
      btn?.insertAdjacentElement("beforebegin", alert);
    }
    alert.textContent = message;
  }

  function attachForm(form) {
    if (form.dataset.rkMagicBound === "1") return;
    form.dataset.rkMagicBound = "1";
    formBound = true;
    wrapPasswordFields(form);
    ensureHumanNameField(form);
    ensureBanner(form);
    ensureExistingEmailBanner();

    const nameInput = form.querySelector('input#name, input[name="name"]');
    nameInput?.addEventListener("input", () => {
      if (!isSignUp()) return;
      const before = nameInput.value;
      const normalized = normalizeHandle(before);
      const display = normalized ? `@${normalized}` : before.startsWith("@") ? "@" : "";
      if (display !== before) nameInput.value = display;
    });

    form.addEventListener(
      "submit",
      async (event) => {
        if (!caps?.magicLink && !isSignUp()) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const emailInput = form.querySelector('input#email, input[name="email"]');
        const email = (emailInput?.value || "").trim().toLowerCase();
        if (!email) return;
        const handle = isSignUp() ? normalizeHandle(nameInput?.value || "") : "";
        if (isSignUp() && (!handle || handle.length < 2)) {
          showAlert(form, "Pick an @human name (at least 2 characters).");
          return;
        }
        const btn = form.querySelector('button[type="submit"]');
        if (btn) btn.disabled = true;
        try {
          if (isSignUp() && (await checkEmailExists(email))) {
            location.assign(`/sign-in?existing=1&email=${encodeURIComponent(email)}`);
            return;
          }
          await sendMagicLink(email, handle || undefined);
          await showSentState(form, email);
        } catch (error) {
          showAlert(form, error.message || "Could not send magic link");
          if (btn) btn.disabled = false;
        }
      },
      true,
    );
  }

  async function enhance() {
    if (enhancing) return;
    enhancing = true;
    try {
      if (!isAuthPath()) {
        document.body.classList.remove("rk-magic-auth", "rk-auth-signin", "rk-auth-signup");
        document.getElementById(BANNER_ID)?.remove();
        lastSignature = "";
        formBound = false;
        return;
      }

      // Forgot-password → bounce to magic sign-in
      if (location.pathname === "/forgot-password") {
        location.replace("/sign-in");
        return;
      }

      ensureStyles();
      document.body.classList.toggle("rk-auth-signin", isSignIn());
      document.body.classList.toggle("rk-auth-signup", isSignUp());

      const capabilities = await loadCaps();
      if (!capabilities?.magicLink && !isSignUp()) {
        ensureExistingEmailBanner();
        return;
      }

      document.body.classList.add("rk-magic-auth");
      const form = findAuthForm();
      if (!form) return;

      const signature = `${location.pathname}|${location.search}|${form.dataset.rkMagicBound || "0"}`;
      if (signature === lastSignature && form.dataset.rkMagicBound === "1") {
        // Soft refresh only labels / password wrap (no innerHTML churn)
        wrapPasswordFields(form);
        setSubmitLabel(form, "Send magic link");
        return;
      }
      lastSignature = signature;
      attachForm(form);
      wrapPasswordFields(form);
      ensureHumanNameField(form);
      ensureBanner(form);
      ensureExistingEmailBanner();
    } finally {
      enhancing = false;
    }
  }

  function scheduleEnhance() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = 0;
      enhance();
    }, 80);
  }

  function boot() {
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      enhance();
      if ((isAuthPath() && findAuthForm()) || tries > 40) clearInterval(timer);
    }, 250);

    const obs = new MutationObserver(() => {
      if (isAuthPath()) scheduleEnhance();
    });
    obs.observe(document.getElementById("root") || document.body, {
      childList: true,
      subtree: true,
    });

    window.addEventListener("popstate", scheduleEnhance);
    const push = history.pushState;
    history.pushState = function (...args) {
      push.apply(this, args);
      scheduleEnhance();
    };
    const replace = history.replaceState;
    history.replaceState = function (...args) {
      replace.apply(this, args);
      scheduleEnhance();
    };
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
