import type { Actor } from '@rakazo/contracts';
import { IsolationError, type Prisma, type PrismaClient } from '@rakazo/db';

const ready = new WeakMap<PrismaClient, Promise<void>>();
export function ensureGroupSharing(prisma: PrismaClient) {
  let pending = ready.get(prisma);
  if (!pending) {
    pending = (async () => {
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS group_shares (
        group_id TEXT NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
        PRIMARY KEY (group_id, user_id), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS group_message_authors (
        message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
        user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
        name TEXT NOT NULL)`);
    })().catch(error => { ready.delete(prisma); throw error; });
    ready.set(prisma, pending);
  }
  return pending;
}

/** Call under the group's row lock for writes, also serializing grant/revoke. */
export async function requireGroupAccess(
  db: PrismaClient | Prisma.TransactionClient, actor: Pick<Actor, 'spaceId' | 'userId'>, groupId: string,
) {
  const group = await db.chatGroup.findFirst({
    where: { id: groupId, spaceId: actor.spaceId, archivedAt: null },
    select: { id: true, userId: true, name: true, thread: { select: { id: true } } },
  });
  if (!group?.thread) throw new IsolationError();
  const membership = await db.spaceMember.findUnique({ where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } } });
  if (!membership) throw new IsolationError();
  if (group.userId !== actor.userId) {
    const grants = await db.$queryRawUnsafe<Array<{ user_id: string }>>(
      'SELECT user_id FROM group_shares WHERE group_id = $1 AND user_id = $2', groupId, actor.userId,
    );
    if (!grants.length) throw new IsolationError();
  }
  return group;
}
