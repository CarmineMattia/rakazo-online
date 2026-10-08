#!/usr/bin/env node
/**
 * Rakijazios local runner (M1).
 *
 * Start:  node --experimental-strip-types runner/src/index.ts
 *         (or: npm start — from runner/)
 * Stop:   kill $(cat ~/.config/rakazo-runner/runner.pid)
 *
 * Credentials: ~/.config/rakazo-runner/credentials.json (mode 0600)
 *   { "deviceId", "token", "gatewayWsUrl" }
 *
 * Env overrides:
 *   RAKAZO_RUNNER_MODEL_URL   default http://127.0.0.1:11434/v1
 *   RAKAZO_RUNNER_MODELS      comma-separated; default gemma4:26b-a4b-it-q4_K_M
 *   RAKAZO_RUNNER_CREDENTIALS path to credentials JSON
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { LocalRunnerClient } from "./client.ts";
import { parseLoopbackBaseUrl } from "./loopback.ts";

const VERSION = "0.1.0-m1";
const DEFAULT_MODEL_URL = "http://127.0.0.1:11434/v1";
const DEFAULT_MODELS = "gemma4:26b-a4b-it-q4_K_M";

function configDir(): string {
  return process.env.RAKAZO_RUNNER_CONFIG_DIR?.trim() || join(homedir(), ".config", "rakazo-runner");
}

function credentialsPath(): string {
  return (
    process.env.RAKAZO_RUNNER_CREDENTIALS?.trim() || join(configDir(), "credentials.json")
  );
}

function loadCredentials(): {
  deviceId: string;
  token: string;
  gatewayWsUrl: string;
} {
  const path = credentialsPath();
  if (!existsSync(path)) {
    console.error(`Missing credentials at ${path}. Seed a device token first.`);
    process.exit(1);
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const deviceId = String(raw.deviceId ?? "");
  const token = String(raw.token ?? "");
  const gatewayWsUrl = String(raw.gatewayWsUrl ?? "ws://127.0.0.1:3100/api/local-runners/ws");
  if (!deviceId || !token) {
    console.error("credentials.json must include deviceId and token");
    process.exit(1);
  }
  return { deviceId, token, gatewayWsUrl };
}

function main(): void {
  const modelBaseUrl = process.env.RAKAZO_RUNNER_MODEL_URL?.trim() || DEFAULT_MODEL_URL;
  parseLoopbackBaseUrl(modelBaseUrl);
  const offeredModels = (process.env.RAKAZO_RUNNER_MODELS ?? DEFAULT_MODELS)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!offeredModels.length) {
    console.error("RAKAZO_RUNNER_MODELS is empty");
    process.exit(1);
  }

  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const pidPath = join(dir, "runner.pid");
  writeFileSync(pidPath, String(process.pid), { mode: 0o600 });

  const client = new LocalRunnerClient({
    credentials: loadCredentials(),
    modelBaseUrl,
    offeredModels,
    runnerVersion: VERSION,
  });

  const shutdown = () => {
    client.stop();
    try {
      if (existsSync(pidPath)) {
        const cur = readFileSync(pidPath, "utf8").trim();
        if (cur === String(process.pid)) unlinkSync(pidPath);
      }
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.error(
    `[runner] start pid=${process.pid} models=${offeredModels.join(",")} base=${modelBaseUrl}`,
  );
  client.start();
}

main();
