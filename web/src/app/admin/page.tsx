import type { Metadata } from "next";
import { and, count, desc, eq, gt, sql, sum } from "drizzle-orm";
import { AdminClient } from "@/components/admin-client";
import { AppShell } from "@/components/app-shell";
import { db, schema } from "@/db";
import { decryptLicenseKey, maskLicenseKey } from "@/lib/crypto";
import { requireAdmin } from "@/lib/session";

export const metadata: Metadata = { title: "Admin" };

export default async function AdminPage() {
  const session = await requireAdmin();
  const now = new Date();

  const [
    [userCount],
    [licenseCount],
    [deviceCount],
    [revenueTotal],
    revenueRows,
    userRows,
    licenseRows,
    paymentRows,
    deviceRows,
    eventRows,
  ] = await Promise.all([
    db.select({ value: count() }).from(schema.user),
    db.select({ value: count() }).from(schema.licenses).where(eq(schema.licenses.status, "active")),
    db.select({ value: count() }).from(schema.deviceLeases).where(gt(schema.deviceLeases.leaseExpiresAt, now)),
    db.select({ value: sum(schema.payments.amountUsdCents) }).from(schema.payments).where(eq(schema.payments.status, "finished")),
    db
      .select({
        month: sql<string>`to_char(date_trunc('month', ${schema.payments.finishedAt}), 'Mon YY')`,
        value: sum(schema.payments.amountUsdCents),
      })
      .from(schema.payments)
      .where(and(eq(schema.payments.status, "finished"), sql`${schema.payments.finishedAt} is not null`))
      .groupBy(sql`date_trunc('month', ${schema.payments.finishedAt})`)
      .orderBy(sql`date_trunc('month', ${schema.payments.finishedAt})`)
      .limit(12),
    db
      .select({
        id: schema.user.id,
        name: schema.user.name,
        email: schema.user.email,
        createdAt: schema.user.createdAt,
        licenseId: schema.licenses.id,
        plan: schema.licenses.plan,
        status: schema.licenses.status,
      })
      .from(schema.user)
      .leftJoin(schema.licenses, eq(schema.licenses.userId, schema.user.id))
      .orderBy(desc(schema.user.createdAt))
      .limit(250),
    db
      .select({
        license: schema.licenses,
        userName: schema.user.name,
        userEmail: schema.user.email,
        lease: schema.deviceLeases,
      })
      .from(schema.licenses)
      .innerJoin(schema.user, eq(schema.user.id, schema.licenses.userId))
      .leftJoin(schema.deviceLeases, eq(schema.deviceLeases.licenseId, schema.licenses.id))
      .orderBy(desc(schema.licenses.createdAt))
      .limit(250),
    db
      .select({
        id: schema.payments.id,
        userName: schema.user.name,
        userEmail: schema.user.email,
        plan: schema.payments.plan,
        amountUsdCents: schema.payments.amountUsdCents,
        status: schema.payments.status,
        providerPaymentId: schema.payments.providerPaymentId,
        createdAt: schema.payments.createdAt,
      })
      .from(schema.payments)
      .innerJoin(schema.user, eq(schema.user.id, schema.payments.userId))
      .orderBy(desc(schema.payments.createdAt))
      .limit(250),
    db
      .select({
        licenseId: schema.deviceLeases.licenseId,
        userName: schema.user.name,
        userEmail: schema.user.email,
        deviceId: schema.deviceLeases.deviceId,
        appVersion: schema.deviceLeases.appVersion,
        lastHeartbeatAt: schema.deviceLeases.lastHeartbeatAt,
        leaseExpiresAt: schema.deviceLeases.leaseExpiresAt,
      })
      .from(schema.deviceLeases)
      .innerJoin(schema.licenses, eq(schema.licenses.id, schema.deviceLeases.licenseId))
      .innerJoin(schema.user, eq(schema.user.id, schema.licenses.userId))
      .where(gt(schema.deviceLeases.leaseExpiresAt, now))
      .orderBy(desc(schema.deviceLeases.lastHeartbeatAt)),
    db
      .select({
        id: schema.licenseEvents.id,
        event: schema.licenseEvents.event,
        actor: schema.licenseEvents.actor,
        detail: schema.licenseEvents.detail,
        createdAt: schema.licenseEvents.createdAt,
        userEmail: schema.user.email,
      })
      .from(schema.licenseEvents)
      .leftJoin(schema.user, eq(schema.user.id, schema.licenseEvents.userId))
      .orderBy(desc(schema.licenseEvents.createdAt))
      .limit(200),
  ]);

  return (
    <AppShell user={session.user} isAdmin>
      <AdminClient
        kpis={{
          users: userCount.value,
          activeLicenses: licenseCount.value,
          onlineDevices: deviceCount.value,
          revenueCents: Number(revenueTotal.value || 0),
        }}
        revenue={revenueRows.map((row) => ({
          month: row.month,
          revenue: Number(row.value || 0) / 100,
        }))}
        users={userRows.map((row) => ({
          ...row,
          createdAt: row.createdAt.toISOString(),
        }))}
        licenses={licenseRows.map((row) => ({
          id: row.license.id,
          userId: row.license.userId,
          userName: row.userName,
          userEmail: row.userEmail,
          maskedKey: maskLicenseKey(decryptLicenseKey(row.license)),
          plan: row.license.plan,
          status: row.license.status,
          expiresAt: row.license.expiresAt?.toISOString() ?? null,
          createdAt: row.license.createdAt.toISOString(),
          lease: row.lease ? {
            deviceId: row.lease.deviceId,
            appVersion: row.lease.appVersion,
            leaseExpiresAt: row.lease.leaseExpiresAt.toISOString(),
            lastHeartbeatAt: row.lease.lastHeartbeatAt.toISOString(),
          } : null,
        }))}
        payments={paymentRows.map((row) => ({
          ...row,
          createdAt: row.createdAt.toISOString(),
        }))}
        devices={deviceRows.map((row) => ({
          ...row,
          lastHeartbeatAt: row.lastHeartbeatAt.toISOString(),
          leaseExpiresAt: row.leaseExpiresAt.toISOString(),
        }))}
        events={eventRows.map((row) => ({
          ...row,
          createdAt: row.createdAt.toISOString(),
        }))}
      />
    </AppShell>
  );
}
