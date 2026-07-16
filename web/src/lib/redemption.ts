import "server-only";

import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import {
  generateRedeemCode,
  redeemCodeHash,
} from "@/lib/crypto";
import { grantPlan, type GrantPlan } from "@/lib/license-service";
import { ApiError } from "@/lib/utils";

export async function redeemCode(userId: string, value: string) {
  const hash = redeemCodeHash(value);
  const now = new Date();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select id from redeem_codes where code_hash = ${hash} for update`);
    const [code] = await tx
      .select()
      .from(schema.redeemCodes)
      .where(eq(schema.redeemCodes.codeHash, hash))
      .limit(1);
    if (!code) throw new ApiError("INVALID_CODE", "This access code is invalid.", 404);
    if (code.revokedAt) throw new ApiError("CODE_REVOKED", "This access code was revoked.", 409);
    if (code.expiresAt && code.expiresAt <= now) {
      throw new ApiError("CODE_EXPIRED", "This access code has expired.", 409);
    }
    if (code.redemptionCount >= code.maxRedemptions) {
      throw new ApiError("CODE_USED", "This access code has already been used.", 409);
    }

    const [priorUse] = await tx
      .select()
      .from(schema.redeemUses)
      .where(eq(schema.redeemUses.codeId, code.id))
      .limit(1);
    if (priorUse && code.maxRedemptions === 1) {
      throw new ApiError("CODE_USED", "This access code has already been used.", 409);
    }

    const grant = await grantPlan(tx, {
      userId,
      plan: code.plan as GrantPlan,
      actor: `user:${userId}`,
      source: "redeem_code",
      detail: { codeId: code.id, codePrefix: code.codePrefix },
    });
    await tx.insert(schema.redeemUses).values({
      codeId: code.id,
      userId,
      licenseId: grant.license.id,
    });
    await tx
      .update(schema.redeemCodes)
      .set({ redemptionCount: sql`${schema.redeemCodes.redemptionCount} + 1` })
      .where(eq(schema.redeemCodes.id, code.id));
    return grant.license;
  });
}

export async function generateRedeemCodes(input: {
  plan: GrantPlan;
  count: number;
  createdBy: string;
  expiresAt?: Date | null;
}) {
  const plainCodes = Array.from({ length: input.count }, () => generateRedeemCode(input.plan));
  await db.insert(schema.redeemCodes).values(
    plainCodes.map((code) => ({
      codeHash: redeemCodeHash(code),
      codePrefix: code.slice(0, 14),
      plan: input.plan,
      durationDays: input.plan === "annual" ? 365 : null,
      maxRedemptions: 1,
      expiresAt: input.expiresAt ?? null,
      createdBy: input.createdBy,
    })),
  );
  return plainCodes;
}
