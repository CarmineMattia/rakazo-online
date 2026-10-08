import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  normalizeProfileImage,
  normalizeUserSearchQuery,
  PROFILE_IMAGE_MAX_BYTES,
  searchUsers,
  usernameFor,
} from "./social.js";

describe("social profile and discovery helpers", () => {
  it("distinguishes @username lookup from email lookup", () => {
    expect(normalizeUserSearchQuery("  @Crime_98  ")).toEqual({
      raw: "@Crime_98",
      handle: "Crime_98",
      email: null,
    });
    expect(normalizeUserSearchQuery("person@example.com")).toEqual({
      raw: "person@example.com",
      handle: "person@example.com",
      email: "person@example.com",
    });
    expect(normalizeUserSearchQuery("human")).toEqual({
      raw: "human",
      handle: "human",
      email: null,
    });
    expect(usernameFor("@human")).toBe("@human");
  });

  it("accepts safe URLs and bounded raster uploads", () => {
    expect(normalizeProfileImage("https://cdn.example/avatar.png")).toBe("https://cdn.example/avatar.png");
    expect(normalizeProfileImage("data:image/png;base64,iVBORw==")).toBe("data:image/png;base64,iVBORw==");
    expect(normalizeProfileImage(null)).toBeNull();
  });

  it("rejects credentials, active content, and oversized uploads", () => {
    expect(() => normalizeProfileImage("https://user:pass@example.com/a.png")).toThrow(/without credentials/);
    expect(() => normalizeProfileImage("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=")).toThrow(/public http/);
    const oversized = Buffer.alloc(PROFILE_IMAGE_MAX_BYTES + 1).toString("base64");
    expect(() => normalizeProfileImage(`data:image/png;base64,${oversized}`)).toThrow(/256 KB/);
  });

  it("returns membership state with a bounded search result", async () => {
    const findManyUsers = vi.fn().mockResolvedValue([
      {
        id: "user-2",
        name: "human",
        email: "human@example.com",
        image: "https://example.com/avatar.png",
      },
    ]);
    const prisma = {
      user: { findMany: findManyUsers },
      spaceMember: { findMany: vi.fn().mockResolvedValue([]) },
      $executeRawUnsafe: vi.fn().mockResolvedValue(0),
      $queryRawUnsafe: vi.fn().mockResolvedValue([{ target_user_id: "user-2" }]),
    } as unknown as PrismaClient;

    await expect(searchUsers(prisma, { userId: "user-1", spaceId: "space-1" }, "@hum")).resolves.toEqual([
      expect.objectContaining({
        userId: "user-2",
        username: "@human",
        email: null,
        membership: "invited",
      }),
    ]);
    expect(findManyUsers).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        email: { not: { endsWith: "@messaging.invalid" }, mode: "insensitive" },
      }),
    }));
    expect(findManyUsers).toHaveBeenCalledWith(expect.objectContaining({ take: 20 }));
  });
});
