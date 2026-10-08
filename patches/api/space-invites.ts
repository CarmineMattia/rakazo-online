import { randomBytes } from "node:crypto";
import { type PrismaClient, requireMembership } from "@rakazo/db";
import type { Hono } from "hono";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INVITE_TOKEN_RE = /^[a-f0-9]{48}$/;

export type SpaceInviteAuth = {
  api: {
    getSession: (args: { headers: Headers }) => Promise<{
      user: { id: string; name?: string | null; email?: string | null };
    } | null>;
  };
};

export type SpaceInviteMountDeps = {
  prisma: PrismaClient;
  auth: SpaceInviteAuth;
  sessionHeaders: (request: Request) => Headers;
  /** Public web origin (WEB_ORIGIN). Magic links use the same origin. */
  webOrigin?: string;
};

/**
 * Origin for shareable invite links. Prefer the configured public web origin
 * (the one magic links are aligned to); behind the web proxy the API sees an
 * internal host such as `api:5173`, which is useless to the recipient.
 */
export function inviteLinkOrigin(
  webOrigin: string | undefined,
  request: { url: string; header: (name: string) => string | undefined },
): string {
  if (webOrigin) {
    try {
      const parsed = new URL(webOrigin);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.origin;
    } catch {
      // Fall through to the request-derived origin.
    }
  }
  const forwardedHost = request.header("x-forwarded-host");
  const forwardedProto = request.header("x-forwarded-proto") || "http";
  return forwardedHost
    ? `${forwardedProto}://${forwardedHost}`
    : new URL(request.url).origin.replace(/:3100$/, ":5173");
}

type ActorLike = { userId: string; spaceId: string };

function newId(): string {
  return randomBytes(16).toString("hex");
}

function newToken(): string {
  return randomBytes(24).toString("hex");
}

function usernameFor(name: string): string {
  const value = name.trim().replace(/^@+/, "");
  return value ? `@${value}` : "@human";
}

function validateToken(token: string): void {
  if (!INVITE_TOKEN_RE.test(token)) {
    throw Object.assign(new Error("Invalid invite token"), { status: 400 });
  }
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
      declined_at TIMESTAMPTZ,
      target_user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE,
      redeemed_by_user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL
    )
  `);
  await prisma.$executeRawUnsafe(`ALTER TABLE space_invites ADD COLUMN IF NOT EXISTS declined_at TIMESTAMPTZ`);
  await prisma.$executeRawUnsafe(
    `ALTER TABLE space_invites ADD COLUMN IF NOT EXISTS target_user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE`,
  );
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS space_invites_space_id_idx ON space_invites(space_id)`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS space_invites_token_idx ON space_invites(token)`);
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS space_invites_target_user_idx ON space_invites(target_user_id, expires_at)`,
  );
}

let tableReady: Promise<void> | null = null;
function ready(prisma: PrismaClient): Promise<void> {
  if (!tableReady)
    tableReady = ensureInvitesTable(prisma).catch((error) => {
      tableReady = null;
      throw error;
    });
  return tableReady;
}

export function ensureSpaceInvitesReady(prisma: PrismaClient): Promise<void> {
  return ready(prisma);
}

async function requireActor(deps: SpaceInviteMountDeps, request: Request): Promise<ActorLike | null> {
  const session = await deps.auth.api.getSession({
    headers: deps.sessionHeaders(request),
  });
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
): Promise<{
  token: string;
  spaceId: string;
  spaceName: string;
  expiresAt: string;
}> {
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
      declined_at: Date | null;
      target_user_id: string | null;
      target_name: string | null;
      target_image: string | null;
    }>
  >(
    `SELECT i.token, i.created_at, i.expires_at, i.redeemed_at, i.declined_at,
            i.target_user_id, u.name AS target_name, u.image AS target_image
       FROM space_invites i
       LEFT JOIN "user" u ON u.id = i.target_user_id
      WHERE i.space_id = $1 AND i.inviter_id = $2
      ORDER BY i.created_at DESC
      LIMIT 20`,
    actor.spaceId,
    actor.userId,
  );
  return rows.map((row) => ({
    token: row.token,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    redeemedAt: row.redeemed_at ? new Date(row.redeemed_at).toISOString() : null,
    declinedAt: row.declined_at ? new Date(row.declined_at).toISOString() : null,
    active: !row.redeemed_at && !row.declined_at && new Date(row.expires_at).getTime() > Date.now(),
    target: row.target_user_id
      ? {
          userId: row.target_user_id,
          username: usernameFor(row.target_name || ""),
          name: row.target_name || "Human",
          email: null,
          image: row.target_image,
        }
      : null,
  }));
}

