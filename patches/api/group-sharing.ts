import type { Hono, Context } from 'hono';
import { IsolationError, lockOwnedGroup, requireMembership, type ThreadEvents } from '@rakazo/db';
import type { JobPublisher } from '@rakazo/adapter-kit';
import type { SocialMountDeps } from './social.js';
import { ensureGroupSharing, requireGroupAccess } from './group-access.js';
import { resolveThreadTarget, sendThreadMessage } from './thread-target.js';

export function mountGroupSharing(app: Hono, deps: SocialMountDeps & { events: ThreadEvents; jobs: JobPublisher }) {
  app.use('/api/group-sharing/*', async (c, next) => {
    // JSON-only mutations prevent cross-site form submissions with cookie sessions.
    if (c.req.method === 'POST' && c.req.header('content-type')?.split(';')[0]?.trim() !== 'application/json')
      return c.json({ error: 'Use application/json' }, 415);
    await next();
  });
  function route(handler: (c: Context) => Promise<Response>) {
    return async (c: Context) => {
    try { return await handler(c); } catch (error) {
      if (error instanceof IsolationError) return c.json({ error: 'Group not found or access revoked' }, 404);
      if (error instanceof SyntaxError) return c.json({ error: 'Invalid request' }, 400);
      throw error;
    }
    };
  }
  async function actorFor(request: Request) {
    const session = await deps.auth.api.getSession({ headers: deps.sessionHeaders(request) });
    if (!session) return null;
    await ensureGroupSharing(deps.prisma);
    return requireMembership(deps.prisma, session.user.id, request.headers.get('x-rakazo-space-id'));
  }
  app.get('/api/group-sharing/groups', route(async c => {
    const actor = await actorFor(c.req.raw);
    if (!actor) return c.json({ error: 'Unauthorized' }, 401);
    const shares = await deps.prisma.$queryRawUnsafe<Array<{ group_id: string }>>(
      'SELECT group_id FROM group_shares WHERE user_id = $1', actor.userId,
    );
    const groups = await deps.prisma.chatGroup.findMany({
      where: { spaceId: actor.spaceId, archivedAt: null,
        OR: [{ userId: actor.userId }, { id: { in: shares.map(s => s.group_id) } }] },
      select: { id: true, userId: true, name: true,
        members: { where: { bot: { archivedAt: null } }, select: { bot: { select: { name: true } } } } },
      orderBy: { updatedAt: 'desc' },
    });
    return c.json({ groups: groups.map(g => ({ id: g.id, name: g.name, owned: g.userId === actor.userId,
      bots: g.members.map(m => m.bot.name) })) });
  }));
  app.get('/api/group-sharing/groups/:id/people', route(async c => {
    const actor = await actorFor(c.req.raw);
    if (!actor) return c.json({ error: 'Unauthorized' }, 401);
    const group = await requireGroupAccess(deps.prisma, actor, c.req.param('id')!);
    if (group.userId !== actor.userId) return c.json({ error: 'Only the owner can manage sharing' }, 403);
    const grants = await deps.prisma.$queryRawUnsafe<Array<{ user_id: string }>>(
      'SELECT user_id FROM group_shares WHERE group_id = $1', group.id,
    );
    const people = await deps.prisma.spaceMember.findMany({
      where: { spaceId: actor.spaceId, userId: { not: actor.userId } },
      select: { userId: true, member: { select: { user: { select: { name: true, email: true } } } } },
    });
    return c.json({ people: people.map(p => ({ userId: p.userId, name: p.member.user.name,
      shared: grants.some(g => g.user_id === p.userId) })) });
  }));
  app.post('/api/group-sharing/groups/:id/people', route(async c => {
    const actor = await actorFor(c.req.raw);
    if (!actor) return c.json({ error: 'Unauthorized' }, 401);
    const body = await c.req.json();
    if (!body || typeof body.userId !== 'string' || typeof body.shared !== 'boolean') return c.json({ error: 'Select a person and access setting' }, 400);
    await deps.prisma.$transaction(async tx => {
      await lockOwnedGroup(tx, actor, c.req.param('id')!);
      const group = await requireGroupAccess(tx, actor, c.req.param('id')!);
      if (body.userId === actor.userId) throw new IsolationError();
      const member = await tx.spaceMember.findUnique({ where: { spaceId_userId: { spaceId: actor.spaceId, userId: body.userId } } });
      if (!member) throw new IsolationError();
      if (body.shared) await tx.$executeRawUnsafe(
        'INSERT INTO group_shares (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', group.id, body.userId,
      );
      else await tx.$executeRawUnsafe('DELETE FROM group_shares WHERE group_id = $1 AND user_id = $2', group.id, body.userId);
    });
    return c.json({ ok: true });
  }));
  app.get('/api/group-sharing/groups/:id/messages', route(async c => {
    const actor = await actorFor(c.req.raw);
    if (!actor) return c.json({ error: 'Unauthorized' }, 401);
    return deps.prisma.$transaction(async tx => {
      // A revoke must not race a history read into revealing another page.
      const locked = await tx.$queryRawUnsafe<Array<{ id: string }>>('SELECT id FROM chat_groups WHERE id = $1 FOR SHARE', c.req.param('id')!);
      if (!locked.length) throw new IsolationError();
      const group = await requireGroupAccess(tx, actor, c.req.param('id')!);
      const before = Number(c.req.query('before'));
      const rows = await tx.message.findMany({ where: { threadId: group.thread!.id,
        ...(Number.isSafeInteger(before) && before >= 0 ? { seq: { lt: before } } : {}) },
        orderBy: { seq: 'desc' }, take: 100,
        select: { id: true, seq: true, role: true, blocks: true, botId: true } });
      const authors = await tx.$queryRawUnsafe<Array<{ message_id: string; name: string }>>(
        'SELECT message_id, name FROM group_message_authors WHERE message_id = ANY($1::text[])', rows.map(r => r.id),
      );
      const botNames = await tx.bot.findMany({ where: { id: { in: rows.flatMap(r => r.botId ? [r.botId] : []) }, spaceId: actor.spaceId }, select: { id: true, name: true } });
      // Native group sends come only from the owner; shared sends carry an author row.
      const owner = await tx.user.findUnique({ where: { id: group.userId }, select: { name: true } });
      const ownerName = owner?.name?.trim() || 'Owner';
      const latestRun = await tx.run.findFirst({ where: { threadId: group.thread!.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { status: true } });
      const active = await tx.run.findMany({ where: { threadId: group.thread!.id, status: { in: ['queued','leased','running','waiting_input','waiting_takeover'] } }, select: { status: true } });
      return c.json({ name: group.name, messages: rows.reverse().map(row => {
        const sharedName = authors.find(a => a.message_id === row.id)?.name;
        let text = (Array.isArray(row.blocks) ? row.blocks : []).filter((b: any) => b?.kind === 'text').map((b: any) => b.text).join('\n');
        // The stored prompt keeps "@Name: " for the bots and the owner's native view;
        // the shared view already shows the author label, so drop the duplicate prefix.
        if (sharedName && text.startsWith(`@${sharedName}: `)) text = text.slice(sharedName.length + 3);
        return { id: row.id, seq: row.seq, role: row.role,
          author: sharedName || botNames.find(b => b.id === row.botId)?.name || (row.role === 'user' ? ownerName : 'Bot'),
          text };
      }), active: active.map(r => r.status), failed: latestRun?.status === 'failed' });
    });
  }));
  app.post('/api/group-sharing/groups/:id/messages', route(async c => {
    const actor = await actorFor(c.req.raw);
    if (!actor) return c.json({ error: 'Unauthorized' }, 401);
    const body = await c.req.json();
    if (!body || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 16000 ||
        typeof body.clientNonce !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(body.clientNonce)) return c.json({ error: 'Enter a message (maximum 16000 characters)' }, 400);
    const group = await requireGroupAccess(deps.prisma, actor, c.req.param('id')!);
    const owner = await requireMembership(deps.prisma, group.userId, actor.spaceId);
    const target = await resolveThreadTarget(deps.prisma, owner, { groupId: group.id });
    if (target.kind !== 'group') throw new IsolationError();
    // Runs retain the bots' owner for provider credentials; authorization and authorship
    // are checked independently for the real requester inside the send transaction.
    target.sharedRequester = actor;
    try {
      const sent = await sendThreadMessage(deps, owner, target, { text: body.text.trim(),
        clientNonce: `shared_${actor.userId}_${body.clientNonce}` });
      return c.json({ ok: true, runIds: sent.runIds });
    } catch (error) {
      if (error instanceof IsolationError) throw error;
      if (error && typeof error === 'object' && 'code' in error && error.code === 'CONFLICT') return c.json({ error: 'The owner must answer the pending bot request first' }, 409);
      throw error;
    }
  }));
}
