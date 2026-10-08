import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

const base = process.env.RAKAZO_TEST_URL || 'http://127.0.0.1:5173';
assert(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname), 'Use a local test deployment');
const actors = [];
const tag = Date.now();
async function request(path, actor, body, method = body ? 'POST' : 'GET', extra = {}) {
  const response = await fetch(base + path, {
    method,
    headers: { Origin: base, 'Content-Type': 'application/json', ...(actor ? { Authorization: `Bearer ${actor.token}` } : {}), ...extra },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  return { status: response.status, data };
}
async function ok(path, actor, body, extra) {
  const result = await request(path, actor, body, undefined, extra);
  assert.equal(result.status, 200, `${path}: ${result.data.message || result.data.error || result.status}`);
  return result.data;
}
try {
  assert.equal((await request('/api/users/search?q=human')).status, 401);
  for (const suffix of ['a', 'b']) {
    const email = `social-smoke-${tag}-${suffix}@example.invalid`;
    const password = randomBytes(24).toString('base64url');
    const name = `social_smoke_${tag}_${suffix}`;
    const signup = await ok('/api/auth/sign-up/email', null, { email, password, name });
    assert(signup.token && signup.user?.id, 'Signup must create an authenticated session');
    const actor = { email, password, name, token: signup.token, id: signup.user.id };
    actors.push(actor);
    const login = await ok('/api/auth/sign-in/email', null, { email, password });
    assert.equal(login.user.id, actor.id);
    actor.token = login.token;
  }
  const [a, b] = actors;
  const search = await ok(`/api/users/search?q=${encodeURIComponent('@' + b.name)}`, a);
  assert(search.users.some(user => user.userId === b.id && user.email === null));
  const invitation = await ok('/api/space-invites/direct', a, { userId: b.id });
  assert.equal(invitation.status, 'pending');
  const repeated = await ok('/api/space-invites/direct', a, { userId: b.id });
  assert.equal(repeated.status, 'already_invited');
  const received = await ok('/api/space-invites/received', b);
  assert.equal(received.invites.length, 1);
  const token = received.invites[0].token;
  assert.equal((await request('/api/space-invites/redeem', a, { token })).status, 400);
  const accepted = await ok('/api/space-invites/redeem', b, { token });
  assert.equal(accepted.spaceId, invitation.spaceId);
  const again = await ok('/api/space-invites/redeem', b, { token });
  assert.equal(again.spaceId, accepted.spaceId);
  const members = await ok('/api/space-members', b, undefined, { 'x-rakazo-space-id': accepted.spaceId });
  assert(members.people.some(user => user.userId === a.id));
  assert(members.people.some(user => user.userId === b.id));
  assert.equal((await ok('/api/space-invites/received', b)).invites.length, 0);
  console.log('PASS: signup, password login, private search, direct invite, duplicate invite, recipient acceptance, membership and idempotent retry');
} finally {
  // Only deletes disposable accounts created by this run, using their own credentials.
  for (const actor of actors.reverse()) {
    const removed = await request('/api/auth/delete-user', actor, { password: actor.password });
    assert.equal(removed.status, 200, 'Could not clean up a test account');
  }
  console.log('Test accounts removed');
}
