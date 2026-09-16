import type { PrismaClient } from "@rakazo/db";
import { requireMembership } from "@rakazo/db";
import type { Hono } from "hono";

type ComputerSettingsAuth = {
  api: {
    getSession: (args: {
      headers: Headers;
    }) => Promise<{ user: { id: string } } | null>;
  };
};

type ComputerSettingsMountDeps = {
  prisma: PrismaClient;
  auth: ComputerSettingsAuth;
  sessionHeaders: (request: Request) => Headers;
  sandboxProvider: string;
};

async function requireActor(deps: ComputerSettingsMountDeps, request: Request) {
  const session = await deps.auth.api.getSession({ headers: deps.sessionHeaders(request) });
  if (!session?.user) return null;
  const requestedSpaceId = request.headers.get("x-rakazo-space-id");
  return requireMembership(deps.prisma, session.user.id, requestedSpaceId).catch(() => null);
}

function allowLocalAccessFromHost(computerHost: string | null | undefined): boolean {
  return computerHost === "this-mac";
}

/** HTTP routes for Settings → Computer (local host access toggle). */
export function mountComputerSettings(app: Hono, deps: ComputerSettingsMountDeps): void {
  app.get("/api/computer-settings", async (c) => {
    const actor = await requireActor(deps, c.req.raw);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    const settings = await deps.prisma.deploymentSettings.findUnique({ where: { id: "default" } });
    const allowLocalAccess = allowLocalAccessFromHost(settings?.computerHost);
    return c.json({
      allowLocalAccess,
      computerHost: settings?.computerHost ?? "docker",
      canEdit: actor.isDeploymentOwner,
      sandboxProvider: deps.sandboxProvider,
      hostHomeInBot: allowLocalAccess ? "/mnt/local" : null,
      hostHomeConfigured: Boolean(process.env.RAKAZO_HOST_HOME?.trim()),
    });
  });

  app.post("/api/computer-settings", async (c) => {
    const actor = await requireActor(deps, c.req.raw);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    if (!actor.isDeploymentOwner) return c.json({ error: "Only the deployment owner can change this" }, 403);
    if (deps.sandboxProvider !== "docker") {
      return c.json({ error: "Local access is only available with Docker computers" }, 400);
    }

    let body: { allowLocalAccess?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    if (typeof body.allowLocalAccess !== "boolean") {
      return c.json({ error: "allowLocalAccess must be a boolean" }, 400);
    }

    const computerHost = body.allowLocalAccess ? "this-mac" : "docker";
    if (body.allowLocalAccess && !process.env.RAKAZO_HOST_HOME?.trim()) {
      return c.json(
        {
          error:
            "Host home is not configured (set RAKAZO_HOST_HOME to your machine home path, e.g. /home/you).",
        },
        400,
      );
    }

    await deps.prisma.deploymentSettings.upsert({
      where: { id: "default" },
      create: {
        id: "default",
        ownerUserId: actor.userId,
        signupsEnabled: true,
        signupAllowlist: "",
        signupPolicyInitialized: true,
        computerHost,
      },
      update: { computerHost },
    });

    return c.json({
      allowLocalAccess: body.allowLocalAccess,
      computerHost,
      canEdit: true,
      sandboxProvider: deps.sandboxProvider,
      hostHomeInBot: body.allowLocalAccess ? "/mnt/local" : null,
      note: body.allowLocalAccess
        ? "Bots keep their own computer at /home/rakazo and can also use /mnt/local (your ~/rakazo-local folder). Restart a bot computer if it was already running."
        : "Bots stay only in their own computer space.",
    });
  });
}
