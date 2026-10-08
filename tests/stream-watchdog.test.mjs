import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const script = readFileSync(process.env.RAKAZO_WATCHDOG_OVERLAY || new URL('../patches/web/dist/stream-watchdog-overlay.js', import.meta.url), 'utf8');
const enc = new TextEncoder();
function load(fetchImpl, stallMs = 60) {
  const events = [];
  const window = { fetch: fetchImpl, __rkStreamWatchdogMs: stallMs, dispatchEvent: e => events.push(e.type) };
  const ctx = vm.createContext({ window, location: { href: 'http://localhost:5173/app' }, URL, Response, ReadableStream, TypeError, CustomEvent, setTimeout, clearTimeout });
  vm.runInContext(script, ctx);
  return { fetch: window.fetch, events };
}
const sse = (chunks, { hang = true } = {}) => new Response(new ReadableStream({
  async start(c) { for (const x of chunks) c.enqueue(enc.encode(x)); if (!hang) c.close(); },
}), { headers: { 'content-type': 'text/event-stream' } });
async function readAll(res) { const r = res.body.getReader(); const out = []; for (;;) { const { done, value } = await r.read(); if (done) return out; out.push(new TextDecoder().decode(value)); } }

test('a silent subscribe stream errors after the stall window so the app resubscribes', async () => {
  const w = load(async () => sse([': \n\n']));
  const res = await w.fetch('/rpc/threads/subscribe', { method: 'POST' });
  const reader = res.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), ': \n\n');
  await assert.rejects(reader.read(), /stalled/);
  assert.deepEqual(w.events, ['rk:stream-stalled']);
});

test('a stream that keeps sending passes through untouched', async () => {
  const w = load(async () => sse(['a', 'b', 'c'], { hang: false }));
  const res = await w.fetch(new URL('http://localhost:5173/rpc/threads/subscribe'));
  assert.deepEqual(await readAll(res), ['a', 'b', 'c']);
  assert.deepEqual(w.events, []);
});

test('other requests are returned as-is', async () => {
  const original = sse([':'], { hang: true });
  const w = load(async () => original);
  assert.equal(await w.fetch('/rpc/threads/get', { method: 'POST' }), original);
  const json = new Response('{}', { headers: { 'content-type': 'application/json' } });
  const w2 = load(async () => json);
  assert.equal(await w2.fetch('/rpc/threads/subscribe'), json);
});

test('the app aborting the stream still surfaces as an abort, not a stall', async () => {
  const ctrl = new AbortController();
  const w = load(async () => new Response(new ReadableStream({ start(c) { ctrl.signal.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError'))); } }), { headers: { 'content-type': 'text/event-stream' } }), 1000);
  const res = await w.fetch('/rpc/threads/subscribe');
  const reader = res.body.getReader();
  setTimeout(() => ctrl.abort(), 20);
  await assert.rejects(reader.read(), e => e.name === 'AbortError');
  assert.deepEqual(w.events, []);
});
