/**
 * Map known domain errors raised inside RPC procedures to public oRPC errors.
 *
 * IsolationError is what the repos throw when a row is missing or belongs to
 * another user/space. Before this, it fell through as an unexpected error and
 * came back as HTTP 500. Cross-tenant probes now get a plain 404 that says
 * nothing about whether the resource exists for someone else.
 */
import { ORPCError } from "@orpc/server";
import { IsolationError } from "@rakazo/db";

export const PUBLIC_NOT_FOUND_MESSAGE = "Not found";

export function toPublicRpcError(error: unknown): unknown {
  if (error instanceof IsolationError) {
    return new ORPCError("NOT_FOUND", { message: PUBLIC_NOT_FOUND_MESSAGE });
  }
  return error;
}

/** oRPC client interceptor: run it innermost so error logging only sees unexpected errors. */
export async function mapDomainRpcErrors<T>({ next }: { next: () => Promise<T> }): Promise<T> {
  try {
    return await next();
  } catch (error) {
    throw toPublicRpcError(error);
  }
}
