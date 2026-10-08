#!/usr/bin/env node
/**
 * Rakijazios local runner (M2a).
 *
 *   rakazo-runner pair --server https://example.com --code K7QF-3MZD [--name "My PC"]
 *   rakazo-runner start | stop | status
 *   rakazo-runner run          (foreground; also the default with no command, as in M1)
 *
 * Files: ~/.config/rakazo-runner/ (credentials.json 0600, config.json, status.json,
 * runner.pid, runner.log). The device token is never printed.
 *
 * Env overrides:
 *   RAKAZO_RUNNER_MODEL_URL   pin the local model server (default: auto-detect on loopback)
 *   RAKAZO_RUNNER_MODELS      optional comma-separated allowlist of local model ids
 *   RAKAZO_RUNNER_CONFIG_DIR  config directory
 *   RAKAZO_RUNNER_CREDENTIALS credentials file path
 *   RAKAZO_RUNNER_SERVICE     systemd user unit / launchd label (default rakijazios-runner /
 *                             com.rakijazios.runner)
 */
import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalRunnerClient } from "./client.ts";
import {
  assertSecureTransport,
  ensureConfigDir,
  logPath,
  pidPath,
  readConfig,
  readCredentials,
  readStatus,
  writeStatus,
} from "./config.ts";
import { discoverModelServer, filterModels } from "./discover.ts";
import { parseLoopbackBaseUrl } from "./loopback.ts";
import { pairDevice, platformTag } from "./pair.ts";

export const VERSION = "0.2.0-m2a";
const SCRIPT = fileURLToPath(import.meta.url);

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  return v && !v.startsWith("--") ? v : undefined;
}

