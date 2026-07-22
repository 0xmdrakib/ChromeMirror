import "server-only";

import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import {
  decryptLicenseKey,
  encryptLicenseKey,
  generateLicenseKey,
  licenseKeyHash,
  maskLicenseKey,
} from "@/lib/crypto";
import { signDesktopToken, verifyDesktopResumeToken, verifyDesktopToken } from "@/lib/license-token";
import { ApiError } from "@/lib/utils";

export const LEASE_DURATION_MS = 10 * 60 * 1000;
export const ANNUAL_DURATION_DAYS = 365;

type LicenseRow = typeof schema.licenses.$inferSelect;
type DbExecutor = Pick<typeof db, "select" | "insert" | "update" | "delete" | "execute">;

export type GrantPlan = "annual" | "lifetime";

export function calculateGrantTerm(input: {
  currentPlan: string;
  currentExpiry: Date | null;
  grantPlan: GrantPlan;
  now: Date;
}) {
  if (input.grantPlan === "lifetime" || input.currentPlan === "lifetime") {
    return { plan: "lifetime", expiresAt: null };
  }
  const base =
    input.currentExpiry && input.currentExpiry > input.now
      ? input.currentExpiry
      : input.now;
  return {
    plan: "annual",
    expiresAt: new Date(base.getTime() + ANNUAL_DURATION_DAYS * 24 * 60 * 60 * 1000),
  };
}

function licenseError(license: LicenseRow, now = new Date()) {
  if (license.status === "suspended") {
    return new ApiError("SUSPENDED", "This license is suspended.", 403);
  }
  if (license.status === "cancelled") {
    return new ApiError("CANCELLED", "This license is cancelled.", 403);
  }
  if (license.plan !== "lifetime" && (!license.expiresAt || license.expiresAt <= now)) {
    return new ApiError("EXPIRED", "This license has expired.", 403);
  }
  if (license.status !== "active") {
    return new ApiError("INVALID_KEY", "This license is not active.", 403);
  }
  return null;
}

function publicLicense(license: LicenseRow, leaseExpiresAt?: Date | null) {
  return {
    id: license.id,
    plan: license.plan,
    status: license.status,
    expires_at: license.expiresAt?.toISOString() ?? null,
    lease_expires_at: leaseExpiresAt?.toISOString() ?? null,
    label: license.plan === "lifetime" ? "Lifetime access" : "Annual access",
  };
}

async function createLicense(executor: DbExecutor, userId: string, source: string) {
  const key = generateLicenseKey();
  const encrypted = encryptLicenseKey(key);
  const [license] = await executor
    .insert(schema.licenses)
    .values({
      userId,
      keyHash: licenseKeyHash(key),
      keyCiphertext: encrypted.ciphertext,
      keyIv: encrypted.iv,
      keyTag: encrypted.tag,
      plan: "annual",
      status: "active",
      source,
      expiresAt: new Date(),
    })
    .returning();
  return { license, key };
}

export async function grantPlan(
  executor: DbExecutor,
  input: {
    userId: string;
    plan: GrantPlan;
    actor: string;
    source: string;
    detail?: Record<string, unknown>;
  },
) {
  const now = new Date();
  let [license] = await executor
    .select()
    .from(schema.licenses)
    .where(eq(schema.licenses.userId, input.userId))
    .limit(1);

  let createdKey: string | null = null;
  if (!license) {
    const created = await createLicense(executor, input.userId, input.source);
    license = created.license;
    createdKey = created.key;
  }

  const term = calculateGrantTerm({
    currentPlan: license.plan,
    currentExpiry: license.expiresAt,
    grantPlan: input.plan,
    now,
  });

  const status = license.status === "suspended" ? "suspended" : "active";
  [license] = await executor
    .update(schema.licenses)
    .set({
      plan: term.plan,
      status,
      expiresAt: term.expiresAt,
      source: input.source,
      updatedAt: now,
    })
    .where(eq(schema.licenses.id, license.id))
    .returning();

  await executor.insert(schema.licenseEvents).values({
    licenseId: license.id,
    userId: input.userId,
    event: input.plan === "lifetime" ? "license.upgraded_lifetime" : "license.extended_annual",
    actor: input.actor,
    detail: input.detail ?? null,
  });

  return { license, createdKey };
}

export async function getPortalLicense(userId: string) {
  const [row] = await db
    .select({
      license: schema.licenses,
      lease: schema.deviceLeases,
    })
    .from(schema.licenses)
    .leftJoin(schema.deviceLeases, eq(schema.deviceLeases.licenseId, schema.licenses.id))
    .where(eq(schema.licenses.userId, userId))
    .limit(1);
  if (!row) return null;
  const key = decryptLicenseKey(row.license);
  return {
    ...publicLicense(row.license, row.lease?.leaseExpiresAt),
    maskedKey: maskLicenseKey(key),
    lease: row.lease
      ? {
          deviceId: row.lease.deviceId,
          appVersion: row.lease.appVersion,
          machineInfo: row.lease.machineInfo,
          lastHeartbeatAt: row.lease.lastHeartbeatAt,
          leaseExpiresAt: row.lease.leaseExpiresAt,
          online: row.lease.leaseExpiresAt > new Date(),
        }
      : null,
  };
}