export async function createDirectSpaceInvite(prisma: PrismaClient, actor: ActorLike, targetUserId: string) {
  await ready(prisma);
  if (!targetUserId || targetUserId === actor.userId) {
    throw Object.assign(new Error("Choose another human to invite"), {
      status: 400,
    });
  }
  const [membership, target] = await Promise.all([
    prisma.spaceMember.findUnique({
      where: {
        spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId },
      },
      select: {
        organizationId: true,
        space: { select: { id: true, name: true } },
      },
    }),
    prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, name: true, email: true, image: true },
    }),
  ]);
  if (!membership) throw Object.assign(new Error("Space not found"), { status: 404 });
  if (!target || target.email.toLowerCase().endsWith("@messaging.invalid")) {
    throw Object.assign(new Error("Human not found"), { status: 404 });
  }
  const existingMembership = await prisma.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: actor.spaceId, userId: target.id } },
    select: { id: true },
  });
  const targetDto = {
    userId: target.id,
    username: usernameFor(target.name),
    name: target.name,
    email: null,
    image: target.image,
  };
  if (existingMembership) {
    return {
      status: "already_member" as const,
      spaceId: membership.space.id,
      spaceName: membership.space.name,
      expiresAt: null,
      target: targetDto,
    };
  }

  return prisma.$transaction(async (tx) => {
    // Serialize duplicate invite attempts without requiring a generated Prisma
    // model or a non-expiring partial unique index in the upstream image.
    // The PostgreSQL lock returns void; execute it without deserializing a row.
    await tx.$executeRawUnsafe(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      `space-invite:${actor.spaceId}:${target.id}`,
    );
    const joined = await tx.spaceMember.findUnique({
      where: { spaceId_userId: { spaceId: actor.spaceId, userId: target.id } },
      select: { id: true },
    });
    if (joined) {
      return {
        status: "already_member" as const,
        spaceId: membership.space.id,
        spaceName: membership.space.name,
        expiresAt: null,
        target: targetDto,
      };
    }
    const pending = await tx.$queryRawUnsafe<Array<{ expires_at: Date }>>(
      `SELECT expires_at
         FROM space_invites
        WHERE space_id = $1
          AND target_user_id = $2
          AND redeemed_at IS NULL
          AND declined_at IS NULL
          AND expires_at > NOW()
        ORDER BY created_at DESC
        LIMIT 1`,
      actor.spaceId,
      target.id,
    );
    if (pending[0]) {
      return {
        status: "already_invited" as const,
        spaceId: membership.space.id,
        spaceName: membership.space.name,
        expiresAt: new Date(pending[0].expires_at).toISOString(),
        target: targetDto,
      };
    }

    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
    await tx.$executeRawUnsafe(
      `INSERT INTO space_invites
         (id, token, space_id, organization_id, inviter_id, target_user_id, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7)`,
      newId(),
      newToken(),
      membership.space.id,
      membership.organizationId,
      actor.userId,
      target.id,
      expiresAt.toISOString(),
    );
    return {
      status: "pending" as const,
      spaceId: membership.space.id,
      spaceName: membership.space.name,
      expiresAt: expiresAt.toISOString(),
      target: targetDto,
    };
  });
}

export async function listReceivedSpaceInvites(prisma: PrismaClient, userId: string) {
  await ready(prisma);
  const rows = await prisma.$queryRawUnsafe<
    Array<{
      token: string;
      space_id: string;
      space_name: string;
      inviter_name: string | null;
      inviter_image: string | null;
      created_at: Date;
      expires_at: Date;
    }>
  >(
    `SELECT i.token, i.space_id, s.name AS space_name, inviter.name AS inviter_name,
            inviter.image AS inviter_image, i.created_at, i.expires_at
       FROM space_invites i
       JOIN spaces s ON s.id = i.space_id
       JOIN "user" inviter ON inviter.id = i.inviter_id
      WHERE i.target_user_id = $1
        AND i.redeemed_at IS NULL
        AND i.declined_at IS NULL
        AND i.expires_at > NOW()
      ORDER BY i.created_at DESC
      LIMIT 20`,
    userId,
  );
  return rows.map((row) => ({
    token: row.token,
    spaceId: row.space_id,
    spaceName: row.space_name,
    inviterName: row.inviter_name || "A teammate",
    inviterImage: row.inviter_image,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
  }));
}

export async function declineSpaceInvite(prisma: PrismaClient, userId: string, token: string): Promise<{ ok: true }> {
  validateToken(token);
  await ready(prisma);
  const updated = await prisma.$executeRawUnsafe(
    `UPDATE space_invites
        SET declined_at = NOW()
      WHERE token = $1
        AND target_user_id = $2
        AND redeemed_at IS NULL
        AND declined_at IS NULL
        AND expires_at > NOW()`,
    token,
    userId,
  );
  if (Number(updated) !== 1) {
    throw Object.assign(new Error("Invite not found or no longer active"), {
      status: 404,
    });
  }
  return { ok: true };
}