function readPid(): number | null {
  try {
    const n = Number(readFileSync(pidPath(), "utf8").trim());
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function alive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Autostart integration written by the installer (systemd --user / launchd). */
function service(): { kind: "systemd" | "launchd"; name: string } | null {
  if (process.platform === "linux") {
    const name = process.env.RAKAZO_RUNNER_SERVICE?.trim() || "rakijazios-runner";
    const base = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
    return existsSync(join(base, "systemd", "user", `${name}.service`)) ? { kind: "systemd", name } : null;
  }
  if (process.platform === "darwin") {
    const name = process.env.RAKAZO_RUNNER_SERVICE?.trim() || "com.rakijazios.runner";
    return existsSync(join(homedir(), "Library", "LaunchAgents", `${name}.plist`))
      ? { kind: "launchd", name }
      : null;
  }
  return null;
}

function uid(): string {
  return typeof process.getuid === "function" ? String(process.getuid()) : "";
}

function modelBaseUrl(): string | undefined {
  const fixed = process.env.RAKAZO_RUNNER_MODEL_URL?.trim() || readConfig().modelBaseUrl;
  if (fixed) parseLoopbackBaseUrl(fixed);
  return fixed || undefined;
}

async function runForeground(): Promise<void> {
  const credentials = readCredentials();
  if (!credentials) {
    console.error(
      "This computer is not paired yet. In Rakijazios open Settings → My hardware → Add a computer.",
    );
    process.exit(1);
  }
  assertSecureTransport(credentials.gatewayWsUrl, "gateway");
  ensureConfigDir();
  writeFileSync(pidPath(), String(process.pid), { mode: 0o600 });
  const cleanup = () => {
    try {
      if (readPid() === process.pid) unlinkSync(pidPath());
    } catch {
      /* ignore */
    }
  };
  const client = new LocalRunnerClient({
    credentials,
    modelBaseUrl: modelBaseUrl(),
    modelFilter: process.env.RAKAZO_RUNNER_MODELS,
    runnerVersion: VERSION,
    platform: platformTag(),
    onStatus: (s) => writeStatus(s),
    onFatal: (reason) => {
      console.error(
        reason === "unauthorized"
          ? "[runner] The server refused this computer's key. Pair it again from Settings → My hardware."
          : `[runner] This computer was ${reason === "rotated" ? "given a new key" : "removed"} in Rakijazios. Pair it again from Settings → My hardware.`,
      );
      cleanup();
      // Exit 0 so service managers (Restart=on-failure) do not loop.
      process.exit(0);
    },
  });
  const shutdown = () => {
    client.stop();
    cleanup();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  console.error(`[runner] start pid=${process.pid} version=${VERSION}`);
  await client.start();
}

async function startBackground(): Promise<number> {
  const svc = service();
  if (svc?.kind === "systemd") {
    const r = spawnSync("systemctl", ["--user", "start", `${svc.name}.service`], { stdio: "inherit" });
    return r.status ?? 1;
  }
  if (svc?.kind === "launchd") {
    const r = spawnSync("launchctl", ["kickstart", `gui/${uid()}/${svc.name}`], { stdio: "inherit" });
    return r.status ?? 1;
  }
  const running = readPid();
  if (alive(running)) {
    console.log(`Runner already running (pid ${running}).`);
    return 0;
  }
  ensureConfigDir();
  try {
    if (statSync(logPath()).size > 5 * 1024 * 1024) renameSync(logPath(), `${logPath()}.1`);
  } catch {
    /* no log yet */
  }
  const fd = openSync(logPath(), "a", 0o600);
  const child = spawn(process.execPath, [...process.execArgv, SCRIPT, "run"], {
    detached: true,
    stdio: ["ignore", fd, fd],
    windowsHide: true,
    env: process.env,
  });
  child.unref();
  closeSync(fd);
  await sleep(1500);
  if (child.pid && alive(child.pid)) {
    console.log(`Runner started (pid ${child.pid}). Log: ${logPath()}`);
    return 0;
  }
  console.error(`Runner failed to start; see ${logPath()}`);
  return 1;
}

async function stopRunner(): Promise<number> {
  const svc = service();
  if (svc?.kind === "systemd") {
    spawnSync("systemctl", ["--user", "stop", `${svc.name}.service`], { stdio: "inherit" });
  } else if (svc?.kind === "launchd") {
    spawnSync("launchctl", ["kill", "SIGTERM", `gui/${uid()}/${svc.name}`], { stdio: "ignore" });
  }
  const pid = readPid();
  if (!alive(pid)) {
    console.log("Runner is not running.");
    try {
      unlinkSync(pidPath());
    } catch {
      /* ignore */
    }
    return 0;
  }
  process.kill(pid!, "SIGTERM");
  for (let i = 0; i < 25 && alive(pid); i++) await sleep(200);
  console.log(alive(pid) ? `Runner (pid ${pid}) did not stop yet.` : `Runner stopped (pid ${pid}).`);
  return alive(pid) ? 1 : 0;
}

async function printStatus(): Promise<number> {
  const creds = readCredentials();
  if (!creds) {
    console.log("Not paired. In Rakijazios open Settings → My hardware → Add a computer.");
    return 1;
  }
  const pid = readPid();
  const running = alive(pid);
  const st = readStatus();
  let server = "?";
  try {
    server = new URL(creds.gatewayWsUrl).host;
  } catch {
    /* ignore */
  }
  console.log(`Rakijazios runner ${VERSION}`);
  console.log(`Server:        ${server}`);
  console.log(`Runner:        ${running ? `running (pid ${pid})` : "not running"}${service() ? " · starts at login" : ""}`);
  console.log(`Connection:    ${running && st ? st.state : "offline"}${st?.detail && running ? ` (${st.detail})` : ""}`);
  if (running && st) {
    console.log(`Model server:  ${st.modelServer ?? "none"}`);
    console.log(`Models:        ${st.models?.length ? st.models.join(", ") : "none"}`);
  } else {
    const found = await discoverModelServer(modelBaseUrl());
    const models = filterModels(found?.models ?? [], process.env.RAKAZO_RUNNER_MODELS);
    console.log(`Model server:  ${found ? `${found.kind} (${models.length} model(s))` : "none found"}`);
  }
  return running ? 0 : 3;
}

async function pairCommand(argv: string[]): Promise<number> {
  const server = arg(argv, "server") ?? readConfig().server;
  const code = arg(argv, "code");
  if (!server || !code) {
    console.error("usage: rakazo-runner pair --server <url> --code <XXXX-XXXX> [--name <name>]");
    return 2;
  }
  const paired = await pairDevice({ server, code, name: arg(argv, "name"), runnerVersion: VERSION });
  console.log(`${paired.reused ? "Reconnected" : "Paired"} as "${paired.name}".`);
  const found = await discoverModelServer(modelBaseUrl());
  const models = filterModels(found?.models ?? [], process.env.RAKAZO_RUNNER_MODELS);
  if (found) {
    console.log(`Local model server: ${found.kind} with ${models.length} model(s)${models.length ? `: ${models.map((m) => m.id).join(", ")}` : ""}.`);
  } else {
    console.log(
      "No local model server found yet (Ollama, LM Studio, llama.cpp…). Start one; the runner checks every minute.",
    );
  }
  return 0;
}

async function main(argv: string[]): Promise<void> {
  const cmd = argv[0] && !argv[0].startsWith("--") ? argv[0] : "run";
  try {
    switch (cmd) {
      case "run":
        await runForeground();
        return;
      case "pair":
        process.exit(await pairCommand(argv.slice(1)));
        break;
      case "start":
        process.exit(await startBackground());
        break;
      case "stop":
        process.exit(await stopRunner());
        break;
      case "status":
        process.exit(await printStatus());
        break;
      case "version":
      case "--version":
        console.log(VERSION);
        process.exit(0);
        break;
      default:
        console.error("usage: rakazo-runner [run|pair|start|stop|status|version]");
        process.exit(2);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

void main(process.argv.slice(2));
