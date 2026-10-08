/**
 * Local-runner gateway (M1): WebSocket session manager + OpenAI-compatible
 * HTTP proxy that forwards chat completions to the owner's connected runner.
 */
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { PrismaClient } from "@rakazo/db";
import type { Hono } from "hono";
import {
  hashDeviceToken,
  verifySharedLocalToken,
} from "./shared-local-token.js";

type WsModule = {
  WebSocketServer: new (opts: { noServer: boolean }) => {
    handleUpgrade: (
      req: IncomingMessage,
      socket: Duplex,
      head: Buffer,
      cb: (ws: WsSocket) => void,
    ) => void;
    emit: (event: string, ...args: unknown[]) => boolean;
  };
  WebSocket: { OPEN: number };
};

type WsSocket = {
  readyState: number;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  on: (event: string, cb: (...args: unknown[]) => void) => void;
};

/**
 * `ws` ships in the image (transitively) but is not a declared dependency of
 * @rakazo/api, so plain `import "ws"` does not resolve under pnpm. Load the
 * newest ws@8 from the store instead of hand-rolling RFC 6455 framing.
 */
function loadWs(): WsModule {
  const store = "/app/node_modules/.pnpm";
  const dir = readdirSync(store)
    .filter((name) => /^ws@8\.\d+\.\d+$/.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .pop();
  if (!dir) throw new Error("ws@8 not found in the image's pnpm store");
  const require = createRequire(`${store}/${dir}/node_modules/ws/package.json`);
  return require(".") as WsModule;
}

const HEARTBEAT_MISS_MS = 45_000;
const HARD_TIMEOUT_MS = 10 * 60_000;
const MAX_IN_FLIGHT = 2;
const OFFLINE_MESSAGE =
  "This bot runs on the owner's computer, which is offline right now. Try again later.";

type DeviceRow = {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  status: string;
};

type PendingInfer = {
  id: string;
  ownerUserId: string;
  chunks: string[];
  status?: number;
  error?: { message: string; retryable: boolean };
  done: boolean;
  waiters: Array<() => void>;
  hardTimer: ReturnType<typeof setTimeout>;
};

type RunnerSession = {
  deviceId: string;
  userId: string;
  ws: WsSocket;
  lastSeenAt: number;
  offeredModels: string[];
  inFlight: Set<string>;
};

const ready = new WeakMap<PrismaClient, Promise<void>>();

export function ensureLocalRunnerTables(prisma: PrismaClient): Promise<void> {
  let pending = ready.get(prisma);
  if (!pending) {
    pending = (async () => {
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS local_runner_devices (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'active',
        runner_version TEXT,
        last_seen_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await prisma.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS local_runner_devices_user_id_idx ON local_runner_devices (user_id)`,
      );
    })().catch((error) => {
      ready.delete(prisma);
      throw error;
    });
    ready.set(prisma, pending);
  }
  return pending;
}

/** Seed a device for a user. Returns plaintext token once (caller must store securely). */
export async function seedLocalRunnerDevice(
  prisma: PrismaClient,
  input: { userId: string; name: string; deviceId?: string },
): Promise<{ deviceId: string; token: string }> {
  await ensureLocalRunnerTables(prisma);
  const deviceId = input.deviceId ?? randomUUID().replace(/-/g, "").slice(0, 24);
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashDeviceToken(token);
  await prisma.$executeRawUnsafe(
    `INSERT INTO local_runner_devices (id, user_id, name, token_hash, status, updated_at)
     VALUES ($1, $2, $3, $4, 'active', NOW())
     ON CONFLICT (id) DO UPDATE SET
       token_hash = EXCLUDED.token_hash,
       name = EXCLUDED.name,
       status = 'active',
       updated_at = NOW()`,
    deviceId,
    input.userId,
    input.name,
    tokenHash,
  );
  return { deviceId, token };
}

export type LocalRunnerGateway = {
  mountHttp: (app: Hono) => void;
  attachUpgrade: (server: HttpServer) => void;
  /** Test/ops helper */
  isOwnerOnline: (userId: string) => boolean;
};

export function createLocalRunnerGateway(deps: {
  prisma: PrismaClient;
}): LocalRunnerGateway {
  const sessionsByDevice = new Map<string, RunnerSession>();
  const sessionsByUser = new Map<string, RunnerSession>();
  const pending = new Map<string, PendingInfer>();
  const wsMod = loadWs();
  const wss = new wsMod.WebSocketServer({ noServer: true });

  function touch(session: RunnerSession): void {
    session.lastSeenAt = Date.now();
  }

  function dropSession(session: RunnerSession, reason: string): void {
    if (sessionsByDevice.get(session.deviceId) === session) {
      sessionsByDevice.delete(session.deviceId);
    }
    if (sessionsByUser.get(session.userId) === session) {
      sessionsByUser.delete(session.userId);
    }
    for (const id of [...session.inFlight]) {
      failPending(id, `Runner disconnected (${reason})`, true);
    }
    session.inFlight.clear();
    try {
      session.ws.close(1000, reason.slice(0, 64));
    } catch {
      /* ignore */
    }
  }

  function wake(p: PendingInfer): void {
    const waiters = p.waiters.splice(0);
    for (const w of waiters) w();
  }

  function failPending(id: string, message: string, retryable: boolean): void {
    const p = pending.get(id);
    if (!p || p.done) return;
    p.done = true;
    p.error = { message, retryable };
    clearTimeout(p.hardTimer);
    wake(p);
  }

  function completePending(id: string, status: number): void {
    const p = pending.get(id);
    if (!p || p.done) return;
    p.done = true;
    p.status = status;
    clearTimeout(p.hardTimer);
    wake(p);
  }

  function parseFrame(raw: string): { type: string; [k: string]: unknown } | null {
    try {
      const v = JSON.parse(raw) as { type?: unknown };
      if (!v || typeof v !== "object" || typeof v.type !== "string") return null;
      return v as { type: string; [k: string]: unknown };
    } catch {
      return null;
    }
  }

  async function authenticateHello(
    frame: Record<string, unknown>,
  ): Promise<{ device: DeviceRow; offeredModels: string[]; runnerVersion: string } | null> {
    const deviceId = typeof frame.deviceId === "string" ? frame.deviceId : "";
    const token = typeof frame.token === "string" ? frame.token : "";
    if (!deviceId || !token) return null;
    await ensureLocalRunnerTables(deps.prisma);
    const rows = await deps.prisma.$queryRawUnsafe<DeviceRow[]>(
      `SELECT id, user_id, name, token_hash, status FROM local_runner_devices WHERE id = $1`,
      deviceId,
    );
    const device = rows[0];
    if (!device || device.status !== "active") return null;
    const hash = hashDeviceToken(token);
    if (hash !== device.token_hash) return null;
    const offeredModels = Array.isArray(frame.offeredModels)
      ? frame.offeredModels.filter((m): m is string => typeof m === "string")
      : [];
    const runnerVersion =
      typeof frame.runnerVersion === "string" ? frame.runnerVersion.slice(0, 64) : "";
    await deps.prisma.$executeRawUnsafe(
      `UPDATE local_runner_devices SET last_seen_at = NOW(), runner_version = $2, updated_at = NOW() WHERE id = $1`,
      deviceId,
      runnerVersion || null,
    );
    return { device, offeredModels, runnerVersion };
  }

  function bindSocket(ws: WsSocket): void {
    let session: RunnerSession | null = null;
    let helloTimer = setTimeout(() => {
      try {
        ws.close(1008, "hello timeout");
      } catch {
        /* ignore */
      }
    }, 15_000);

    ws.on("message", (data: unknown) => {
      void (async () => {
        const raw = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
        const frame = parseFrame(raw);
        if (!frame) return;

        if (!session) {
          if (frame.type !== "hello") {
            ws.close(1008, "hello required");
            return;
          }
          clearTimeout(helloTimer);
          const auth = await authenticateHello(frame);
          if (!auth) {
            ws.close(1008, "unauthorized");
            return;
          }
          const existing = sessionsByDevice.get(auth.device.id);
          if (existing) dropSession(existing, "replaced");
          const existingUser = sessionsByUser.get(auth.device.user_id);
          if (existingUser && existingUser.deviceId !== auth.device.id) {
            dropSession(existingUser, "replaced-by-user");
          }
          session = {
            deviceId: auth.device.id,
            userId: auth.device.user_id,
            ws,
            lastSeenAt: Date.now(),
            offeredModels: auth.offeredModels,
            inFlight: new Set(),
          };
          sessionsByDevice.set(session.deviceId, session);
          sessionsByUser.set(session.userId, session);
          ws.send(
            JSON.stringify({
              type: "policy",
              maxInFlight: MAX_IN_FLIGHT,
              hardTimeoutMs: HARD_TIMEOUT_MS,
            }),
          );
          return;
        }

        touch(session);
        if (frame.type === "heartbeat") {
          ws.send(JSON.stringify({ type: "heartbeat_ack", at: Date.now() }));
          return;
        }
        if (frame.type === "models" && Array.isArray(frame.models)) {
          session.offeredModels = frame.models
            .map((m) => (m && typeof m === "object" && typeof (m as { id?: unknown }).id === "string"
              ? (m as { id: string }).id
              : null))
            .filter((id): id is string => Boolean(id));
          return;
        }
        if (frame.type === "infer.chunk") {
          const id = typeof frame.id === "string" ? frame.id : "";
          const dataLine = typeof frame.data === "string" ? frame.data : "";
          const p = pending.get(id);
          if (p && !p.done && session.inFlight.has(id)) {
            p.chunks.push(dataLine);
            wake(p);
          }
          return;
        }
        if (frame.type === "infer.done") {
          const id = typeof frame.id === "string" ? frame.id : "";
          const status = typeof frame.status === "number" ? frame.status : 200;
          session.inFlight.delete(id);
          completePending(id, status);
          return;
        }
        if (frame.type === "infer.error") {
          const id = typeof frame.id === "string" ? frame.id : "";
          const message =
            typeof frame.message === "string" ? frame.message : "Runner inference error";
          const retryable = Boolean(frame.retryable);
          session.inFlight.delete(id);
          failPending(id, message, retryable);
          return;
        }
      })();
    });

    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (session) dropSession(session, "closed");
    });
  }

  // Stale heartbeat sweeper
  setInterval(() => {
    const now = Date.now();
    for (const session of [...sessionsByDevice.values()]) {
      if (now - session.lastSeenAt > HEARTBEAT_MISS_MS) {
        dropSession(session, "heartbeat-timeout");
      }
    }
  }, 5_000).unref?.();

  function findSessionForOwner(ownerUserId: string): RunnerSession | undefined {
    const session = sessionsByUser.get(ownerUserId);
    if (!session) return undefined;
    if (Date.now() - session.lastSeenAt > HEARTBEAT_MISS_MS) {
      dropSession(session, "stale");
      return undefined;
    }
    return session;
  }

  async function proxyChatCompletions(
    ownerUserId: string,
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Response> {
    const session = findSessionForOwner(ownerUserId);
    if (!session) {
      return Response.json(
        { error: { message: OFFLINE_MESSAGE, type: "shared_local_offline" } },
        { status: 503 },
      );
    }
    if (session.inFlight.size >= MAX_IN_FLIGHT) {
      return Response.json(
        {
          error: {
            message: "Owner's local runner is busy. Try again shortly.",
            type: "shared_local_busy",
          },
        },
        { status: 429 },
      );
    }

    const model = typeof body.model === "string" ? body.model : "";
    if (!model) {
      return Response.json({ error: { message: "model is required" } }, { status: 400 });
    }

    const id = randomUUID();
    const p: PendingInfer = {
      id,
      ownerUserId,
      chunks: [],
      done: false,
      waiters: [],
      hardTimer: setTimeout(() => {
        failPending(id, "Inference hard timeout (10 min)", false);
        try {
          session.ws.send(JSON.stringify({ type: "infer.cancel", id }));
        } catch {
          /* ignore */
        }
        session.inFlight.delete(id);
      }, HARD_TIMEOUT_MS),
    };
    pending.set(id, p);
    session.inFlight.add(id);

    const onAbort = () => {
      try {
        session.ws.send(JSON.stringify({ type: "infer.cancel", id }));
      } catch {
        /* ignore */
      }
      failPending(id, "Cancelled", false);
      session.inFlight.delete(id);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });

    try {
      session.ws.send(
        JSON.stringify({
          type: "infer.request",
          id,
          model,
          body: { ...body, stream: true },
        }),
      );
    } catch {
      failPending(id, OFFLINE_MESSAGE, true);
      session.inFlight.delete(id);
      pending.delete(id);
      clearTimeout(p.hardTimer);
      return Response.json(
        { error: { message: OFFLINE_MESSAGE, type: "shared_local_offline" } },
        { status: 503 },
      );
    }

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        let cursor = 0;
        const pump = () => {
          while (cursor < p.chunks.length) {
            const line = p.chunks[cursor++]!;
            // Runner forwards non-empty SSE lines; each OpenAI `data:` line is a
            // complete event, so restore the blank-line event terminator.
            controller.enqueue(encoder.encode(line.startsWith("data:") ? `${line}\n\n` : `${line}\n`));
          }
          if (p.done) {
            if (p.error) {
              // Surface as SSE error then close — clients that already got
              // headers still need a terminal signal.
              const errEvent = `data: ${JSON.stringify({ error: { message: p.error.message } })}\n\n`;
              controller.enqueue(encoder.encode(errEvent));
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            } else {
              controller.close();
            }
            pending.delete(id);
            clearTimeout(p.hardTimer);
            signal.removeEventListener("abort", onAbort);
            return;
          }
          p.waiters.push(pump);
        };
        pump();
      },
      cancel() {
        onAbort();
        pending.delete(id);
        clearTimeout(p.hardTimer);
      },
    });

    // Wait until we have the first byte or an early error so we can still
    // return 503/4xx before committing to SSE when the runner is gone.
    await new Promise<void>((resolve) => {
      if (p.done || p.chunks.length) {
        resolve();
        return;
      }
      p.waiters.push(() => resolve());
    });

    if (p.done && p.error && p.chunks.length === 0) {
      pending.delete(id);
      clearTimeout(p.hardTimer);
      const status = p.error.message === OFFLINE_MESSAGE ? 503 : 502;
      return Response.json(
        { error: { message: p.error.message, type: "shared_local_error" } },
        { status },
      );
    }

    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  }

  return {
    isOwnerOnline(userId: string) {
      return Boolean(findSessionForOwner(userId));
    },
    mountHttp(app: Hono) {
      app.get("/api/local-runners/v1/models", async (c) => {
        const auth = c.req.header("authorization") ?? "";
        const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
        const verified = token ? verifySharedLocalToken(token) : null;
        if (!verified) return c.json({ error: "Unauthorized" }, 401);
        const session = findSessionForOwner(verified.ownerUserId);
        if (!session) {
          return c.json({ error: { message: OFFLINE_MESSAGE } }, 503);
        }
        return c.json({
          object: "list",
          data: session.offeredModels.map((id) => ({
            id,
            object: "model",
            owned_by: "shared-local",
          })),
        });
      });

      app.post("/api/local-runners/v1/chat/completions", async (c) => {
        const auth = c.req.header("authorization") ?? "";
        const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
        const verified = token ? verifySharedLocalToken(token) : null;
        if (!verified) return c.json({ error: "Unauthorized" }, 401);
        let body: Record<string, unknown>;
        try {
          body = (await c.req.json()) as Record<string, unknown>;
        } catch {
          return c.json({ error: "Invalid JSON" }, 400);
        }
        return proxyChatCompletions(verified.ownerUserId, body, c.req.raw.signal);
      });
    },
    attachUpgrade(server: HttpServer) {
      server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        const host = req.headers.host ?? "127.0.0.1";
        const url = new URL(req.url ?? "/", `http://${host}`);
        if (url.pathname !== "/api/local-runners/ws") return;
        wss.handleUpgrade(req, socket, head, (ws) => {
          bindSocket(ws);
        });
      });
    },
  };
}
