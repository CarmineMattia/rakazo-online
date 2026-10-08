import { describe, expect, it } from "vitest";
import { classifySharedLocalFailure } from "./executor.js";

describe("classifySharedLocalFailure", () => {
  it("treats runner/gateway drops mid-answer as offline", () => {
    for (const raw of [
      '503: {"message":"This bot runs on the owner\'s computer, which is offline right now. Try again later.","type":"shared_local_offline"}',
      "Runner disconnected (socket closed)",
      "Connection error.",
      "terminated",
      "TypeError: fetch failed",
      "Inference hard timeout after 600000ms",
      '{"error":{"message":"x","type":"shared_local_disconnected"}}',
    ]) expect(classifySharedLocalFailure(raw), raw).toBe("offline");
  });
  it("recognises a busy runner", () => {
    expect(classifySharedLocalFailure('429: {"type":"shared_local_busy"}')).toBe("busy");
  });
  it("leaves model/content errors alone", () => {
    for (const raw of ["400: context length exceeded", "Tool call failed: bad args", "Run cancelled"]) {
      expect(classifySharedLocalFailure(raw), raw).toBeNull();
    }
  });
});
