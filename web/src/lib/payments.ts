import "server-only";

import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { env } from "@/lib/env";
import { grantPlan, type GrantPlan } from "@/lib/license-service";
import { ApiError } from "@/lib/utils";

const PLAN_PRICE_CENTS: Record<GrantPlan, number> = {
  annual: 2000,
  lifetime: 3000,
};

type NowPaymentsInvoice = {
  id?: string | number;
  invoice_url?: string;
};

export function planPriceCents(plan: GrantPlan) {
  return PLAN_PRICE_CENTS[plan];
}

export function shouldApplyPaymentGrant(status: string, grantAppliedAt: Date | null) {
  return status.toLowerCase() === "finished" && !grantAppliedAt;
}

export function paymentAmountMatches(
  payload: Record<string, unknown>,
  expectedUsdCents: number,
) {
  const callbackUsd = Number(payload.price_amount);
  return (
    String(payload.price_currency || "").toLowerCase() === "usd" &&
    Number.isFinite(callbackUsd) &&
    Math.abs(callbackUsd - expectedUsdCents / 100) <= 0.001
  );
}

export async function createHostedInvoice(userId: string, plan: GrantPlan) {
  if (!env.NOWPAYMENTS_API_KEY) {
    throw new ApiError(
      "PAYMENTS_NOT_CONFIGURED",
      "Checkout is not configured yet. Contact the administrator for an access code.",
      503,
    );
  }

  const id = randomUUID();
  const orderId = `cm_${id}`;
  const amountUsdCents = planPriceCents(plan);
  await db.insert(schema.payments).values({
    id,
    orderId,
    userId,
    plan,
    amountUsdCents,
    status: "creating",
  });

  const callbackBase = env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
  try {
    const response = await fetch(`${env.NOWPAYMENTS_API_URL.replace(/\/$/, "")}/invoice`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.NOWPAYMENTS_API_KEY,
      },
      body: JSON.stringify({
        price_amount: amountUsdCents / 100,
        price_currency: "usd",
        order_id: orderId,
        order_description:
          plan === "lifetime"
            ? "Chrome Mirror lifetime hosted access"
            : "Chrome Mirror annual hosted access",
        ipn_callback_url: `${callbackBase}/api/payments/nowpayments/ipn`,
        success_url: `${callbackBase}/dashboard?checkout=success`,
        cancel_url: `${callbackBase}/dashboard?checkout=cancelled`,
      }),
      cache: "no-store",
    });
    const payload = (await response.json().catch(() => ({}))) as NowPaymentsInvoice & {
      message?: string;
    };
    if (!response.ok || !payload.id || !payload.invoice_url) {
      throw new Error(payload.message || `NOWPayments returned ${response.status}.`);
    }

    await db
      .update(schema.payments)
      .set({
        providerInvoiceId: String(payload.id),
        invoiceUrl: payload.invoice_url,
        status: "waiting",
        raw: payload,
        updatedAt: new Date(),
      })
      .where(eq(schema.payments.id, id));
    return { paymentId: id, invoiceUrl: payload.invoice_url };
  } catch (error) {
    await db
      .update(schema.payments)
      .set({
        status: "failed",
        raw: { error: error instanceof Error ? error.message : String(error) },
        updatedAt: new Date(),
      })
      .where(eq(schema.payments.id, id));
    throw new ApiError("PAYMENT_PROVIDER_ERROR", "Unable to create checkout right now.", 502);
  }
}

export async function processPaymentUpdate(payload: Record<string, unknown>) {
  const orderId = String(payload.order_id || "");
  const providerStatus = String(payload.payment_status || "").toLowerCase();
  if (!orderId || !providerStatus) {
    throw new ApiError("INVALID_CALLBACK", "Payment callback is missing required fields.", 400);
  }

  return db.transaction(async (tx) => {
    await tx.execute(sql`select id from payments where order_id = ${orderId} for update`);
    const [payment] = await tx
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.orderId, orderId))
      .limit(1);
    if (!payment) throw new ApiError("PAYMENT_NOT_FOUND", "Payment order was not found.", 404);

    const providerPaymentId = payload.payment_id ? String(payload.payment_id) : null;
    const payAmount =
      payload.pay_amount === null || payload.pay_amount === undefined
        ? null
        : String(payload.pay_amount);
    const payCurrency = payload.pay_currency ? String(payload.pay_currency) : null;
    const now = new Date();

    await tx
      .update(schema.payments)
      .set({
        providerPaymentId: providerPaymentId ?? payment.providerPaymentId,
        status: providerStatus,
        payCurrency,
        payAmount,
        raw: payload,
        updatedAt: now,
        finishedAt: providerStatus === "finished" ? payment.finishedAt ?? now : payment.finishedAt,
      })
      .where(eq(schema.payments.id, payment.id));

    if (!shouldApplyPaymentGrant(providerStatus, payment.grantAppliedAt)) {
      return { granted: false, duplicate: Boolean(payment.grantAppliedAt) };
    }

    if (!paymentAmountMatches(payload, payment.amountUsdCents)) {
      throw new ApiError("PAYMENT_AMOUNT_MISMATCH", "Payment amount does not match the order.", 400);
    }

    await grantPlan(tx, {
      userId: payment.userId,
      plan: payment.plan as GrantPlan,
      actor: "nowpayments",
      source: "payment",
      detail: {
        paymentId: payment.id,
        providerPaymentId,
        orderId,
      },
    });
    await tx
      .update(schema.payments)
      .set({ grantAppliedAt: now, finishedAt: payment.finishedAt ?? now, updatedAt: now })
      .where(eq(schema.payments.id, payment.id));
    return { granted: true, duplicate: false };
  });
}

export async function reconcilePayment(paymentId: string) {
  const [payment] = await db
    .select()
    .from(schema.payments)
    .where(eq(schema.payments.id, paymentId))
    .limit(1);
  if (!payment) throw new ApiError("PAYMENT_NOT_FOUND", "Payment was not found.", 404);
  if (!payment.providerPaymentId) {
    throw new ApiError(
      "PAYMENT_PENDING",
      "The provider has not assigned a payment ID yet.",
      409,
    );
  }
  if (!env.NOWPAYMENTS_API_KEY) {
    throw new ApiError("PAYMENTS_NOT_CONFIGURED", "NOWPayments is not configured.", 503);
  }

  const response = await fetch(
    `${env.NOWPAYMENTS_API_URL.replace(/\/$/, "")}/payment/${payment.providerPaymentId}`,
    {
      headers: { "x-api-key": env.NOWPAYMENTS_API_KEY },
      cache: "no-store",
    },
  );
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new ApiError("PAYMENT_PROVIDER_ERROR", "Unable to reconcile this payment.", 502);
  }
  if (!payload.order_id) payload.order_id = payment.orderId;
  return processPaymentUpdate(payload);
}
