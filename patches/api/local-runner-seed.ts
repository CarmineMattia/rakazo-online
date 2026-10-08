/**
 * Seed (or rotate) a local-runner device token for a user. M1 only — no pairing UI.
 *
 *   docker exec rakazo-api-1 sh -c \
 *     'cd /app/apps/api && npx tsx src/local-runner-seed.ts --email you@example.com --name my-pc' \
 *     > ~/.config/rakazo-runner/credentials.json   # chmod 600 first; never print it
 *
 * Prints ONE JSON object to stdout: { deviceId, token, gatewayWsUrl }.
 * Only the SHA-256 hash of the token is stored in local_runner_devices.
 * Re-running with --device-id <id> rotates that device's token.
 */
import { createDb } from "@rakazo/db";
import { seedLocalRunnerDevice } from "./local-runners.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const email = arg("email");
const name = arg("name") ?? "local-runner";
const deviceId = arg("device-id");
const gatewayWsUrl = arg("ws-url") ?? "ws://127.0.0.1:3100/api/local-runners/ws";
if (!email) {
  process.stderr.write("usage: local-runner-seed --email <email> [--name n] [--device-id id] [--ws-url url]\n");
  process.exit(2);
}
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  process.stderr.write("DATABASE_URL is not set\n");
  process.exit(2);
}
const { prisma, pool } = createDb(databaseUrl);
try {
  const users = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id FROM "user" WHERE lower(email) = lower($1)`,
    email,
  );
  const userId = users[0]?.id;
  if (!userId) {
    process.stderr.write("No user with that email\n");
    process.exit(1);
  }
  const seeded = await seedLocalRunnerDevice(prisma, { userId, name, deviceId });
  process.stdout.write(`${JSON.stringify({ ...seeded, gatewayWsUrl })}\n`);
  process.stderr.write(`seeded device ${seeded.deviceId} for user ${userId}\n`);
} finally {
  await prisma.$disconnect().catch(() => undefined);
  await pool?.end().catch(() => undefined);
}
