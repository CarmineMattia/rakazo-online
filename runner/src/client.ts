import {
  decodeFrame,
  encodeFrame,
  type InferRequestFrame,
  type ProtocolFrame,
} from "./protocol.ts";
import { assertSameOriginLoopback, loopbackRequestUrl } from "./loopback.ts";

export type RunnerCredentials = {
  deviceId: string;
  token: string;
  /** ws:// or wss:// URL including path, e.g. ws://127.0.0.1:3100/api/local-runners/ws */
  gatewayWsUrl: string;
};

export type RunnerOptions = {
  credentials: RunnerCredentials;
  modelBaseUrl: string;
  offeredModels: string[];
  runnerVersion: string;
  log?: (line: string) => void;
};

const HEARTBEAT_MS = 15_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export class LocalRunnerClient {
  private ws: WebSocket | null = null;
  private stopped = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempt = 0;
  private readonly inFlight = new Map<string, AbortController>();
  private readonly log: (line: string) => void;
  private readonly opts: RunnerOptions;

  constructor(opts: RunnerOptions) {
    this.opts = opts;
    this.log = opts.log ?? ((line) => console.error(`[runner] ${line}`));
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearHeartbeat();
    for (const [, ctrl] of this.inFlight) ctrl.abort();
    this.inFlight.clear();
    try {
      this.ws?.close(1000, "runner stop");
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  private connect(): void {
    if (this.stopped) return;
    const url = this.opts.credentials.gatewayWsUrl;
    this.log(`connecting ${url}`);
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.reconnectAttempt = 0;
      this.log("connected; sending hello");
      this.send({
        type: "hello",
        deviceId: this.opts.credentials.deviceId,
        token: this.opts.credentials.token,
        runnerVersion: this.opts.runnerVersion,
        offeredModels: this.opts.offeredModels,
      });
      this.clearHeartbeat();
      this.heartbeatTimer = setInterval(() => {
        this.send({ type: "heartbeat", at: Date.now() });
      }, HEARTBEAT_MS);
    });

    ws.addEventListener("message", (ev) => {
      void this.onMessage(String(ev.data));
    });

    // Undici does not always emit "close" after a failed handshake, so both
    // events funnel into one idempotent teardown per socket.
    let tornDown = false;
    const teardown = (why: string) => {
      if (tornDown) return;
      tornDown = true;
      this.clearHeartbeat();
      this.log(why);
      if (this.ws === ws) this.ws = null;
      for (const [, ctrl] of this.inFlight) ctrl.abort();
      this.inFlight.clear();
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      this.scheduleReconnect();
    };

    ws.addEventListener("close", (ev) => {
      teardown(`closed code=${ev.code} reason=${ev.reason || "-"}`);
    });

    ws.addEventListener("error", () => {
      teardown("websocket error");
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * 2 ** this.reconnectAttempt,
    );
    this.reconnectAttempt += 1;
    this.log(`reconnect in ${delay}ms`);
    setTimeout(() => this.connect(), delay);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private send(frame: ProtocolFrame): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(encodeFrame(frame));
  }

  private async onMessage(raw: string): Promise<void> {
    let frame: ProtocolFrame;
    try {
      frame = decodeFrame(raw);
    } catch (err) {
      this.log(`bad frame: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    switch (frame.type) {
      case "heartbeat_ack":
        return;
      case "policy":
        this.log(
          `policy maxInFlight=${frame.maxInFlight ?? "-"} hardTimeoutMs=${frame.hardTimeoutMs ?? "-"}`,
        );
        return;
      case "bye":
        this.log(`server bye: ${frame.reason ?? ""}`);
        return;
      case "infer.cancel": {
        const ctrl = this.inFlight.get(frame.id);
        if (ctrl) {
          this.log(`cancel ${frame.id}`);
          ctrl.abort();
        }
        return;
      }
      case "infer.request":
        await this.handleInfer(frame);
        return;
      default:
        return;
    }
  }

  private async handleInfer(frame: InferRequestFrame): Promise<void> {
    const ctrl = new AbortController();
    this.inFlight.set(frame.id, ctrl);
    this.log(`infer.request id=${frame.id} model=${frame.model}`);
    try {
      const url = loopbackRequestUrl(this.opts.modelBaseUrl, "/chat/completions");
      assertSameOriginLoopback(this.opts.modelBaseUrl, url);
      const body = { ...frame.body, model: frame.model, stream: true };
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
        // Never follow a redirect away from the configured loopback server.
        redirect: "error",
      });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        this.send({
          type: "infer.error",
          id: frame.id,
          message: `Local model HTTP ${res.status}: ${text.slice(0, 200)}`,
          retryable: res.status >= 500,
        });
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          let line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (!line) continue;
          this.send({ type: "infer.chunk", id: frame.id, data: line });
        }
      }
      if (buf.trim()) {
        this.send({ type: "infer.chunk", id: frame.id, data: buf.trimEnd() });
      }
      this.send({ type: "infer.done", id: frame.id, status: res.status });
      this.log(`infer.done id=${frame.id} status=${res.status}`);
    } catch (err) {
      if (ctrl.signal.aborted) {
        this.send({
          type: "infer.error",
          id: frame.id,
          message: "Cancelled",
          retryable: false,
        });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.log(`infer.error id=${frame.id}: ${message}`);
      this.send({
        type: "infer.error",
        id: frame.id,
        message,
        retryable: true,
      });
    } finally {
      this.inFlight.delete(frame.id);
    }
  }
}