export async function listSpacePeople(prisma: PrismaClient, actor: ActorLike) {
  const members = await prisma.spaceMember.findMany({
    where: { spaceId: actor.spaceId },
    select: {
      userId: true,
      role: true,
      createdAt: true,
      member: {
        select: {
          user: { select: { id: true, name: true, email: true, image: true } },
        },
      },
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
  validateToken(token);
  await ready(prisma);
  const rows = await prisma.$queryRawUnsafe<
    Array<{
      space_id: string;
      space_name: string;
      expires_at: Date;
      redeemed_at: Date | null;
      declined_at: Date | null;
      target_user_id: string | null;
      inviter_name: string | null;
    }>
  >(
    `SELECT i.space_id, s.name AS space_name, i.expires_at, i.redeemed_at,
            i.declined_at, i.target_user_id, u.name AS inviter_name
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
  if (row.declined_at) throw Object.assign(new Error("Invite was declined"), { status: 410 });
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    throw Object.assign(new Error("Invite expired"), { status: 410 });
  }
  return {
    spaceId: row.space_id,
    spaceName: row.space_name,
    inviterName: row.inviter_name || "A teammate",
    expiresAt: new Date(row.expires_at).toISOString(),
    targeted: Boolean(row.target_user_id),
  };
}

export async function redeemSpaceInvite(
  prisma: PrismaClient,
  userId: string,
  token: string,
): Promise<{ spaceId: string; spaceName: string }> {
  validateToken(token);
  await ready(prisma);
  const rows = await prisma.$queryRawUnsafe<
    Array<{
      id: string;
      space_id: string;
      organization_id: string;
      inviter_id: string;
      expires_at: Date;
      redeemed_at: Date | null;
      declined_at: Date | null;
      target_user_id: string | null;
      space_name: string;
    }>
  >(
    `SELECT i.id, i.space_id, i.organization_id, i.inviter_id, i.expires_at,
            i.redeemed_at, i.declined_at, i.target_user_id, s.name AS space_name
     FROM space_invites i
     JOIN spaces s ON s.id = i.space_id
     WHERE i.token = $1
     LIMIT 1`,
    token,
  );
  const invite = rows[0];
  if (!invite) throw Object.assign(new Error("Invite not found"), { status: 404 });
  if (invite.inviter_id === userId) {
    throw Object.assign(new Error("You cannot redeem your own invite"), {
      status: 400,
    });
  }
  if (invite.target_user_id && invite.target_user_id !== userId) {
    throw Object.assign(new Error("This invite is for another human"), {
      status: 403,
    });
  }
  if (invite.declined_at) {
    throw Object.assign(new Error("Invite was declined"), { status: 410 });
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
    const claimed = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      `UPDATE space_invites
          SET redeemed_at = NOW(), redeemed_by_user_id = $2
        WHERE id = $1
          AND redeemed_at IS NULL
          AND declined_at IS NULL
          AND expires_at > NOW()
          AND (target_user_id IS NULL OR target_user_id = $2)
      RETURNING id`,
      invite.id,
      userId,
    );
    if (claimed.length !== 1) {
      const membership = await tx.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId: invite.space_id, userId } },
      });
      if (membership) return;
      throw Object.assign(new Error("Invite already used or no longer active"), { status: 410 });
    }

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
  });

  return { spaceId: invite.space_id, spaceName: invite.space_name };
}

function errorStatus(error: unknown): 400 | 401 | 403 | 404 | 410 | 500 {
  if (
    error &&
    typeof error === "object" &&
    "status" in error &&
    typeof (error as { status: unknown }).status === "number"
  ) {
    const status = (error as { status: number }).status;
    if (status === 400 || status === 401 || status === 403 || status === 404 || status === 410 || status === 500) {
      return status;
    }
  }
  return 500;
}

function errorMessage(error: unknown): string {
  return errorStatus(error) === 500
    ? "Request failed"
    : error instanceof Error
      ? error.message
      : "Request failed";
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
      const origin = inviteLinkOrigin(deps.webOrigin, {
        url: c.req.url,
        header: (name) => c.req.header(name),
      });
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

  app.post("/api/space-invites/direct", async (c) => {
    const actor = await requireActor(deps, c.req.raw);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    let body: { userId?: unknown } = {};
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const userId = typeof body.userId === "string" ? body.userId.trim() : "";
    if (!userId || userId.length > 200) return c.json({ error: "Missing userId" }, 400);
    try {
      return c.json(await createDirectSpaceInvite(deps.prisma, actor, userId));
    } catch (error) {
      return c.json({ error: errorMessage(error) }, errorStatus(error));
    }
  });

  app.get("/api/space-invites/received", async (c) => {
    const session = await deps.auth.api.getSession({
      headers: deps.sessionHeaders(c.req.raw),
    });
    if (!session?.user) return c.json({ error: "Unauthorized" }, 401);
    try {
      c.header("cache-control", "no-store");
      return c.json({
        invites: await listReceivedSpaceInvites(deps.prisma, session.user.id),
      });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, errorStatus(error));
    }
  });

  app.post("/api/space-invites/decline", async (c) => {
    const session = await deps.auth.api.getSession({
      headers: deps.sessionHeaders(c.req.raw),
    });
    if (!session?.user) return c.json({ error: "Unauthorized" }, 401);
    let body: { token?: unknown } = {};
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (!token) return c.json({ error: "Missing token" }, 400);
    try {
      return c.json(await declineSpaceInvite(deps.prisma, session.user.id, token));
    } catch (error) {
      return c.json({ error: errorMessage(error) }, errorStatus(error));
    }
  });

  app.post("/api/space-invites/redeem", async (c) => {
    const session = await deps.auth.api.getSession({
      headers: deps.sessionHeaders(c.req.raw),
    });
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
