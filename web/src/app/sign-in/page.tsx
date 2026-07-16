import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SignInPanel } from "@/components/sign-in-panel";
import { isGoogleConfigured } from "@/lib/auth";
import { getSession } from "@/lib/session";

export const metadata: Metadata = { title: "Sign in" };

export default async function SignInPage() {
  const session = await getSession();
  if (session) redirect("/dashboard");
  return <SignInPanel googleConfigured={isGoogleConfigured} />;
}
