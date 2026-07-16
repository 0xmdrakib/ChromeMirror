import "server-only";

import { auth } from "@/lib/auth";
import { env } from "@/lib/env";
import { ApiError } from "@/lib/utils";

export async function requireApiUser(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) throw new ApiError("UNAUTHORIZED", "Sign in is required.", 401);
  return session;
}

export async function requireApiAdmin(request: Request) {
  const session = await requireApiUser(request);
  const expected = env.ADMIN_EMAIL.trim().toLowerCase();
  const actual = session.user.email.trim().toLowerCase();
  if (!expected || actual !== expected) {
    throw new ApiError("FORBIDDEN", "Administrator access is required.", 403);
  }
  return session;
}
