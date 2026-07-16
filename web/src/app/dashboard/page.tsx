import type { Metadata } from "next";
import { desc, eq } from "drizzle-orm";
import { AppShell } from "@/components/app-shell";
import { PortalClient } from "@/components/portal-client";
import { db, schema } from "@/db";
import { env } from "@/lib/env";
import { getPortalLicense } from "@/lib/license-service";
import { isAdminEmail, requireUser } from "@/lib/session";

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const session = await requireUser();
  const [license, paymentRows] = await Promise.all([
    getPortalLicense(session.user.id),
    db
      .select({
        id: schema.payments.id,
        plan: schema.payments.plan,
        amountUsdCents: schema.payments.amountUsdCents,
        status: schema.payments.status,
        createdAt: schema.payments.createdAt,
      })
      .from(schema.payments)
      .where(eq(schema.payments.userId, session.user.id))
      .orderBy(desc(schema.payments.createdAt))
      .limit(50),
  ]);

  return (
    <AppShell user={session.user} isAdmin={isAdminEmail(session.user.email)}>
      <PortalClient
        license={license ? {
          ...license,
          lease: license.lease ? {
            ...license.lease,
            lastHeartbeatAt: license.lease.lastHeartbeatAt.toISOString(),
            leaseExpiresAt: license.lease.leaseExpiresAt.toISOString(),
          } : null,
        } : null}
        payments={paymentRows.map((payment) => ({
          ...payment,
          createdAt: payment.createdAt.toISOString(),
        }))}
        downloadUrl={env.NEXT_PUBLIC_DOWNLOAD_URL}
        sourceUrl={env.NEXT_PUBLIC_GITHUB_REPO}
      />
    </AppShell>
  );
}
