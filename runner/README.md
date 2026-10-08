# Rakijazios local runner (M1 prototype)

A small Node 22 script that lets a bot use a model running on **your own computer**.
It opens an **outbound** WebSocket to the Rakijazios api, authenticates with a device
token, and forwards chat-completion requests **only** to a loopback OpenAI-compatible
server (Ollama by default). It never opens a listening port.

Design: [`docs/share-local-ai.md`](../docs/share-local-ai.md). M1 is owner-only and
same-host; there is no pairing UI yet.

## Requirements

- Node **22.18+** (runs `.ts` directly via type stripping; no dependencies, no build).
- An OpenAI-compatible server on loopback, e.g. Ollama at `http://127.0.0.1:11434/v1`.
- The api reachable from the runner (M1: `ws://127.0.0.1:3100/api/local-runners/ws`).

## 1. Seed a device token (operator, once)

The token is printed **only** into a `0600` file — never to the terminal:

```bash
mkdir -p ~/.config/rakazo-runner && chmod 700 ~/.config/rakazo-runner
umask 077
docker exec rakazo-api-1 sh -c \
  'cd /app/apps/api && npx tsx src/local-runner-seed.ts --email you@example.com --name my-pc' \
  > ~/.config/rakazo-runner/credentials.json
```

The file holds `{ deviceId, token, gatewayWsUrl }`. The database keeps only
`sha256(token)` in `local_runner_devices`. To rotate, re-run with `--device-id <id>`.
To revoke: `UPDATE local_runner_devices SET status='revoked' WHERE id='<id>';` and
restart the api (or the runner) to drop the live session.

## 2. Start / stop (background, no system service)

```bash
runner/scripts/start.sh    # pid: ~/.config/rakazo-runner/runner.pid, log: runner.log
runner/scripts/stop.sh
tail -f ~/.config/rakazo-runner/runner.log
```

Foreground: `node runner/src/index.ts`.

Environment overrides:

| Variable | Default |
|---|---|
| `RAKAZO_RUNNER_MODEL_URL` | `http://127.0.0.1:11434/v1` (must be `127.0.0.1`, `localhost` or `::1`) |
| `RAKAZO_RUNNER_MODELS` | `gemma4:26b-a4b-it-q4_K_M` (comma-separated) |
| `RAKAZO_RUNNER_CREDENTIALS` | `~/.config/rakazo-runner/credentials.json` |
| `RAKAZO_RUNNER_CONFIG_DIR` | `~/.config/rakazo-runner` |

## 3. Tests

```bash
cd runner && node --test src/*.test.ts   # protocol codec + loopback restriction
```

## Behaviour

- `hello` (device id + token) must be the first frame; the gateway closes with
  `1008` otherwise. Heartbeat every 15 s; the gateway drops a silent session after 45 s.
- Requests: `infer.request` → runner POSTs `<base>/chat/completions` with `stream: true`
  and relays each SSE line as `infer.chunk`, then `infer.done` / `infer.error`.
- `infer.cancel` aborts the local fetch. Reconnects with exponential backoff (1 s → 30 s).
- The target URL comes from local config only and is re-validated on every request;
  redirects to other hosts are refused. Tool calls are only text in the stream — the
  runner never executes anything.
