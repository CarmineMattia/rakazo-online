import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hashDeviceToken,
  mintSharedLocalToken,
  verifySharedLocalToken,
} from "./shared-local-token.js";

describe("shared-local gateway token", () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => vi.useRealTimers());

  it("round-trips the owner id", () => {
    const token = mintSharedLocalToken("user_123", 60);
    expect(verifySharedLocalToken(token)?.ownerUserId).toBe("user_123");
  });

  it("rejects a tampered owner id", () => {
    const token = mintSharedLocalToken("user_123", 60);
    const [v, , exp, sig] = token.split(".");
    expect(verifySharedLocalToken(`${v}.user_999.${exp}.${sig}`)).toBeNull();
  });

  it("rejects a forged signature and malformed tokens", () => {
    expect(verifySharedLocalToken("sl1.user_123.9999999999.forged")).toBeNull();
    expect(verifySharedLocalToken("garbage")).toBeNull();
    expect(verifySharedLocalToken("")).toBeNull();
  });

  it("rejects expired tokens", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const token = mintSharedLocalToken("user_123", 60);
    vi.setSystemTime(new Date("2026-01-01T00:02:00Z"));
    expect(verifySharedLocalToken(token)).toBeNull();
  });

  it("hashes device tokens deterministically without echoing them", () => {
    const hash = hashDeviceToken("secret-token");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashDeviceToken("secret-token"));
    expect(hash).not.toContain("secret-token");
  });
});
