import { onError, ORPCError, os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { IsolationError } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { mapDomainRpcErrors, PUBLIC_NOT_FOUND_MESSAGE, toPublicRpcError } from "./rpc-errors.js";


describe("toPublicRpcError", () => {
  it("maps IsolationError to a generic NOT_FOUND", () => {
    const mapped = toPublicRpcError(new IsolationError());
    expect(mapped).toBeInstanceOf(ORPCError);
    expect((mapped as ORPCError<string, unknown>).code).toBe("NOT_FOUND");
    expect((mapped as ORPCError<string, unknown>).status).toBe(404);
    expect((mapped as Error).message).toBe(PUBLIC_NOT_FOUND_MESSAGE);
  });

  it("leaves other errors alone", () => {
    const boom = new Error("boom");
    expect(toPublicRpcError(boom)).toBe(boom);
  });
});

describe("RPC handler with mapDomainRpcErrors", () => {
  const router = os.router({
    isolated: os.handler(async () => {
      throw new IsolationError("Resource not found: bot cmuzpxqke000051t75umcr8e5");
    }),
    broken: os.handler(async () => {
      throw new Error("db exploded");
    }),
  });
  const logged: unknown[] = [];
  const handler = new RPCHandler(router, {
    clientInterceptors: [onError((error) => { if (!(error instanceof ORPCError)) logged.push(error); }), mapDomainRpcErrors],
  });
  const call = async (path: string) => {
    const { response } = await handler.handle(
      new Request(`http://local/rpc/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
      { prefix: "/rpc", context: {} },
    );
    return { status: response!.status, body: await response!.text() };
  };

  it("returns 404 without leaking ids or internals for cross-tenant access", async () => {
    const res = await call("isolated");
    expect(res.status).toBe(404);
    expect(res.body).toContain("NOT_FOUND");
    expect(res.body).not.toContain("cmuzpxqke");
    expect(res.body).not.toContain("IsolationError");
    expect(logged).toHaveLength(0);
  });

  it("still returns 500 (and logs) for unexpected errors", async () => {
    const res = await call("broken");
    expect(res.status).toBe(500);
    expect(res.body).not.toContain("db exploded");
    expect(logged).toHaveLength(1);
  });
});
