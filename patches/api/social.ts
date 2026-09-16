import { type PrismaClient, requireMembership } from "@rakazo/db";
import type { Hono } from "hono";
import { ensureSpaceInvitesReady } from "./space-invites.js";

const SEARCH_RESULT_LIMIT = 10;
const SEARCH_QUERY_MAX_LENGTH = 64;
const SEARCH_RATE_LIMIT = 30;
const SEARCH_RATE_WINDOW_MS = 60_000;
const PROFILE_BODY_MAX_BYTES = 400 * 1024;
export const PROFILE_IMAGE_MAX_BYTES = 256 * 1024;
const PROFILE_IMAGE_MAX_URL_LENGTH = 2_048;
const PROFILE_IMAGE_DATA_RE = /^data:(image\/(?:png|jpeg|webp|gif));base64,([a-z0-9+/]+={0,2})$/i;
const searchWindows = new Map<string, { startedAt: number; count: number }>();

type ActorLike = { userId: string; spaceId: string };

export type SocialAuth = {
  api: {
    getSession: (args: { headers: Headers }) => Promise<{ user: { id: string } } | null>;
  };
};

export type SocialMountDeps = {
  prisma: PrismaClient;
  auth: SocialAuth;
  sessionHeaders: (request: Request) => Headers;
};

export type UserSearchResult = {
  userId: string;
  username: string;
  name: string;
  email: string | null;
  image: string | null;
  membership: "member" | "invited" | "available";
};

export function normalizeUserSearchQuery(value: unknown): {
  raw: string;
  handle: string;
  email: string | null;
} {
  const raw = String(value ?? "")
    .trim()
    .slice(0, SEARCH_QUERY_MAX_LENGTH);
  const handle = (raw.startsWith("@") ? raw.slice(1) : raw).trim();
  return {
    raw,
    handle,
    email: !raw.startsWith("@") && raw.includes("@") ? raw.toLowerCase() : null,
  };
}

export function usernameFor(name: string): string {
  const value = name.trim().replace(/^@+/, "");
  return value ? `@${value}` : "@human";
}

export function normalizeProfileImage(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw badRequest("Profile image must be a URL or image upload");

  const image = value.trim();
  const data = PROFILE_IMAGE_DATA_RE.exec(image);
  if (data) {
    const encoded = data[2];
    if (!encoded) throw badRequest("Profile image upload is not valid base64");
    if (encoded.length % 4 !== 0) throw badRequest("Profile image upload is not valid base64");
    const decodedBytes =
      Math.floor((encoded.length * 3) / 4) - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0);
    if (decodedBytes <= 0 || decodedBytes > PROFILE_IMAGE_MAX_BYTES) {
      throw badRequest("Profile image must be 256 KB or smaller");
    }
    return image;
  }

  if (image.length > PROFILE_IMAGE_MAX_URL_LENGTH) {
    throw badRequest("Profile image URL is too long");
  }
  let parsed: URL;
  try {
    parsed = new URL(image);
  } catch {
    throw badRequest("Profile image must be a valid http(s) URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw badRequest("Profile image must be a public http(s) URL without credentials");
  }
  return parsed.href;
}

export async function searchUsers(prisma: PrismaClient, actor: ActorLike, value: unknown): Promise<UserSearchResult[]> {
  const query = normalizeUserSearchQuery(value);
  if (query.handle.length < 2 && (!query.email || query.email.length < 2)) return [];
  enforceSearchRateLimit(actor.userId);

  const users = await prisma.user.findMany({
    where: {
      id: { not: actor.userId },
      email: { not: { endsWith: "@messaging.invalid", mode: "insensitive" } },
      OR: [
        ...(query.handle
          ? [
              {
                name: {
                  startsWith: query.handle,
                  mode: "insensitive" as const,
                },
              },
            ]
          : []),
        ...(query.email
          ? [
              {
                email: {
                  equals: query.email,
                  mode: "insensitive" as const,
                },
              },
            ]
          : []),
      ],
    },
    select: { id: true, name: true, email: true, image: true },
    orderBy: [{ name: "asc" }, { email: "asc" }],
    take: SEARCH_RESULT_LIMIT * 2,
  });
  if (!users.length) return [];

  await ensureSpaceInvitesReady(prisma);
  const userIds = users.map((user) => user.id);
  const [memberships, pendingRows] = await Promise.all([
    prisma.spaceMember.findMany({
      where: { spaceId: actor.spaceId, userId: { in: userIds } },
      select: { userId: true },
    }),
    prisma.$queryRawUnsafe<Array<{ target_user_id: string }>>(
      `SELECT target_user_id
         FROM space_invites
        WHERE space_id = $1
          AND target_user_id IS NOT NULL
          AND redeemed_at IS NULL
          AND declined_at IS NULL
          AND expires_at > NOW()
        ORDER BY created_at DESC
        LIMIT 500`,
      actor.spaceId,
    ),
  ]);
  const memberIds = new Set(memberships.map((membership) => membership.userId));
  const invitedIds = new Set(pendingRows.map((row) => row.target_user_id));
  const needle = query.raw.toLowerCase().replace(/^@/, "");

  return users
    .map((user) => ({
      userId: user.id,
      username: usernameFor(user.name),
      name: user.name,
      email: user.email.toLowerCase() === query.email ? user.email : null,
      image: user.image,
      membership: memberIds.has(user.id)
        ? ("member" as const)
        : invitedIds.has(user.id)
          ? ("invited" as const)
          : ("available" as const),
    }))
    .sort((a, b) => {
      const rank = (user: UserSearchResult) => {
        if (user.username.slice(1).toLowerCase() === needle) return 0;
        if (user.email?.toLowerCase() === query.email) return 0;
        if (user.username.slice(1).toLowerCase().startsWith(needle)) return 1;
        return 2;
      };
      return rank(a) - rank(b) || a.username.localeCompare(b.username);
    })
    .slice(0, SEARCH_RESULT_LIMIT);
}

