import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decodeFrame, encodeFrame, isClientFrame, isServerFrame } from "./protocol.ts";

describe("protocol codec", () => {
  it("round-trips hello", () => {
    const frame = {
      type: "hello" as const,
      deviceId: "dev1",
      token: "tok",
      runnerVersion: "0.1.0",
      offeredModels: ["m1"],
    };
    const decoded = decodeFrame(encodeFrame(frame));
    assert.deepEqual(decoded, frame);
    assert.equal(isClientFrame(decoded), true);
  });

  it("round-trips infer.request", () => {
    const frame = {
      type: "infer.request" as const,
      id: "r1",
      model: "gemma",
      body: { messages: [{ role: "user", content: "hi" }] },
    };
    const decoded = decodeFrame(encodeFrame(frame));
    assert.deepEqual(decoded, frame);
    assert.equal(isServerFrame(decoded), true);
  });

  it("rejects unknown type", () => {
    assert.throws(() => decodeFrame(JSON.stringify({ type: "nope" })), /Unknown frame type/);
  });

  it("rejects non-json", () => {
    assert.throws(() => decodeFrame("not-json"), /Invalid JSON/);
  });
});
