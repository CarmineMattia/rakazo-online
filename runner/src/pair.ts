/**
 * `rakazo-runner pair --server URL --code CODE [--name NAME]` (M2a).
 * Redeems a one-time pairing code for a device token and stores it in the
 * private credentials file. The token is never printed.
 */
import { hostname } from "node:os";
import {
  assertSecureTransport,
  readConfig,
  readCredentials,
  writeConfig,
  writeCredentials,
} from "./config.ts";

const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32

/** Same normalisation as the server: upper-case, drop separators, O→0, I/L→1. */
export function normalizePairingCode(raw: string): string {
  const s = raw
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (s.length !== 8 || [...s].some((ch) => !CODE_ALPHABET.includes(ch))) {
    throw new Error("The pairing code looks wrong: it has 8 letters/digits, like K7QF-3MZD");
  }
  return s;
}

export function normalizeServer(raw: string): string {
  const url = assertSecureTransport(raw.trim(), "server");
  return url.origin;
}

export function platformTag(): string {
  return `${process.platform}-${process.arch}`.slice(0, 40);
}

/** Only hand an existing token back to the server that issued it. */
export function sameServer(
  creds: { server?: string; gatewayWsUrl: string },
  server: string,
): boolean {
  if (creds.server) return creds.server === server;
  try {
    return new URL(creds.gatewayWsUrl).hostname === new URL(server).hostname;
  } catch {
    return false;
  }
}

export async function pairDevice(input: {
  server: string;
  code: string;
  name?: string;
  runnerVersion: string;
  fetchImpl?: typeof fetch;
}): Promise<{ deviceId: string; name: string; reused: boolean }> {
  const server = normalizeServer(input.server);
  const code = normalizePairingCode(input.code);
  const name = (input.name?.trim() || hostname() || "My computer").slice(0, 64);
  const previous = readCredentials();
  const existing =
    previous && sameServer(previous, server)
      ? { deviceId: previous.deviceId, token: previous.token }
      : undefined;
  const res = await (input.fetchImpl ?? fetch)(`${server}/api/local-runners/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      code,
      name,
      platform: platformTag(),
      runnerVersion: input.runnerVersion,
      ...(existing ? { existing } : {}),
    }),
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !body) {
    const msg = typeof body?.error === "string" ? body.error : `HTTP ${res.status}`;
    throw new Error(`Pairing failed: ${msg}`);
  }
  const deviceId = typeof body.deviceId === "string" ? body.deviceId : "";
  const token = typeof body.token === "string" ? body.token : "";
  const gatewayWsUrl = typeof body.gatewayWsUrl === "string" ? body.gatewayWsUrl : "";
  if (!deviceId || !token || !gatewayWsUrl) throw new Error("Pairing failed: incomplete answer");
  assertSecureTransport(gatewayWsUrl, "gateway");
  writeCredentials({ deviceId, token, gatewayWsUrl, server });
  writeConfig({ ...readConfig(), server, name });
  return {
    deviceId,
    name: typeof body.name === "string" ? body.name : name,
    reused: Boolean(body.reused),
  };
}
