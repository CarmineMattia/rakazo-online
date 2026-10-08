import { describe, expect, it } from "vitest";
import { inviteLinkOrigin } from "./space-invites.js";

const request = (url: string, headers: Record<string, string> = {}) => ({
  url,
  header: (name: string) => headers[name.toLowerCase()],
});

describe("inviteLinkOrigin", () => {
  it("uses the configured public web origin instead of the proxied API host", () => {
    expect(inviteLinkOrigin("https://rakazo.example.org/", request("http://api:5173/api/space-invites"))).toBe(
      "https://rakazo.example.org",
    );
    expect(inviteLinkOrigin("http://127.0.0.1:5173", request("http://api:5173/api/space-invites"))).toBe(
      "http://127.0.0.1:5173",
    );
  });

  it("falls back to forwarded headers, then the request origin, without a usable web origin", () => {
    expect(
      inviteLinkOrigin(undefined, request("http://api:3100/x", { "x-forwarded-host": "lan.example:5173" })),
    ).toBe("http://lan.example:5173");
    expect(inviteLinkOrigin("not a url", request("http://127.0.0.1:3100/x"))).toBe("http://127.0.0.1:5173");
    expect(inviteLinkOrigin("javascript:alert(1)", request("http://127.0.0.1:3100/x"))).toBe(
      "http://127.0.0.1:5173",
    );
  });
});