export async function revealPortalLicenseKey(userId: string) {
  const [license] = await db
    .select()
    .from(schema.licenses)
    .where(eq(schema.licenses.userId, userId))
    .limit(1);
  if (!license) throw new ApiError("NOT_FOUND", "No license is assigned to this account.", 404);
  return decryptLicenseKey(license);
}

export async function activateLicense(input: {
  licenseKey: string;
  deviceId: string;
  machineInfo?: Record<string, unknown>;
  appVersion?: string;
}) {
  const hash = licenseKeyHash(input.licenseKey);
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + LEASE_DURATION_MS);

  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`select id from licenses where key_hash = ${hash} for update`);
    const [license] = await tx
      .select()
      .from(schema.licenses)
      .where(eq(schema.licenses.keyHash, hash))
      .limit(1);
    if (!license) throw new ApiError("INVALID_KEY", "License key is invalid.", 404);
    const stateError = licenseError(license, now);
    if (stateError) throw stateError;

    await tx.execute(sql`select license_id from device_leases where license_id = ${license.id} for update`);
    const [currentLease] = await tx
      .select()
      .from(schema.deviceLeases)
      .where(eq(schema.deviceLeases.licenseId, license.id))
      .limit(1);
    if (
      currentLease &&
      currentLease.leaseExpiresAt > now &&
      currentLease.deviceId !== input.deviceId
    ) {
      throw new ApiError("DEVICE_IN_USE", "This key is active on another computer.", 409, {
        lease_expires_at: currentLease.leaseExpiresAt.toISOString(),
      });
    }

    const sessionId = randomUUID();
    const tokenVersion = license.tokenVersion + 1;
    const [updatedLicense] = await tx
      .update(schema.licenses)
      .set({ tokenVersion, updatedAt: now })
      .where(eq(schema.licenses.id, license.id))
      .returning();

    await tx
      .insert(schema.devices)
      .values({
        licenseId: license.id,
        deviceId: input.deviceId,
        machineInfo: input.machineInfo ?? null,
        appVersion: input.appVersion,
        lastSeenAt: now,
      })
      .onConflictDoUpdate({
        target: [schema.devices.licenseId, schema.devices.deviceId],
        set: {
          machineInfo: input.machineInfo ?? null,
          appVersion: input.appVersion,
          lastSeenAt: now,
        },
      });

    await tx
      .insert(schema.deviceLeases)
      .values({
        licenseId: license.id,
        deviceId: input.deviceId,
        sessionId,
        leaseExpiresAt,
        lastHeartbeatAt: now,
        machineInfo: input.machineInfo ?? null,
        appVersion: input.appVersion,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.deviceLeases.licenseId,
        set: {
          deviceId: input.deviceId,
          sessionId,
          leaseExpiresAt,
          lastHeartbeatAt: now,
          machineInfo: input.machineInfo ?? null,
          appVersion: input.appVersion,
          updatedAt: now,
        },
      });

    await tx.insert(schema.licenseEvents).values({
      licenseId: license.id,
      userId: license.userId,
      event: currentLease ? "device.session_replaced" : "device.activated",
      actor: "desktop",
      detail: {
        deviceId: input.deviceId,
        appVersion: input.appVersion,
        staleTakeover: Boolean(currentLease && currentLease.leaseExpiresAt <= now),
      },
    });

    return { license: updatedLicense, sessionId, tokenVersion };
  });

  const token = await signDesktopToken({
    licenseId: result.license.id,
    sessionId: result.sessionId,
    deviceId: input.deviceId,
    tokenVersion: result.tokenVersion,
  });
  return {
    token,
    license: publicLicense(result.license, leaseExpiresAt),
  };
}

export async function renewDesktopSession(
  token: string,
  appVersion?: string,
) {
  const claims = await verifyDesktopToken(token);
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + LEASE_DURATION_MS);

  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`select id from licenses where id = ${claims.licenseId} for update`);
    const [license] = await tx
      .select()
      .from(schema.licenses)
      .where(eq(schema.licenses.id, claims.licenseId))
      .limit(1);
    if (!license) throw new ApiError("INVALID_KEY", "License no longer exists.", 404);
    const stateError = licenseError(license, now);
    if (stateError) throw stateError;
    if (license.tokenVersion !== claims.tokenVersion) {
      throw new ApiError("SESSION_REPLACED", "This activation session was replaced.", 409);
    }

    const [lease] = await tx
      .select()
      .from(schema.deviceLeases)
      .where(eq(schema.deviceLeases.licenseId, license.id))
      .limit(1);
    if (
      !lease ||
      lease.sessionId !== claims.sessionId ||
      lease.deviceId !== claims.deviceId
    ) {
      throw new ApiError("SESSION_REPLACED", "This activation session was replaced.", 409);
    }

    await tx
      .update(schema.deviceLeases)
      .set({
        leaseExpiresAt,
        lastHeartbeatAt: now,
        appVersion: appVersion ?? lease.appVersion,
        updatedAt: now,
      })
      .where(eq(schema.deviceLeases.licenseId, license.id));
    await tx
      .update(schema.devices)
      .set({
        lastSeenAt: now,
        appVersion: appVersion ?? lease.appVersion,
      })
      .where(and(
        eq(schema.devices.licenseId, license.id),
        eq(schema.devices.deviceId, claims.deviceId),
      ));
    return license;
  });

  return {
    token: await signDesktopToken(claims),
    license: publicLicense(result, leaseExpiresAt),
  };
}