function enforceSearchRateLimit(userId: string): void {
  const now = Date.now();
  const current = searchWindows.get(userId);
  if (!current || now - current.startedAt >= SEARCH_RATE_WINDOW_MS) {
    searchWindows.set(userId, { startedAt: now, count: 1 });
  } else {
    current.count += 1;
    if (current.count > SEARCH_RATE_LIMIT) {
      throw Object.assign(new Error("Too many searches; try again shortly"), { status: 429 });
    }
  }
  if (searchWindows.size <= 5_000) return;
  for (const [id, window] of searchWindows) {
    if (now - window.startedAt >= SEARCH_RATE_WINDOW_MS) searchWindows.delete(id);
    if (searchWindows.size <= 4_000) break;
  }
  while (searchWindows.size > 4_000) {
    const oldest = searchWindows.keys().next().value;
    if (typeof oldest !== "string") break;
    searchWindows.delete(oldest);
  }
}

export async function updateProfileImage(
  prisma: PrismaClient,
  userId: string,
  value: unknown,
): Promise<{
  userId: string;
  name: string;
  email: string;
  image: string | null;
}> {
  const image = normalizeProfileImage(value);
  return prisma.user
    .update({
      where: { id: userId },
      data: { image },
      select: { id: true, name: true, email: true, image: true },
    })
    .then((user) => ({
      userId: user.id,
      name: user.name,
      email: user.email,
      image: user.image,
    }));
}

async function requireActor(deps: SocialMountDeps, request: Request): Promise<ActorLike | null> {
  const session = await deps.auth.api.getSession({
    headers: deps.sessionHeaders(request),
  });
  if (!session?.user) return null;
  return requireMembership(deps.prisma, session.user.id, request.headers.get("x-rakazo-space-id")).catch(() => null);
}

async function readJsonObject(request: Request, maxBytes: number): Promise<Record<string, unknown>> {
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    throw Object.assign(new Error("Request body is too large"), {
      status: 413,
    });
  }
  if (!request.body) return {};

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw Object.assign(new Error("Request body is too large"), {
          status: 413,
        });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw badRequest("Invalid JSON");
  }
}

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { status: 400 });
}

function statusFor(error: unknown): 400 | 401 | 413 | 429 | 500 {
  if (error && typeof error === "object" && "status" in error) {
    const status = Number((error as { status: unknown }).status);
    if (status === 400 || status === 401 || status === 413 || status === 429) return status;
  }
  return 500;
}

function messageFor(error: unknown): string {
  return statusFor(error) === 500
    ? "Request failed"
    : error instanceof Error
      ? error.message
      : "Request failed";
}

/** Additive HTTP surface consumed by the image-based web overlay. */
export function mountSocialRoutes(app: Hono, deps: SocialMountDeps): void {
  app.get("/api/users/search", async (c) => {
    const actor = await requireActor(deps, c.req.raw);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    try {
      const users = await searchUsers(deps.prisma, actor, c.req.query("q"));
      c.header("cache-control", "no-store");
      return c.json({ users });
    } catch (error) {
      return c.json({ error: messageFor(error) }, statusFor(error));
    }
  });

  app.get("/api/profile", async (c) => {
    const actor = await requireActor(deps, c.req.raw);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    const user = await deps.prisma.user.findUnique({
      where: { id: actor.userId },
      select: { id: true, name: true, email: true, image: true },
    });
    if (!user) return c.json({ error: "Profile not found" }, 401);
    c.header("cache-control", "no-store");
    return c.json({
      userId: user.id,
      username: usernameFor(user.name),
      name: user.name,
      email: user.email,
      image: user.image,
    });
  });

  app.patch("/api/profile", async (c) => {
    const actor = await requireActor(deps, c.req.raw);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    try {
      const body = await readJsonObject(c.req.raw, PROFILE_BODY_MAX_BYTES);
      if (!Object.hasOwn(body, "image")) return c.json({ error: "Missing image" }, 400);
      const profile = await updateProfileImage(deps.prisma, actor.userId, body.image);
      c.header("cache-control", "no-store");
      return c.json({ ...profile, username: usernameFor(profile.name) });
    } catch (error) {
      return c.json({ error: messageFor(error) }, statusFor(error));
    }
  });
}
