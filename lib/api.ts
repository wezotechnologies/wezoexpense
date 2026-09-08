import "server-only";

import { z } from "zod";
import { ApiError } from "@/lib/rbac";

/**
 * Shared plumbing for route handlers (spec 12): every route is Zod-validated
 * and role-checked, and every failure returns a predictable JSON shape rather
 * than leaking a stack trace.
 */

export function jsonOk<T>(data: T, init?: ResponseInit): Response {
  return Response.json(data, { status: 200, ...init });
}

export function jsonCreated<T>(data: T): Response {
  return Response.json(data, { status: 201 });
}

export function jsonError(
  status: number,
  message: string,
  extra?: Record<string, unknown>,
): Response {
  return Response.json({ error: message, ...extra }, { status });
}

/** Parses and validates a JSON request body. */
export async function parseJson<S extends z.ZodType>(
  request: Request,
  schema: S,
): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new ApiError(400, "Request body must be valid JSON.");
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(422, formatZodError(parsed.error), "VALIDATION");
  }
  return parsed.data;
}

/** Parses and validates URL search params. */
export function parseQuery<S extends z.ZodType>(
  request: Request,
  schema: S,
): z.infer<S> {
  const url = new URL(request.url);
  const raw: Record<string, string | string[]> = {};

  for (const key of new Set(url.searchParams.keys())) {
    const all = url.searchParams.getAll(key);
    raw[key] = all.length > 1 ? all : all[0];
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(422, formatZodError(parsed.error), "VALIDATION");
  }
  return parsed.data;
}

export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((i) => {
      const path = i.path.join(".");
      return path ? `${path}: ${i.message}` : i.message;
    })
    .join("; ");
}

/**
 * Wraps a route handler so thrown ApiErrors become clean JSON and anything
 * unexpected becomes a 500 without exposing internals to the client.
 */
export function route<Args extends unknown[]>(
  handler: (...args: Args) => Promise<Response>,
): (...args: Args) => Promise<Response> {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (error) {
      if (error instanceof ApiError) {
        return jsonError(error.status, error.message,
          error.code ? { code: error.code } : undefined);
      }
      if (error instanceof z.ZodError) {
        return jsonError(422, formatZodError(error), { code: "VALIDATION" });
      }
      console.error("[api] unhandled error:", error);
      return jsonError(500, "Something went wrong. Please try again.");
    }
  };
}
