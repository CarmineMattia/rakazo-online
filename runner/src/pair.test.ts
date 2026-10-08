import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSecureTransport, readCredentials, writeCredentials } from "./config.ts";
import { normalizePairingCode, pairDevice, sameServer } from "./pair.ts";

describe("pairing helpers", () => {
  it("normalizes codes like the server", () => {
    assert.equal(normalizePairingCode("k7qf-3mzd"), "K7QF3MZD");
    assert.equal(normalizePairingCode(" K7QF 3MZO "), "K7QF3MZ0");
    assert.equal(normalizePairingCode("IL00-0000"), "11000000");
    assert.throws(() => normalizePairingCode("K7QF-3MZ"));
    assert.throws(() => normalizePairingCode("K7QF-3MZU"));
  });

  it("only allows plain http/ws to this same computer", () => {
    assert.ok(assertSecureTransport("http://127.0.0.1:5173", "server"));
    assert.ok(assertSecureTransport("ws://localhost:5173/api/local-runners/ws", "gateway"));
    assert.ok(assertSecureTransport("https://rakijazios.example", "server"));
    assert.ok(assertSecureTransport("wss://rakijazios.example/api/local-runners/ws", "gateway"));
    assert.throws(() => assertSecureTransport("http://192.168.1.5:5173", "server"), /unencrypted/);
    assert.throws(() => assertSecureTransport("ws://example.com/api/local-runners/ws", "gateway"), /unencrypted/);
    assert.throws(() => assertSecureTransport("https://u:p@example.com", "server"), /credentials/);
    assert.throws(() => assertSecureTransport("ftp://example.com", "server"));
  });

  it("hands an old key back only to the server that issued it", () => {
    assert.equal(sameServer({ server: "https://a.example", gatewayWsUrl: "wss://a.example/x" }, "https://a.example"), true);
    assert.equal(sameServer({ server: "https://a.example", gatewayWsUrl: "wss://a.example/x" }, "https://b.example"), false);
    // M1 credentials have no `server`: same host only.
    assert.equal(sameServer({ gatewayWsUrl: "ws://127.0.0.1:3100/api/local-runners/ws" }, "http://127.0.0.1:5173"), true);
    assert.equal(sameServer({ gatewayWsUrl: "ws://127.0.0.1:3100/api/local-runners/ws" }, "https://evil.example"), false);
  });
});

describe("pairDevice", () => {
  let dir = "";
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "rk-runner-test-"));
    process.env.RAKAZO_RUNNER_CONFIG_DIR = dir;
    delete process.env.RAKAZO_RUNNER_CREDENTIALS;
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.RAKAZO_RUNNER_CONFIG_DIR;
  });

  it("stores the key privately, returns no secret, and re-sends an old key only to its server", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body)));
      return Response.json({ deviceId: "dev1", token: "SECRET-TOKEN-1", gatewayWsUrl: "ws://127.0.0.1:5173/api/local-runners/ws", name: "box", reused: false });
    }) as unknown as typeof fetch;
    const out = await pairDevice({ server: "http://127.0.0.1:5173/", code: "k7qf-3mzd", name: "box", runnerVersion: "t", fetchImpl: fakeFetch });
    assert.deepEqual(out, { deviceId: "dev1", name: "box", reused: false });
    assert.equal(JSON.stringify(out).includes("SECRET"), false);
    assert.equal(seen[0]!.code, "K7QF3MZD");
    assert.equal("existing" in seen[0]!, false);
    const file = join(dir, "credentials.json");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(readCredentials()?.token, "SECRET-TOKEN-1");
    assert.equal(readCredentials()?.server, "http://127.0.0.1:5173");

    // Same server again: proves the old key so the same computer is re-keyed.
    await pairDevice({ server: "http://127.0.0.1:5173", code: "K7QF3MZD", runnerVersion: "t", fetchImpl: fakeFetch });
    assert.deepEqual(seen[1]!.existing, { deviceId: "dev1", token: "SECRET-TOKEN-1" });

    // A different server never sees the old key.
    writeCredentials({ deviceId: "dev1", token: "SECRET-TOKEN-1", gatewayWsUrl: "ws://127.0.0.1:5173/api/local-runners/ws", server: "http://127.0.0.1:5173" });
    await pairDevice({ server: "https://other.example", code: "K7QF3MZD", runnerVersion: "t", fetchImpl: (async (_u: string, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body)));
      return Response.json({ deviceId: "dev2", token: "T2", gatewayWsUrl: "wss://other.example/api/local-runners/ws" });
    }) as unknown as typeof fetch });
    assert.equal("existing" in seen[2]!, false);
    assert.ok(!readFileSync(file, "utf8").includes("SECRET-TOKEN-1"));
  });

  it("refuses a server that answers with an insecure remote gateway", async () => {
    const fakeFetch = (async () =>
      Response.json({ deviceId: "d", token: "t", gatewayWsUrl: "ws://evil.example/ws" })) as unknown as typeof fetch;
    await assert.rejects(
      () => pairDevice({ server: "https://good.example", code: "K7QF3MZD", runnerVersion: "t", fetchImpl: fakeFetch }),
      /unencrypted/,
    );
  });
});