export async function resumeDesktopSession(input: {
  token: string;
  deviceId: string;
  machineInfo?: Record<string, unknown>;
  appVersion?: string;
}) {
  const claims = await verifyDesktopResumeToken(input.token);
  if (claims.deviceId !== input.deviceId) {
    throw new ApiError("DEVICE_MISMATCH", "Activation belongs to another computer.", 409);
  }
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + LEASE_DURATION_MS);

  const license = await db.transaction(async (tx) => {
    await tx.execute(sql`select id from licenses where id = ${claims.licenseId} for update`);
    const [currentLicense] = await tx
      .select()
      .from(schema.licenses)
      .where(eq(schema.licenses.id, claims.licenseId))
      .limit(1);
    if (!currentLicense) throw new ApiError("INVALID_KEY", "License no longer exists.", 404);
    const stateError = licenseError(currentLicense, now);
    if (stateError) throw stateError;
    if (currentLicense.tokenVersion !== claims.tokenVersion) {
      throw new ApiError("SESSION_REPLACED", "This activation session was replaced.", 409);
    }

    const [lease] = await tx
      .select()
      .from(schema.deviceLeases)
      .where(eq(schema.deviceLeases.licenseId, currentLicense.id))
      .limit(1);
    if (
      !lease
      || lease.sessionId !== claims.sessionId
      || lease.deviceId !== claims.deviceId
    ) {
      throw new ApiError("SESSION_REPLACED", "This activation session was replaced.", 409);
    }

    await tx
      .update(schema.deviceLeases)
      .set({
        leaseExpiresAt,
        lastHeartbeatAt: now,
        machineInfo: input.machineInfo ?? lease.machineInfo,
        appVersion: input.appVersion ?? lease.appVersion,
        updatedAt: now,
      })
      .where(eq(schema.deviceLeases.licenseId, currentLicense.id));
    await tx
      .update(schema.devices)
      .set({
        lastSeenAt: now,
        machineInfo: input.machineInfo ?? lease.machineInfo,
        appVersion: input.appVersion ?? lease.appVersion,
      })
      .where(and(
        eq(schema.devices.licenseId, currentLicense.id),
        eq(schema.devices.deviceId, claims.deviceId),
      ));
    await tx.insert(schema.licenseEvents).values({
      licenseId: currentLicense.id,
      event: "device.session_resumed",
      actor: "desktop",
      detail: { deviceId: claims.deviceId, appVersion: input.appVersion },
    });
    return currentLicense;
  });

  return {
    valid: true,
    token: await signDesktopToken(claims),
    license: publicLicense(license, leaseExpiresAt),
  };
}

export async function releaseDesktopSession(token: string) {
  const claims = await verifyDesktopToken(token);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select id from licenses where id = ${claims.licenseId} for update`);
    const [lease] = await tx
      .select()
      .from(schema.deviceLeases)
      .where(eq(schema.deviceLeases.licenseId, claims.licenseId))
      .limit(1);
    if (
      !lease ||
      lease.sessionId !== claims.sessionId ||
      lease.deviceId !== claims.deviceId
    ) {
      return false;
    }
    await tx.delete(schema.deviceLeases).where(eq(schema.deviceLeases.licenseId, claims.licenseId));
    await tx
      .update(schema.licenses)
      .set({
        tokenVersion: sql`${schema.licenses.tokenVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(schema.licenses.id, claims.licenseId));
    await tx.insert(schema.licenseEvents).values({
      licenseId: claims.licenseId,
      event: "device.released",
      actor: "desktop",
      detail: { deviceId: claims.deviceId },
    });
    return true;
  });
}

export async function forceReleaseLicense(
  licenseId: string,
  actor: string,
  userId?: string,
) {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select id from licenses where id = ${licenseId} for update`);
    await tx.delete(schema.deviceLeases).where(eq(schema.deviceLeases.licenseId, licenseId));
    await tx
      .update(schema.licenses)
      .set({
        tokenVersion: sql`${schema.licenses.tokenVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(schema.licenses.id, licenseId));
    await tx.insert(schema.licenseEvents).values({
      licenseId,
      userId,
      event: "device.force_released",
      actor,
    });
  });
}
