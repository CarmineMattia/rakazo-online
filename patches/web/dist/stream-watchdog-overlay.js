/*
 * Live-update watchdog (Rakijazios).
 *
 * The app keeps a long-lived `threads.subscribe` event stream per open chat and,
 * when that stream errors or ends, it refetches the thread and resubscribes from
 * its cursor. But when the api restarts behind the web proxy, the browser's
 * stream is never closed: it just goes silent, so the chat can stay on
 * "X is working" until a reload. The server sends a keep-alive comment every
 * 5 s, so silence longer than STALL_MS means the stream is dead. We error it,
 * and the app's existing recovery (refresh + resubscribe) takes over.
 */
(() => {
  if (window.__rkStreamWatchdog) return;
  window.__rkStreamWatchdog = true;
  const STALL_MS = Number(window.__rkStreamWatchdogMs) || 15000;
  const WATCHED = /\/rpc\/threads\/subscribe\/?$/;
  const nativeFetch = window.fetch.bind(window);
  function pathOf(input) {
    try {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input && input.url;
      return new URL(raw, location.href).pathname;
    } catch { return ''; }
  }
  window.fetch = async function rkWatchedFetch(input, init) {
    const response = await nativeFetch(input, init);
    if (!WATCHED.test(pathOf(input)) || !response.body) return response;
    if (!(response.headers.get('content-type') || '').includes('text/event-stream')) return response;
    const reader = response.body.getReader();
    let timer = null, stalled = false;
    const body = new ReadableStream({
      async pull(controller) {
        clearTimeout(timer);
        timer = setTimeout(() => {
          stalled = true;
          reader.cancel('stalled').catch(() => {});
          try { controller.error(new TypeError('Live updates stalled; reconnecting')); } catch {}
          window.dispatchEvent(new CustomEvent('rk:stream-stalled', { detail: { path: pathOf(input) } }));
        }, STALL_MS);
        try {
          const { done, value } = await reader.read();
          clearTimeout(timer);
          if (stalled) return;
          if (done) controller.close(); else controller.enqueue(value);
        } catch (error) {
          clearTimeout(timer);
          if (!stalled) controller.error(error);
        }
      },
      cancel(reason) { clearTimeout(timer); return reader.cancel(reason); },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
})();
