/**
 * Hard-restrict inference target URLs to the configured loopback base.
 * Never follow URLs from the infer payload — model server URL is local config only.
 */

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export type LoopbackConfig = {
  /** Absolute http(s) base, e.g. http://127.0.0.1:11434/v1 */
  baseUrl: string;
};

export function parseLoopbackBaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("Model base URL must be an absolute HTTP(S) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Model base URL must use http or https");
  }
  const host = url.hostname.toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `Model base URL host must be loopback (127.0.0.1/localhost), got "${url.hostname}"`,
    );
  }
  // Reject credentials / userinfo in URL
  if (url.username || url.password) {
    throw new Error("Model base URL must not include credentials");
  }
  return url;
}

/** Join base (…/v1) with a relative path like /chat/completions. */
export function loopbackRequestUrl(baseUrl: string, path: string): string {
  const base = parseLoopbackBaseUrl(baseUrl);
  const rel = path.startsWith("/") ? path.slice(1) : path;
  // Ensure single slash join against the base pathname
  const prefix = base.pathname.replace(/\/+$/, "");
  const joined = new URL(base.toString());
  joined.pathname = `${prefix}/${rel}`.replace(/\/{2,}/g, "/");
  joined.search = "";
  joined.hash = "";
  // Re-validate after join (defense in depth)
  parseLoopbackBaseUrl(joined.origin + "/");
  if (joined.hostname.toLowerCase() !== base.hostname.toLowerCase()) {
    throw new Error("Refusing redirect away from configured loopback host");
  }
  return joined.toString();
}

export function assertSameOriginLoopback(configuredBase: string, requestUrl: string): void {
  const base = parseLoopbackBaseUrl(configuredBase);
  let target: URL;
  try {
    target = new URL(requestUrl);
  } catch {
    throw new Error("Invalid request URL");
  }
  if (target.protocol !== base.protocol) {
    throw new Error("Request URL protocol must match configured base");
  }
  if (target.hostname.toLowerCase() !== base.hostname.toLowerCase()) {
    throw new Error("Request URL host must match configured loopback base");
  }
  if (target.port !== base.port) {
    throw new Error("Request URL port must match configured loopback base");
  }
}
