import { randomBytes } from "node:crypto";
import { type PrismaClient, requireMembership } from "@rakazo/db";
import type { Hono } from "hono";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type SpaceInviteAuth = {
  api: {
    getSession: (args: { headers: Headers }) => Promise<{ user: { id: string; name?: string | null; email?: string | null } } | null>;
  };
};

export type SpaceInviteMountDeps = {
  prisma: PrismaClient;
  auth: SpaceInviteAuth;
  sessionHeaders: (request: Request) => Headers;
};

type ActorLike = { userId: string; spaceId: string };

function newId(): string {
  return randomBytes(16).toString("hex");
}

function newToken(): string {
  return randomBytes(24).toString("hex");
}

async function ensureInvitesTable(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS space_invites (
      id TEXT PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
      inviter_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      redeemed_at TIMESTAMPTZ,
      redeemed_by_user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL
    )
  `);
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS space_invites_space_id_idx ON space_invites(space_id)`,
  );
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS space_invites_token_idx ON space_invites(token)`,
  );
}

let tableReady: Promise<void> | null = null;
function ready(prisma: PrismaClient): Promise<void> {
  if (!tableReady) tableReady = ensureInvitesTable(prisma).catch((error) => {
    tableReady = null;
    throw error;
  });
  return tableReady;
}

async function requireActor(
  deps: SpaceInviteMountDeps,
  request: Request,
): Promise<ActorLike | null> {
  const session = await deps.auth.api.getSession({ headers: deps.sessionHeaders(request) });
  if (!session?.user) return null;
  const requestedSpaceId = request.headers.get("x-rakazo-space-id");
  try {
    return await requireMembership(deps.prisma, session.user.id, requestedSpaceId);
  } catch {
    return null;
  }
}

export async function createSpaceInvite(
  prisma: PrismaClient,
  actor: ActorLike,
): Promise<{ token: string; spaceId: string; spaceName: string; expiresAt: string }> {
  await ready(prisma);
  const membership = await prisma.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
    select: {
      organizationId: true,
      space: { select: { id: true, name: true } },
    },
  });
  if (!membership) throw Object.assign(new Error("Space not found"), { status: 404 });

  const token = newToken();
  const id = newId();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  await prisma.$executeRawUnsafe(
    `INSERT INTO space_invites (id, token, space_id, organization_id, inviter_id, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, NOW(), $6)`,
    id,
    token,
    membership.space.id,
    membership.organizationId,
    actor.userId,
    expiresAt.toISOString(),
  );
  return {
    token,
    spaceId: membership.space.id,
    spaceName: membership.space.name,
    expiresAt: expiresAt.toISOString(),
  };
}

export async function listSpaceInvites(prisma: PrismaClient, actor: ActorLike) {
  await ready(prisma);
  const rows = await prisma.$queryRawUnsafe<
    Array<{
      token: string;
      created_at: Date;
      expires_at: Date;
      redeemed_at: Date | null;
    }>
  >(
    `SELECT token, created_at, expires_at, redeemed_at
     FROM space_invites
     WHERE space_id = $1 AND inviter_id = $2
     ORDER BY created_at DESC
     LIMIT 20`,
    actor.spaceId,
    actor.userId,
  );
  return rows.map((row) => ({
    token: row.token,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    redeemedAt: row.redeemed_at ? new Date(row.redeemed_at).toISOString() : null,
    active: !row.redeemed_at && new Date(row.expires_at).getTime() > Date.now(),
  }));
}

export async function listSpacePeople(prisma: PrismaClient, actor: ActorLike) {
  const members = await prisma.spaceMember.findMany({
    where: { spaceId: actor.spaceId },
    select: {
      userId: true,
      role: true,
      createdAt: true,
      member: { select: { user: { select: { id: true, name: true, email: true, image: true } } } },
    },
    orderBy: { createdAt: "asc" },
  });
  return members.map((row) => ({
    userId: row.userId,
    role: row.role,
    name: row.member.user.name || row.member.user.email || "Member",
    email: row.member.user.email,
    image: row.member.user.image,
    joinedAt: row.createdAt.toISOString(),
    isYou: row.userId === actor.userId,
  }));
}

export async function previewSpaceInvite(prisma: PrismaClient, token: string) {
  await ready(prisma);
  const rows = await prisma.$queryRawUnsafe<
    Array<{
      space_id: string;
      space_name: string;
      expires_at: Date;
      redeemed_at: Date | null;
      inviter_name: string | null;
    }>
  >(
    `SELECT i.space_id, s.name AS space_name, i.expires_at, i.redeemed_at, u.name AS inviter_name
     FROM space_invites i
     JOIN spaces s ON s.id = i.space_id
     JOIN "user" u ON u.id = i.inviter_id
     WHERE i.token = $1
     LIMIT 1`,
    token,
  );
  const row = rows[0];
  if (!row) throw Object.assign(new Error("Invite not found"), { status: 404 });
  if (row.redeemed_at) throw Object.assign(new Error("Invite already used"), { status: 410 });
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    throw Object.assign(new Error("Invite expired"), { status: 410 });
  }
  return {
    spaceId: row.space_id,
    spaceName: row.space_name,
    inviterName: row.inviter_name || "A teammate",
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

export async function redeemSpaceInvite(
  prisma: PrismaClient,
  userId: string,
  token: string,
): Promise<{ spaceId: string; spaceName: string }> {
  await ready(prisma);
  const rows = await prisma.$queryRawUnsafe<
    Array<{
      id: string;
      space_id: string;
      organization_id: string;
      inviter_id: string;
      expires_at: Date;
      redeemed_at: Date | null;
      space_name: string;
    }>
  >(
    `SELECT i.id, i.space_id, i.organization_id, i.inviter_id, i.expires_at, i.redeemed_at, s.name AS space_name
     FROM space_invites i
     JOIN spaces s ON s.id = i.space_id
     WHERE i.token = $1
     LIMIT 1`,
    token,
  );
  const invite = rows[0];
  if (!invite) throw Object.assign(new Error("Invite not found"), { status: 404 });
  if (invite.inviter_id === userId) {
    throw Object.assign(new Error("You cannot redeem your own invite"), { status: 400 });
  }
  if (invite.redeemed_at) {
    // Idempotent if same user already redeemed
    const existing = await prisma.spaceMember.findUnique({
      where: { spaceId_userId: { spaceId: invite.space_id, userId } },
    });
    if (existing) return { spaceId: invite.space_id, spaceName: invite.space_name };
    throw Object.assign(new Error("Invite already used"), { status: 410 });
  }
  if (new Date(invite.expires_at).getTime() <= Date.now()) {
    throw Object.assign(new Error("Invite expired"), { status: 410 });
  }

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.member.upsert({
      where: {
        organizationId_userId: {
          organizationId: invite.organization_id,
          userId,
        },
      },
      create: {
        id: newId(),
        organizationId: invite.organization_id,
        userId,
        role: "member",
        createdAt: now,
      },
      update: { role: "member" },
    });

    // Trigger may have added default-space membership; ensure the invited space too.
    const already = await tx.spaceMember.findUnique({
      where: { spaceId_userId: { spaceId: invite.space_id, userId } },
    });
    if (!already) {
      await tx.spaceMember.create({
        data: {
          id: newId(),
          spaceId: invite.space_id,
          organizationId: invite.organization_id,
          userId,
          role: "member",
          createdAt: now,
        },
      });
    }

    const updated = await tx.$executeRawUnsafe(
      `UPDATE space_invites
       SET redeemed_at = NOW(), redeemed_by_user_id = $2
       WHERE id = $1 AND redeemed_at IS NULL`,
      invite.id,
      userId,
    );
    if (Number(updated) !== 1) {
      // Lost race — check if we still got membership
      const membership = await tx.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId: invite.space_id, userId } },
      });
      if (!membership) throw Object.assign(new Error("Invite already used"), { status: 410 });
    }
  });

  return { spaceId: invite.space_id, spaceName: invite.space_name };
}

function errorStatus(error: unknown): 400 | 401 | 404 | 410 | 500 {
  if (error && typeof error === "object" && "status" in error && typeof (error as { status: unknown }).status === "number") {
    const status = (error as { status: number }).status;
    if (status === 400 || status === 401 || status === 404 || status === 410 || status === 500) return status;
  }
  return 500;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed";
}

/** HTTP routes for invite links + people list (used by the web overlay). */
export function mountSpaceInvites(app: Hono, deps: SpaceInviteMountDeps): void {
  app.get("/api/space-invites/preview/:token", async (c) => {
    try {
      const preview = await previewSpaceInvite(deps.prisma, c.req.param("token"));
      return c.json(preview);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, errorStatus(error));
    }
  });

  app.post("/api/space-invites", async (c) => {
    const actor = await requireActor(deps, c.req.raw);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    try {
      const invite = await createSpaceInvite(deps.prisma, actor);
      const forwardedHost = c.req.header("x-forwarded-host");
      const forwardedProto = c.req.header("x-forwarded-proto") || "http";
      const origin = forwardedHost
        ? `${forwardedProto}://${forwardedHost}`
        : new URL(c.req.url).origin.replace(/:3100$/, ":5173");
      return c.json({
        ...invite,
        url: `${origin}/invite/${invite.token}`,
        urlPath: `/invite/${invite.token}`,
      });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, errorStatus(error));
    }
  });

  app.get("/api/space-invites", async (c) => {
    const actor = await requireActor(deps, c.req.raw);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    try {
      const invites = await listSpaceInvites(deps.prisma, actor);
      return c.json({ invites });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, errorStatus(error));
    }
  });

  app.post("/api/space-invites/redeem", async (c) => {
    const session = await deps.auth.api.getSession({ headers: deps.sessionHeaders(c.req.raw) });
    if (!session?.user) return c.json({ error: "Unauthorized" }, 401);
    let body: { token?: string } = {};
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (!token) return c.json({ error: "Missing token" }, 400);
    try {
      const result = await redeemSpaceInvite(deps.prisma, session.user.id, token);
      return c.json(result);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, errorStatus(error));
    }
  });

  app.get("/api/space-members", async (c) => {
    const actor = await requireActor(deps, c.req.raw);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    try {
      const people = await listSpacePeople(deps.prisma, actor);
      return c.json({ people });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, errorStatus(error));
    }
  });
}
