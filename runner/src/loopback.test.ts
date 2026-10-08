import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertSameOriginLoopback,
  loopbackRequestUrl,
  parseLoopbackBaseUrl,
} from "./loopback.ts";

describe("loopback restriction", () => {
  it("accepts 127.0.0.1", () => {
    const u = parseLoopbackBaseUrl("http://127.0.0.1:11434/v1");
    assert.equal(u.hostname, "127.0.0.1");
  });

  it("accepts localhost", () => {
    parseLoopbackBaseUrl("http://localhost:11434/v1");
  });

  it("rejects public host", () => {
    assert.throws(() => parseLoopbackBaseUrl("http://example.com/v1"), /loopback/);
  });

  it("rejects private LAN host", () => {
    assert.throws(() => parseLoopbackBaseUrl("http://192.168.1.5:11434/v1"), /loopback/);
  });

  it("rejects host.docker.internal", () => {
    assert.throws(
      () => parseLoopbackBaseUrl("http://host.docker.internal:11434/v1"),
      /loopback/,
    );
  });

  it("builds chat completions URL on same host", () => {
    const url = loopbackRequestUrl("http://127.0.0.1:11434/v1", "/chat/completions");
    assert.equal(url, "http://127.0.0.1:11434/v1/chat/completions");
    assertSameOriginLoopback("http://127.0.0.1:11434/v1", url);
  });

  it("assertSameOrigin rejects different host", () => {
    assert.throws(
      () =>
        assertSameOriginLoopback(
          "http://127.0.0.1:11434/v1",
          "http://evil.example/v1/chat/completions",
        ),
      /host must match/,
    );
  });
});
