(() => {
  // Skip heavy DOM observers on auth pages (prevents login freezes).
  const __rkAuthPaths = new Set(["/sign-in", "/sign-up", "/forgot-password"]);
  if (__rkAuthPaths.has(location.pathname)) return;

  const SPACE_KEY = "rakazo:space-id";
  const STYLE_ID = "rk-social-style";
  const SECTION_ID = "rk-social-sections";
  let profile = null;
  let profilePromise = null;
  let searchTimer = 0;
  let avatarRefreshTimer = 0;

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
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      /* Product choice: share-link invites only; avatar lives in Settings > Account later */
      [data-rk="invite-search"], [data-rk="profile-image"] { display: none !important; }

      #${SECTION_ID}{margin:.9rem 0 0;border-top:1px solid #2a2a2e;padding-top:.9rem}
      #${SECTION_ID} .rk-social-block+ .rk-social-block{margin-top:.9rem}
      #${SECTION_ID} .rk-social-title{margin:0 0 .4rem;font-size:.9rem;font-weight:650;color:#f4f4f5}
      #${SECTION_ID} .rk-social-help{margin:0 0 .5rem;color:#8b8b95;font-size:12px}
      #${SECTION_ID} .rk-search-row{display:flex;gap:.45rem}
      #${SECTION_ID} input[type=text],#${SECTION_ID} input[type=url]{min-width:0;flex:1;box-sizing:border-box;border-radius:10px;border:1px solid #34343a;background:#0d0d0e;color:#e4e4e7;padding:.55rem .65rem;font:13px/1.25 ui-sans-serif,system-ui,sans-serif}
      #${SECTION_ID} .rk-results,#${SECTION_ID} .rk-received{display:flex;flex-direction:column;gap:.4rem;margin-top:.5rem}
      #${SECTION_ID} .rk-human{display:flex;align-items:center;gap:.6rem;border-radius:10px;background:#1c1c1f;padding:.45rem .5rem}
      #${SECTION_ID} .rk-human-meta{min-width:0;flex:1}
      #${SECTION_ID} .rk-human-meta strong,#${SECTION_ID} .rk-human-meta span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      #${SECTION_ID} .rk-human-meta strong{font-size:12.5px;color:#f4f4f5}
      #${SECTION_ID} .rk-human-meta span{font-size:11px;color:#777780}
      #${SECTION_ID} .rk-mini-avatar{width:30px;height:30px;flex:0 0 auto;border-radius:999px;object-fit:cover;background:#3ec5a8;color:#06251d;display:grid;place-items:center;font:700 11px/1 ui-sans-serif,system-ui,sans-serif}
      #${SECTION_ID} button{appearance:none;border:1px solid #3f3f46;background:#232326;color:#f4f4f5;border-radius:999px;padding:.4rem .68rem;font:600 11.5px/1.2 ui-sans-serif,system-ui,sans-serif;cursor:pointer}
      #${SECTION_ID} button.rk-primary{background:#3ec5a8;border-color:#3ec5a8;color:#06251d}
      #${SECTION_ID} button:disabled{opacity:.55;cursor:default}
      #${SECTION_ID} .rk-profile-preview{width:42px;height:42px;border-radius:999px;object-fit:cover;background:#29292d;display:grid;place-items:center;color:#aaa}
      #${SECTION_ID} .rk-profile-row{display:flex;align-items:center;gap:.6rem}
      #${SECTION_ID} .rk-profile-actions{display:flex;gap:.4rem;flex-wrap:wrap;margin-top:.5rem}
      #${SECTION_ID} .rk-social-status{min-height:1em;margin-top:.4rem;font-size:11.5px;color:#86efac}
      #${SECTION_ID} .rk-social-status.rk-err{color:#fca5a5}
      #rk-invite-root .rk-avatar img{width:100%;height:100%;border-radius:inherit;object-fit:cover}
      [data-rk-profile-avatar]{overflow:hidden}
      [data-rk-profile-avatar] img{width:100%;height:100%;display:block;object-fit:cover;border-radius:inherit}
    `;
    document.head.appendChild(style);
  }

  function initials(name) {
    const parts = String(name || "?")
      .replace(/^@/, "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    return (parts[0]?.[0] || "?") + (parts[1]?.[0] || "");
  }

  function avatar(image, name) {
    if (image) {
      const img = document.createElement("img");
      img.className = "rk-mini-avatar";
      img.src = image;
      img.alt = "";
      img.referrerPolicy = "no-referrer";
      return img;
    }
    const fallback = document.createElement("span");
    fallback.className = "rk-mini-avatar";
    fallback.textContent = initials(name).toUpperCase();
    return fallback;
  }

  function status(element, text, error = false) {
    element.textContent = text || "";
    element.classList.toggle("rk-err", error);
  }

  function humanRow(human, action) {
    const row = document.createElement("div");
    row.className = "rk-human";
    row.appendChild(avatar(human.image, human.name));
    const meta = document.createElement("div");
    meta.className = "rk-human-meta";
    const title = document.createElement("strong");
    title.textContent = human.username || human.name;
    const email = document.createElement("span");
    email.textContent = human.email || human.name || "";
    meta.append(title, email);
    row.appendChild(meta);
    if (action) row.appendChild(action);
    return row;
  }

  async function loadProfile() {
    if (profile) return profile;
    if (!profilePromise) {
      profilePromise = api("/api/profile")
        .then((next) => {
          profile = next;
          applyProfileAvatar();
          return profile;
        })
        .catch(() => null)
        .finally(() => {
          profilePromise = null;
        });
    }
    return profilePromise;
  }

  function applyProfileAvatar() {
    if (!profile) return;
    const trigger = document.querySelector('[data-testid="user-menu-trigger"]');
    const target = trigger?.querySelector("span");
    if (!target) return;
    const key = profile.image || `initials:${initials(profile.name).toUpperCase()}`;
    if (target.dataset.rkProfileImage === key) return;
    target.dataset.rkProfileImage = key;
    target.setAttribute("data-rk-profile-avatar", "1");
    target.replaceChildren();
    if (profile.image) {
      const img = document.createElement("img");
      img.src = profile.image;
      img.alt = "";
      img.referrerPolicy = "no-referrer";
      target.appendChild(img);
    } else {
      target.textContent = initials(profile.name).toUpperCase();
    }
  }

  function profileBlock() {
    const block = document.createElement("section");
    block.className = "rk-social-block";
    const title = document.createElement("h3");
    title.className = "rk-social-title";
    title.textContent = "Your profile image";
    const row = document.createElement("div");
    row.className = "rk-profile-row";
    const preview = document.createElement("div");
    preview.className = "rk-profile-preview";
    const url = document.createElement("input");
    url.type = "url";
    url.placeholder = "https://… or choose an image";
    url.value = profile?.image?.startsWith("http") ? profile.image : "";
    const paint = (image) => {
      preview.replaceChildren();
      if (image) preview.appendChild(avatar(image, profile?.name));
      else preview.textContent = initials(profile?.name).toUpperCase();
    };
    paint(profile?.image);
    row.append(preview, url);

    const actions = document.createElement("div");
    actions.className = "rk-profile-actions";
    const save = document.createElement("button");
    save.type = "button";
    save.className = "rk-primary";
    save.textContent = "Save URL";
    const choose = document.createElement("button");
    choose.type = "button";
    choose.textContent = "Choose image";
    const clear = document.createElement("button");
    clear.type = "button";
    clear.textContent = "Remove";
    const file = document.createElement("input");
    file.type = "file";
    file.accept = "image/png,image/jpeg,image/webp,image/gif";
    file.hidden = true;
    const message = document.createElement("div");
    message.className = "rk-social-status";

    async function persist(image) {
      save.disabled = choose.disabled = clear.disabled = true;
      status(message, "Saving…");
      try {
        profile = await api("/api/profile", {
          method: "PATCH",
          body: JSON.stringify({ image }),
        });
        url.value = profile.image?.startsWith("http") ? profile.image : "";
        paint(profile.image);
        applyProfileAvatar();
        status(message, "Profile image saved");
        document.dispatchEvent(new CustomEvent("rakazo:social-changed"));
      } catch (error) {
        status(message, error.message, true);
      } finally {
        save.disabled = choose.disabled = clear.disabled = false;
      }
    }

    save.addEventListener("click", () => void persist(url.value.trim() || null));
    clear.addEventListener("click", () => void persist(null));
    choose.addEventListener("click", () => file.click());
    file.addEventListener("change", () => {
      const selected = file.files?.[0];
      if (!selected) return;
      if (selected.size > 10 * 1024 * 1024) {
        status(message, "Choose an image smaller than 10 MB", true);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 256;
          const context = canvas.getContext("2d");
          if (!context) return;
          const side = Math.min(img.naturalWidth, img.naturalHeight);
          const x = (img.naturalWidth - side) / 2;
          const y = (img.naturalHeight - side) / 2;
          context.drawImage(img, x, y, side, side, 0, 0, 256, 256);
          void persist(canvas.toDataURL("image/webp", 0.82));
        };
        img.onerror = () => status(message, "Could not read that image", true);
        img.src = String(reader.result || "");
      };
      reader.readAsDataURL(selected);
    });
    actions.append(save, choose, clear, file);
    block.append(title, row, actions, message);
    return block;
  }

  function searchBlock() {
    const block = document.createElement("section");
    block.className = "rk-social-block";
    const title = document.createElement("h3");
    title.className = "rk-social-title";
    title.textContent = "Invite a registered human";
    const help = document.createElement("p");
    help.className = "rk-social-help";
    help.textContent = "Search by @username or email. New users can still join with the link above.";
    const input = document.createElement("input");
    input.type = "text";
    input.autocomplete = "off";
    input.placeholder = "@username or person@example.com";
    input.setAttribute("aria-label", "Search humans");
    const results = document.createElement("div");
    results.className = "rk-results";
    const message = document.createElement("div");
    message.className = "rk-social-status";

    async function runSearch() {
      const query = input.value.trim();
      results.replaceChildren();
      status(message, query.length < 2 ? "Enter at least 2 characters" : "Searching…");
      if (query.length < 2) return;
      try {
        const data = await api(`/api/users/search?q=${encodeURIComponent(query)}`);
        status(message, data.users.length ? "" : "No registered humans found");
        for (const human of data.users) {
          const invite = document.createElement("button");
          invite.type = "button";
          invite.textContent =
            human.membership === "member" ? "Member" : human.membership === "invited" ? "Invited" : "Invite";
          invite.disabled = human.membership !== "available";
          invite.addEventListener("click", async () => {
            invite.disabled = true;
            invite.textContent = "Inviting…";
            try {
              const result = await api("/api/space-invites/direct", {
                method: "POST",
                body: JSON.stringify({ userId: human.userId }),
              });
              invite.textContent = result.status === "already_member" ? "Member" : "Invited";
              status(message, `${human.username} can accept the invite from their People panel`);
            } catch (error) {
              invite.disabled = false;
              invite.textContent = "Invite";
              status(message, error.message, true);
            }
          });
          results.appendChild(humanRow(human, invite));
        }
      } catch (error) {
        status(message, error.message, true);
      }
    }
    input.addEventListener("input", () => {
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => void runSearch(), 250);
    });
    block.append(title, help, input, results, message);
    return block;
  }

  function receivedBlock() {
    const block = document.createElement("section");
    block.className = "rk-social-block";
    block.hidden = true;
    const title = document.createElement("h3");
    title.className = "rk-social-title";
    title.textContent = "Invitations for you";
    const list = document.createElement("div");
    list.className = "rk-received";
    block.append(title, list);

    block.load = async () => {
      try {
        const data = await api("/api/space-invites/received");
        block.hidden = !data.invites?.length;
        list.replaceChildren();
        for (const invite of data.invites || []) {
          const accept = document.createElement("button");
          accept.type = "button";
          accept.className = "rk-primary";
          accept.textContent = "Join";
          const decline = document.createElement("button");
          decline.type = "button";
          decline.textContent = "Decline";
          const actions = document.createElement("div");
          actions.style.display = "flex";
          actions.style.gap = ".3rem";
          actions.append(accept, decline);
          const row = humanRow(
            {
              name: invite.inviterName,
              username: invite.spaceName,
              email: `from ${invite.inviterName}`,
              image: invite.inviterImage,
            },
            actions,
          );
          accept.addEventListener("click", async () => {
            accept.disabled = decline.disabled = true;
            try {
              const joined = await api("/api/space-invites/redeem", {
                method: "POST",
                body: JSON.stringify({ token: invite.token }),
              });
              try {
                localStorage.setItem(SPACE_KEY, joined.spaceId);
              } catch (_) {}
              location.href = "/app";
            } catch (error) {
              accept.disabled = decline.disabled = false;
              accept.textContent = error.message;
            }
          });
          decline.addEventListener("click", async () => {
            accept.disabled = decline.disabled = true;
            try {
              await api("/api/space-invites/decline", {
                method: "POST",
                body: JSON.stringify({ token: invite.token }),
              });
              row.remove();
              if (!list.children.length) block.hidden = true;
            } catch (error) {
              accept.disabled = decline.disabled = false;
              decline.textContent = error.message;
            }
          });
          list.appendChild(row);
        }
      } catch (_) {
        block.hidden = true;
      }
    };
    return block;
  }

  async function enhancePanel(root) {
    if (root.querySelector(`#${SECTION_ID}`) || root.dataset.rkSocialEnhancing === "1") return;
    root.dataset.rkSocialEnhancing = "1";
    await loadProfile();
    const card = root.querySelector(".rk-card");
    if (!card) {
      delete root.dataset.rkSocialEnhancing;
      return;
    }
    const sections = document.createElement("div");
    sections.id = SECTION_ID;
    const incoming = receivedBlock();
    sections.append(incoming, searchBlock(), profileBlock());
    const peopleTitle = Array.from(card.querySelectorAll("h2")).find((item) =>
      item.textContent?.includes("In this space"),
    );
    if (peopleTitle) card.insertBefore(sections, peopleTitle);
    else card.appendChild(sections);
    void incoming.load();
    delete root.dataset.rkSocialEnhancing;
  }


  function hideRetiredSocialBlocks(root) {
    if (!root) return;
    root.querySelectorAll("h3,h4,.rk-social-title,strong,div").forEach((el) => {
      const text = (el.textContent || "").trim();
      if (/^Invite a registered human/i.test(text)) {
        const block = el.closest(".rk-social-block") || el.parentElement;
        if (block) block.setAttribute("data-rk", "invite-search");
      }
      if (/^Your profile image/i.test(text)) {
        const block = el.closest(".rk-social-block") || el.parentElement;
        if (block) block.setAttribute("data-rk", "profile-image");
      }
    });
  }

  function scan() {
    hideRetiredSocialBlocks(document);
    ensureStyles();
    const root = document.getElementById("rk-invite-root");
    if (root) void enhancePanel(root);
    window.clearTimeout(avatarRefreshTimer);
    avatarRefreshTimer = window.setTimeout(() => {
      if (!document.querySelector('[data-testid="user-menu-trigger"]')) return;
      if (profile) applyProfileAvatar();
      else void loadProfile();
    }, 50);
  }

  function boot() {
    ensureStyles();
    scan();
    const observer = new MutationObserver(scan);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
    document.addEventListener("rakazo:social-changed", scan);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
