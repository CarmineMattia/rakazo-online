(() => {
  const STORAGE_KEY = "rakazo.botTimePrefs";
  const STYLE_ID = "rk-bot-time-style";
  const FIELD_ID = "rk-bot-time-field";

  const PRESETS = {
    it: {
      id: "it",
      label: "Italiano · Europe/Rome",
      locale: "it-IT",
      timeZone: "Europe/Rome",
      today: "oggi alle",
      yesterday: "ieri alle",
      delivered: "Consegnato",
    },
    en: {
      id: "en",
      label: "English · Europe/London",
      locale: "en-GB",
      timeZone: "Europe/London",
      today: "Today",
      yesterday: "Yesterday",
      delivered: "Delivered",
    },
    "en-us": {
      id: "en-us",
      label: "English · US",
      locale: "en-US",
      timeZone: "America/New_York",
      today: "Today",
      yesterday: "Yesterday",
      delivered: "Delivered",
    },
    browser: {
      id: "browser",
      label: "Browser default",
      locale: null,
      timeZone: null,
      today: "Today",
      yesterday: "Yesterday",
      delivered: "Delivered",
    },
  };

  const DEFAULT_PRESET = "it";

  function readAll() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function writeAll(map) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
    } catch (_) {}
  }

  function resolvePreset(entry) {
    if (!entry) return PRESETS[DEFAULT_PRESET];
    if (typeof entry === "string" && PRESETS[entry]) return PRESETS[entry];
    if (entry.preset && PRESETS[entry.preset]) {
      const base = PRESETS[entry.preset];
      return {
        ...base,
        locale: entry.locale || base.locale,
        timeZone: entry.timeZone || base.timeZone,
      };
    }
    if (entry.locale || entry.timeZone) {
      return {
        id: "custom",
        label: "Custom",
        locale: entry.locale || "it-IT",
        timeZone: entry.timeZone || "Europe/Rome",
        today: entry.locale && String(entry.locale).startsWith("it") ? "oggi alle" : "Today",
        yesterday: entry.locale && String(entry.locale).startsWith("it") ? "ieri alle" : "Yesterday",
        delivered: entry.locale && String(entry.locale).startsWith("it") ? "Consegnato" : "Delivered",
      };
    }
    return PRESETS[DEFAULT_PRESET];
  }

  function getPrefs(botId) {
    if (!botId) return resolvePreset(null);
    const all = readAll();
    return resolvePreset(all[botId] || null);
  }

  function setPrefs(botId, presetId) {
    if (!botId || !PRESETS[presetId]) return getPrefs(botId);
    const all = readAll();
    all[botId] = { preset: presetId };
    writeAll(all);
    try {
      window.dispatchEvent(
        new CustomEvent("rk-bot-time-changed", { detail: { botId: botId, preset: presetId } }),
      );
    } catch (_) {}
    return getPrefs(botId);
  }

  function currentBotId() {
    try {
      const path = window.location.pathname || "";
      const parts = path.split("/");
      if (parts[1] === "app" && parts[2] && parts[2] !== "g") {
        return decodeURIComponent(parts[2]);
      }
    } catch (_) {}
    return null;
  }

  function dayStamp(date, timeZone) {
    try {
      const opts = { year: "numeric", month: "2-digit", day: "2-digit" };
      if (timeZone) opts.timeZone = timeZone;
      return new Intl.DateTimeFormat("en-CA", opts).format(date);
    } catch (_) {
      const d = new Date(date);
      d.setHours(0, 0, 0, 0);
      return String(d.getTime());
    }
  }

  function dayDiff(a, b, timeZone) {
    const aa = dayStamp(a, timeZone);
    const bb = dayStamp(b, timeZone);
    if (aa === bb) return 0;
    const parse = (s) => {
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        const [y, m, d] = s.split("-").map(Number);
        return Date.UTC(y, m - 1, d);
      }
      return Number(s) || 0;
    };
    return Math.round((parse(bb) - parse(aa)) / 864e5);
  }

  function clock(date, prefs) {
    const opts = { hour: "2-digit", minute: "2-digit", hour12: false };
    if (prefs.timeZone) opts.timeZone = prefs.timeZone;
    let out;
    try {
      out = date.toLocaleTimeString(prefs.locale || undefined, opts);
    } catch (_) {
      out = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
    }
    // Italian often writes times with a dot (14.56).
    if (prefs.id === "it" || (prefs.locale && String(prefs.locale).toLowerCase().startsWith("it"))) {
      out = String(out).replace(":", ".");
    }
    return out;
  }

  function formatChatTime(iso, botId) {
    if (!iso) return "";
    const date = new Date(iso);
    if (isNaN(date.getTime())) return "";
    const prefs = getPrefs(botId || currentBotId());
    const now = new Date();
    const time = clock(date, prefs);
    const diff = dayDiff(date, now, prefs.timeZone);
    if (diff === 0) return prefs.today + " " + time;
    if (diff === 1) return prefs.yesterday + " " + time;
    const dateOpts = diff < 7
      ? { weekday: "short" }
      : { day: "2-digit", month: "short" };
    if (prefs.timeZone) dateOpts.timeZone = prefs.timeZone;
    try {
      return date.toLocaleDateString(prefs.locale || undefined, dateOpts) + " " + time;
    } catch (_) {
      return date.toLocaleDateString(undefined, dateOpts) + " " + time;
    }
  }

  function formatClock(iso, botId) {
    if (!iso) return "";
    const date = new Date(iso);
    if (isNaN(date.getTime())) return "";
    return clock(date, getPrefs(botId || currentBotId()));
  }

  function formatReceipt(iso, botId) {
    const prefs = getPrefs(botId || currentBotId());
    const t = formatClock(iso, botId);
    if (!t) return "";
    return t + " · " + prefs.delivered;
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent =
      "#" + FIELD_ID + "{display:block;margin:0.85rem 0 0.35rem}" +
      "#" + FIELD_ID + " .rk-bot-time-label{display:block;font-size:14px;color:var(--foreground, #e8e8ea);margin-bottom:0.4rem}" +
      "#" + FIELD_ID + " select{width:100%;margin-top:0;border-radius:0.5rem;border:1px solid var(--border, #2a2a2e);background:var(--background, #0d0d0e);color:inherit;padding:0.45rem 0.6rem;font:inherit}" +
      "#" + FIELD_ID + " .rk-bot-time-hint{margin:0.35rem 0 0;font-size:12px;color:var(--muted-foreground, #a1a1aa)}";
    document.head.appendChild(style);
  }

  function injectField(details) {
    if (!details || details.querySelector("#" + FIELD_ID)) return;
    const botId = currentBotId();
    if (!botId) return;
    ensureStyles();
    const wrap = document.createElement("label");
    wrap.id = FIELD_ID;
    wrap.htmlFor = "rk-bot-time-select";
    const title = document.createElement("span");
    title.className = "rk-bot-time-label";
    title.textContent = "Time display";
    const select = document.createElement("select");
    select.id = "rk-bot-time-select";
    select.setAttribute("aria-label", "Time display");
    const current = getPrefs(botId);
    Object.keys(PRESETS).forEach((key) => {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = PRESETS[key].label;
      if (key === (current.id === "custom" ? DEFAULT_PRESET : current.id)) opt.selected = true;
      select.appendChild(opt);
    });
    select.addEventListener("change", () => {
      setPrefs(botId, select.value);
      const hint = wrap.querySelector(".rk-bot-time-hint");
      if (hint) hint.textContent = "Saved for this bot. Times refresh as the chat updates.";
    });
    const hint = document.createElement("p");
    hint.className = "rk-bot-time-hint";
    hint.textContent = "Default is Italian (Europe/Rome). Affects sidebar, header, and message times.";
    wrap.appendChild(title);
    wrap.appendChild(select);
    wrap.appendChild(hint);
    const summary = details.querySelector("summary");
    if (summary && summary.nextSibling) {
      details.insertBefore(wrap, summary.nextSibling);
    } else {
      details.appendChild(wrap);
    }
  }

  function scan() {
    document.querySelectorAll('[data-testid="bot-settings-advanced"]').forEach(injectField);
  }

  window.__rkBotTime = {
    PRESETS: PRESETS,
    DEFAULT_PRESET: DEFAULT_PRESET,
    getPrefs: getPrefs,
    setPrefs: setPrefs,
    currentBotId: currentBotId,
    formatChatTime: formatChatTime,
    formatClock: formatClock,
    formatReceipt: formatReceipt,
  };

  function boot() {
    scan();
    const obs = new MutationObserver(() => scan());
    obs.observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
