import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { JSDOM } = require(process.env.RAKAZO_JSDOM_PATH || 'jsdom');
const script = readFileSync(process.env.RAKAZO_AUTH_OVERLAY || new URL('../patches/web/dist/magic-auth-overlay.js', import.meta.url), 'utf8');

async function run(path, next) {
  const dom = new JSDOM('<div id="root"><form><input id="name" value="@testhuman"><input id="email" value="test@example.invalid"><input name="password" type="password" required><button type="submit">Submit</button></form><a href="/sign-up">Sign up</a><a href="/sign-in">Sign in</a></div>', {
    url: `http://localhost:5173${path}?next=${encodeURIComponent(next)}`, runScripts: 'outside-only',
  });
  const calls = [];
  const observers = [];
  const Observer = dom.window.MutationObserver;
  dom.window.MutationObserver = class extends Observer {
    constructor(callback) { super(callback); observers.push(this); }
  };
  dom.window.fetch = async (url, options) => {
    if (url === '/api/auth/capabilities') return { ok: true, json: async () => ({ magicLink: true, emailEmulator: false, webOrigin: 'http://localhost:5173' }) };
    if (url === '/api/auth/check-email') return { ok: true, json: async () => ({ exists: false }) };
    calls.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({}) };
  };
  dom.window.eval(script);
  try {
    for (let i = 0; i < 100 && !dom.window.document.querySelector('form').dataset.rkMagicBound; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(dom.window.document.querySelector('form').dataset.rkMagicBound, '1');
    const password = dom.window.document.querySelector('input[name="password"]');
    assert.equal(password.required, false);
    assert.equal(password.disabled, true);
    assert.equal(dom.window.document.querySelector('form').checkValidity(), true);
    const links = [...dom.window.document.querySelectorAll('a')].map(a => a.getAttribute('href'));
    dom.window.document.querySelector('form').requestSubmit();
    for (let i = 0; i < 100 && !calls.length; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(calls.length, 1);
    const form = dom.window.document.querySelector('form');
    for (let i = 0; i < 100 && form.dataset.rkShowingSent !== '1'; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(form.dataset.rkShowingSent, '1');
    assert.ok(dom.window.document.getElementById('rk-magic-auth-banner'));
    assert.equal(JSON.parse(dom.window.sessionStorage.getItem('rk.magicLinkSent')).email, 'test@example.invalid');
    return { links, body: calls[0] };
  } finally { observers.forEach(observer => observer.disconnect()); await Promise.resolve(); dom.window.close(); }
}

test('sign-in keeps the invite in auth links and all magic-link destinations', async () => {
  const { links, body } = await run('/sign-in', '/invite/abcdef123456');
  assert(links.every(link => link.includes('next=%2Finvite%2Fabcdef123456')));
  assert.equal(body.callbackURL, 'http://localhost:5173/invite/abcdef123456');
  assert.equal(body.newUserCallbackURL, body.callbackURL);
  assert.equal(body.errorCallbackURL, 'http://localhost:5173/sign-in?next=%2Finvite%2Fabcdef123456');
});
test('new registration returns to the invite instead of unrelated onboarding', async () => {
  const { body } = await run('/sign-up', '/invite/abcdef123456');
  assert.equal(body.newUserCallbackURL, 'http://localhost:5173/invite/abcdef123456');
  assert.equal(body.name, 'testhuman');
});
test('external redirects and backslash host changes cannot become callbacks', async () => {
  for (const next of ['//example.invalid/steal', '/\\example.invalid/steal', 'https://example.invalid']) {
    const { body, links } = await run('/sign-in', next);
    assert.equal(body.callbackURL, 'http://localhost:5173/app');
    assert.equal(body.newUserCallbackURL, 'http://localhost:5173/onboarding');
    assert(links.every(link => !link.includes('next=')));
  }
});
