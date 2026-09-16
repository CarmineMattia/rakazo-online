(() => {
  const STYLE_ID = "rk-account-avatar-style";
  const MOUNT_ID = "rk-account-avatar-mount";
  const SPACE_KEY = "rakazo:space-id";

  let profile = null;
  let profilePromise = null;
  let debounce = 0;

  function spaceHeaders(init) {
    const headers = new Headers(init || {});
    try {
      const spaceId = localStorage.getItem(SPACE_KEY);
      if (spaceId) headers.set("x-rakazo-space-id", spaceId);
    } catch (_) {}
    return headers;
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      credentials: "include",
      ...options,
      headers: spaceHeaders({
        "content-type": "application/json",
        ...(options.headers || {}),
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || data.message || `Request failed (${response.status})`);
    return data;
  }

  async function loadProfile() {
    if (profile) return profile;
    if (!profilePromise) {
      profilePromise = api("/api/profile")
        .then((next) => {
          profile = next;
          return profile;
        })
        .catch((err) => {
          profilePromise = null;
          throw err;
        });
    }
    return profilePromise;
  }

  function initials(name) {
    const parts = String(name || "").replace(/^@/, "").trim().split(/\s+/).filter(Boolean);
    const a = (parts[0] || "?").slice(0, 1);
    const b = (parts[1] || "").slice(0, 1);
    return (a + b).toUpperCase() || "?";
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${MOUNT_ID}{display:flex;align-items:center;gap:.85rem;margin:0 0 .85rem}
      #${MOUNT_ID} .rk-acc-avatar{
        width:56px;height:56px;border-radius:999px;overflow:hidden;flex:0 0 auto;
        border:1px solid color-mix(in oklab, var(--border,#2a2a2e) 80%, transparent);
        background:#29292d;color:#ddd;display:grid;place-items:center;
        font:700 16px/1 ui-sans-serif,system-ui,sans-serif;cursor:pointer;
        position:relative;
      }
      #${MOUNT_ID} .rk-acc-avatar:focus-visible{outline:2px solid #3ec5a8;outline-offset:2px}
      #${MOUNT_ID} .rk-acc-avatar img{width:100%;height:100%;object-fit:cover;display:block}
      #${MOUNT_ID} .rk-acc-avatar .rk-acc-hint{
        position:absolute;inset:auto 0 0 0;padding:.15rem .2rem;font:600 9px/1.1 ui-sans-serif,system-ui,sans-serif;
        text-align:center;background:rgba(0,0,0,.55);color:#fff;opacity:0;transition:opacity .15s;
      }
      #${MOUNT_ID} .rk-acc-avatar:hover .rk-acc-hint,
      #${MOUNT_ID} .rk-acc-avatar:focus-visible .rk-acc-hint{opacity:1}
      #${MOUNT_ID} .rk-acc-copy{min-width:0;flex:1}
      #${MOUNT_ID} .rk-acc-copy strong{display:block;font:650 13px/1.3 ui-sans-serif,system-ui,sans-serif;color:var(--foreground,#f4f4f5)}
      #${MOUNT_ID} .rk-acc-copy span{display:block;margin-top:.2rem;font:12px/1.35 ui-sans-serif,system-ui,sans-serif;color:var(--muted-foreground,#a1a1aa)}
      #${MOUNT_ID} .rk-acc-status{margin-top:.35rem;font:12px/1.3 ui-sans-serif,system-ui,sans-serif;color:var(--muted-foreground,#a1a1aa)}
      #${MOUNT_ID} .rk-acc-status.err{color:#fca5a5}
      #${MOUNT_ID} .rk-acc-actions{display:flex;gap:.4rem;flex-wrap:wrap;margin-top:.45rem}
      #${MOUNT_ID} .rk-acc-actions button{
        appearance:none;border:1px solid color-mix(in oklab, var(--border,#2a2a2e) 90%, transparent);
        background:transparent;color:var(--foreground,#f4f4f5);border-radius:999px;padding:.28rem .7rem;
        font:600 12px/1.2 ui-sans-serif,system-ui,sans-serif;cursor:pointer
      }
      #${MOUNT_ID} .rk-acc-actions button:disabled{opacity:.5;cursor:default}
    `;
    document.documentElement.appendChild(style);
  }

  function findAccountSection(settingsRoot) {
    if (!settingsRoot) return null;
    const headings = [...settingsRoot.querySelectorAll("h3")];
    const account = headings.find((h) => /^Account$/i.test((h.textContent || "").trim()));
    return account ? account.closest("section") || account.parentElement : null;
  }

  function paintButton(btn, image, name) {
    btn.replaceChildren();
    if (image) {
      const img = document.createElement("img");
      img.alt = "";
      img.src = image;
      btn.appendChild(img);
    } else {
      btn.textContent = initials(name);
    }
    const hint = document.createElement("span");
    hint.className = "rk-acc-hint";
    hint.textContent = "Change";
    btn.appendChild(hint);
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      if (!file) return reject(new Error("No file selected"));
      if (file.size > 256 * 1024) return reject(new Error("Image must be 256 KB or smaller"));
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Could not read image"));
      reader.onload = () => resolve(String(reader.result || ""));
      reader.readAsDataURL(file);
    });
  }

  async function ensureMount() {
    const settings = document.querySelector('[data-testid="user-settings"]');
    if (!settings) {
      document.getElementById(MOUNT_ID)?.remove();
      return;
    }
    // Only on General (Account lives there)
    const generalNav = settings.querySelector('[data-testid="settings-nav-general"]');
    const onGeneral =
      !generalNav ||
      generalNav.getAttribute("aria-current") === "page" ||
      generalNav.getAttribute("data-active") != null ||
      generalNav.className.includes("bg-") && /pressed|active|bg-accent|bg-sidebar/i.test(generalNav.className) ||
      settings.getAttribute("data-settings-section") === "general";
    // Fallback: Account heading present
    const accountSection = findAccountSection(settings);
    if (!accountSection) {
      document.getElementById(MOUNT_ID)?.remove();
      return;
    }
    if (!onGeneral && settings.getAttribute("data-settings-section") && settings.getAttribute("data-settings-section") !== "general") {
      document.getElementById(MOUNT_ID)?.remove();
      return;
    }

    ensureStyles();
    let mount = document.getElementById(MOUNT_ID);
    if (!mount) {
      mount = document.createElement("div");
      mount.id = MOUNT_ID;
      const heading = accountSection.querySelector("h3");
      if (heading && heading.nextSibling) accountSection.insertBefore(mount, heading.nextSibling);
      else accountSection.prepend(mount);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rk-acc-avatar";
      btn.setAttribute("aria-label", "Change profile image");
      const copy = document.createElement("div");
      copy.className = "rk-acc-copy";
      copy.innerHTML =
        "<strong>Profile photo</strong><span>Click the image to upload. PNG/JPEG/WebP/GIF, max 256 KB.</span>";
      const status = document.createElement("div");
      status.className = "rk-acc-status";
      status.hidden = true;
      const actions = document.createElement("div");
      actions.className = "rk-acc-actions";
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.textContent = "Remove photo";
      actions.appendChild(removeBtn);
      copy.append(status, actions);
      const file = document.createElement("input");
      file.type = "file";
      file.accept = "image/png,image/jpeg,image/webp,image/gif";
      file.hidden = true;
      mount.append(btn, copy, file);

      async function persist(image) {
        status.hidden = false;
        status.classList.remove("err");
        status.textContent = "Saving…";
        btn.disabled = removeBtn.disabled = true;
        try {
          profile = await api("/api/profile", {
            method: "PATCH",
            body: JSON.stringify({ image }),
          });
          paintButton(btn, profile.image, profile.name);
          status.textContent = image ? "Photo saved" : "Photo removed";
          document.dispatchEvent(new CustomEvent("rakazo:social-changed"));
        } catch (error) {
          status.classList.add("err");
          status.textContent = error.message || "Could not save photo";
        } finally {
          btn.disabled = removeBtn.disabled = false;
        }
      }

      btn.addEventListener("click", () => file.click());
      removeBtn.addEventListener("click", () => void persist(null));
      file.addEventListener("change", () => {
        const chosen = file.files && file.files[0];
        file.value = "";
        if (!chosen) return;
        void fileToDataUrl(chosen)
          .then((dataUrl) => persist(dataUrl))
          .catch((error) => {
            status.hidden = false;
            status.classList.add("err");
            status.textContent = error.message || "Could not read image";
          });
      });
    }

    try {
      const p = await loadProfile();
      const btn = mount.querySelector(".rk-acc-avatar");
      if (btn) paintButton(btn, p.image, p.name);
    } catch (_) {
      // ignore while logged-out edge cases
    }
  }

  function schedule() {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = 0;
      void ensureMount();
    }, 100);
  }

  function boot() {
    schedule();
    const obs = new MutationObserver(schedule);
    obs.observe(document.getElementById("root") || document.body, { childList: true, subtree: true });
    document.addEventListener("rakazo:social-changed", schedule);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
