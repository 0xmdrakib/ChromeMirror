import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { env } from "@/lib/env";

export async function getSession() {
  return auth.api.getSession({ headers: await headers() });
}

export async function requireUser() {
  const session = await getSession();
  if (!session) redirect("/sign-in");
  return session;
}

export async function requireAdmin() {
  const session = await requireUser();
  const expected = env.ADMIN_EMAIL.trim().toLowerCase();
  const actual = session.user.email.trim().toLowerCase();
  if (!expected || actual !== expected) redirect("/dashboard");
  return session;
}

export function isAdminEmail(email: string | null | undefined) {
  return Boolean(
    email &&
    env.ADMIN_EMAIL &&
    email.trim().toLowerCase() === env.ADMIN_EMAIL.trim().toLowerCase()
  );
}
