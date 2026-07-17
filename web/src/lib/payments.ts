import "server-only";

import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { env } from "@/lib/env";
import { grantPlan, type GrantPlan } from "@/lib/license-service";
import { ApiError } from "@/lib/utils";

const PLAN_PRICE_CENTS: Record<GrantPlan, number> = {
  annual: 2000,
  lifetime: 3000,
};
const TERMINAL_STATUSES = new Set([
  "finished",
  "partially_paid",
  "failed",
  "refunded",
  "expired",
  "cancelled",
  "canceled",
]);
const POLL_INTERVAL_MS = 5_000;
const PAYMENT_LIFETIME_MS = 20 * 60 * 1000;

type NowPaymentsCurrencyResponse = {
  currencies?: unknown[];
  selectedCurrencies?: unknown[];
};

type NowPaymentsPayment = Record<string, unknown> & {
  payment_id?: string | number;
  payment_status?: string;
  pay_address?: string;
  price_amount?: string | number;
  price_currency?: string;
  pay_amount?: string | number;
  pay_currency?: string;
  order_id?: string;
  network?: string;
  payin_extra_id?: string | null;
  expiration_estimate_date?: string;
  valid_until?: string;
  created_at?: string;
  message?: string;
};

export type StablecoinOption = {
  code: string;
  asset: "USDT" | "USDC";
  network: string;
  label: string;
};

export type EmbeddedPayment = {
  id: string;
  plan: string;
  amountUsdCents: number;
  status: string;
  payCurrency: string | null;
  payAmount: string | null;
  payAddress: string | null;
  payinExtraId: string | null;
  network: string | null;
  expiresAt: string | null;
  createdAt: string;
};

let currencyCache: { value: StablecoinOption[]; expiresAt: number } | null = null;

export function planPriceCents(plan: GrantPlan) {
  return PLAN_PRICE_CENTS[plan];
}

export function shouldApplyPaymentGrant(status: string, grantAppliedAt: Date | null) {
  return status.toLowerCase() === "finished" && !grantAppliedAt;
}

export function canReconcilePayment(status: string, grantAppliedAt: Date | null) {
  const normalized = status.toLowerCase();
  return !TERMINAL_STATUSES.has(normalized) || (normalized === "finished" && !grantAppliedAt);
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

export function paymentCurrencyMatches(payload: Record<string, unknown>, expected: string | null) {
  if (!expected) return false;
  return String(payload.pay_currency || "").toLowerCase() === expected.toLowerCase();
}

export function paymentReceivedAmountCovers(
  payload: Record<string, unknown>,
  expectedPayAmount: string | null,
) {
  if (!expectedPayAmount) return false;
  const expected = Number(expectedPayAmount);
  const received = Number(payload.actually_paid);
  if (!Number.isFinite(expected) || expected <= 0) return false;
  if (payload.actually_paid === null || payload.actually_paid === undefined) return false;
  return Number.isFinite(received) && received + Math.max(expected * 1e-8, 1e-12) >= expected;
}

function nowPaymentsUrl(path: string) {
  return `${env.NOWPAYMENTS_API_URL.replace(/\/$/, "")}${path}`;
}

function nowPaymentsHeaders() {
  if (!env.NOWPAYMENTS_API_KEY) {
    throw new ApiError(
      "PAYMENTS_NOT_CONFIGURED",
      "Checkout is not configured yet. Contact the administrator for an access code.",
      503,
    );
  }
  return { "Content-Type": "application/json", "x-api-key": env.NOWPAYMENTS_API_KEY };
}

function currencyCode(value: unknown) {
  if (typeof value === "string") return value.toLowerCase();
  if (!value || typeof value !== "object") return "";
  const item = value as Record<string, unknown>;
  return String(item.code || item.currency || item.ticker || "").toLowerCase();
}

function currencyNetwork(value: unknown, code: string) {
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    const explicit = String(item.network || item.network_name || item.chain || "").trim();
    if (explicit) return explicit;
  }
  const suffix = code.replace(/^usdt|^usdc/, "");
  const known: Record<string, string> = {
    erc20: "Ethereum (ERC-20)",
    trc20: "Tron (TRC-20)",
    bsc: "BNB Smart Chain (BEP-20)",
    bep20: "BNB Smart Chain (BEP-20)",
    matic: "Polygon",
    polygon: "Polygon",
    arb: "Arbitrum",
    arbitrum: "Arbitrum",
    op: "Optimism",
    optimism: "Optimism",
    sol: "Solana",
    solana: "Solana",
    avaxc: "Avalanche C-Chain",
    algo: "Algorand",
    ton: "TON",
  };
  return known[suffix] || (suffix ? suffix.toUpperCase() : "Native network");
}

export function stablecoinOptions(values: unknown[]) {
  const options = values.flatMap<StablecoinOption>((value) => {
    const code = currencyCode(value);
    const match = code.match(/^(usdt|usdc)/);
    if (!match) return [];
    const asset = match[1].toUpperCase() as "USDT" | "USDC";
    const network = currencyNetwork(value, code);
    return [{ code, asset, network, label: `${asset} - ${network}` }];
  });
  return Array.from(new Map(options.map((option) => [option.code, option])).values()).sort(
    (left, right) => left.asset.localeCompare(right.asset) || left.network.localeCompare(right.network),
  );
}

async function fetchCurrencyList(path: string) {
  try {
    const response = await fetch(nowPaymentsUrl(path), {
      headers: nowPaymentsHeaders(),
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return null;
    const payload = (await response.json().catch(() => ({}))) as NowPaymentsCurrencyResponse | unknown[];
    if (Array.isArray(payload)) return payload;
    return payload.selectedCurrencies || payload.currencies || [];
  } catch (error) {
    if (error instanceof ApiError) throw error;
    return null;
  }
}

export async function getStablecoinOptions() {
  if (currencyCache && currencyCache.expiresAt > Date.now()) return currencyCache.value;

  const [merchant, detailed] = await Promise.all([
    fetchCurrencyList("/merchant/coins"),
    fetchCurrencyList("/full-currencies"),
  ]);
  if (!merchant) {
    throw new ApiError(
      "PAYMENT_CURRENCIES_UNAVAILABLE",
      "Unable to load the merchant's enabled payment networks.",
      503,
    );
  }
  const detailByCode = new Map((detailed || []).map((item) => [currencyCode(item), item]));
  const source = merchant.map((item) => detailByCode.get(currencyCode(item)) || item);
  const options = stablecoinOptions(source);
  if (!options.length) {
    throw new ApiError(
      "PAYMENT_CURRENCIES_UNAVAILABLE",
      "No USDT or USDC networks are enabled for this merchant account.",
      503,
    );
  }
  currencyCache = { value: options, expiresAt: Date.now() + 5 * 60 * 1000 };
  return options;
}

function paymentExpiry(payload: NowPaymentsPayment) {
  const explicit = payload.expiration_estimate_date || payload.valid_until;
  const parsed = explicit ? new Date(explicit) : null;
  if (parsed && Number.isFinite(parsed.getTime())) return parsed;
  const created = payload.created_at ? new Date(payload.created_at) : new Date();
  return new Date(created.getTime() + PAYMENT_LIFETIME_MS);
}

function paymentIpnUrl() {
  return `${env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "")}/api/payments/nowpayments/ipn`;
}

export async function createEmbeddedPayment(
  userId: string,
  plan: GrantPlan,
  payCurrency: string,
) {
  const options = await getStablecoinOptions();
  const selected = options.find((option) => option.code === payCurrency.toLowerCase());
  if (!selected) {
    throw new ApiError("UNSUPPORTED_PAYMENT_CURRENCY", "Choose an available USDT or USDC network.", 400);
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
    payCurrency: selected.code,
    network: selected.network,
    status: "creating",
  });

  try {
    const response = await fetch(nowPaymentsUrl("/payment"), {
      method: "POST",
      headers: nowPaymentsHeaders(),
      body: JSON.stringify({
        price_amount: amountUsdCents / 100,
        price_currency: "usd",
        pay_currency: selected.code,
        order_id: orderId,
        order_description:
          plan === "lifetime"
            ? "Chrome Mirror lifetime hosted access"
            : "Chrome Mirror annual hosted access",
        ipn_callback_url: paymentIpnUrl(),
        is_fixed_rate: true,
        is_fee_paid_by_user: false,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    const payload = (await response.json().catch(() => ({}))) as NowPaymentsPayment;
    if (!response.ok || !payload.payment_id || !payload.pay_address || !payload.pay_amount) {
      throw new Error(payload.message || `NOWPayments returned ${response.status}.`);
    }
    if (payload.order_id && payload.order_id !== orderId) {
      throw new Error("NOWPayments returned a mismatched order ID.");
    }
    if (!paymentAmountMatches(payload, amountUsdCents) || !paymentCurrencyMatches(payload, selected.code)) {
      throw new Error("NOWPayments returned mismatched payment details.");
    }

    const expiresAt = paymentExpiry(payload);
    await db
      .update(schema.payments)
      .set({
        providerPaymentId: String(payload.payment_id),
        status: String(payload.payment_status || "waiting").toLowerCase(),
        payCurrency: String(payload.pay_currency).toLowerCase(),
        payAmount: String(payload.pay_amount),
        payAddress: String(payload.pay_address),
        payinExtraId: payload.payin_extra_id ? String(payload.payin_extra_id) : null,
        network: payload.network ? String(payload.network) : selected.network,
        paymentExpiresAt: expiresAt,
        raw: payload,
        updatedAt: new Date(),
      })
      .where(eq(schema.payments.id, id));
    return paymentDto({
      id,
      plan,
      amountUsdCents,
      status: String(payload.payment_status || "waiting").toLowerCase(),
      payCurrency: String(payload.pay_currency).toLowerCase(),
      payAmount: String(payload.pay_amount),
      payAddress: String(payload.pay_address),
      payinExtraId: payload.payin_extra_id ? String(payload.payin_extra_id) : null,
      network: payload.network ? String(payload.network) : selected.network,
      paymentExpiresAt: expiresAt,
      createdAt: new Date(),
    });
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
    if (payment.providerPaymentId && providerPaymentId !== payment.providerPaymentId) {
      throw new ApiError("PAYMENT_ID_MISMATCH", "Payment ID does not match the order.", 400);
    }
    const payAmount = payload.pay_amount == null ? null : String(payload.pay_amount);
    const payCurrency = payload.pay_currency ? String(payload.pay_currency).toLowerCase() : null;
    const now = new Date();

    await tx
      .update(schema.payments)
      .set({
        providerPaymentId: providerPaymentId ?? payment.providerPaymentId,
        status: providerStatus,
        payCurrency: payCurrency ?? payment.payCurrency,
        payAmount: payAmount ?? payment.payAmount,
        payAddress: payload.pay_address ? String(payload.pay_address) : payment.payAddress,
        payinExtraId: payload.payin_extra_id ? String(payload.payin_extra_id) : payment.payinExtraId,
        network: payload.network ? String(payload.network) : payment.network,
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
    if (!paymentCurrencyMatches(payload, payment.payCurrency)) {
      throw new ApiError("PAYMENT_CURRENCY_MISMATCH", "Payment currency does not match the order.", 400);
    }
    if (!paymentReceivedAmountCovers(payload, payment.payAmount)) {
      throw new ApiError("PAYMENT_UNDERPAID", "The received crypto amount is below the order amount.", 400);
    }

    await grantPlan(tx, {
      userId: payment.userId,
      plan: payment.plan as GrantPlan,
      actor: "nowpayments",
      source: "payment",
      detail: { paymentId: payment.id, providerPaymentId, orderId },
    });
    await tx
      .update(schema.payments)
      .set({ grantAppliedAt: now, finishedAt: payment.finishedAt ?? now, updatedAt: now })
      .where(eq(schema.payments.id, payment.id));
    return { granted: true, duplicate: false };
  });
}

type PaymentRow = typeof schema.payments.$inferSelect;

function paymentDto(payment: Pick<PaymentRow,
  "id" | "plan" | "amountUsdCents" | "status" | "payCurrency" | "payAmount" |
  "payAddress" | "payinExtraId" | "network" | "paymentExpiresAt" | "createdAt"
>): EmbeddedPayment {
  return {
    id: payment.id,
    plan: payment.plan,
    amountUsdCents: payment.amountUsdCents,
    status: payment.status,
    payCurrency: payment.payCurrency,
    payAmount: payment.payAmount,
    payAddress: payment.payAddress,
    payinExtraId: payment.payinExtraId,
    network: payment.network,
    expiresAt: payment.paymentExpiresAt?.toISOString() || null,
    createdAt: payment.createdAt.toISOString(),
  };
}

async function findPayment(paymentId: string, userId?: string) {
  const where = userId
    ? and(eq(schema.payments.id, paymentId), eq(schema.payments.userId, userId))
    : eq(schema.payments.id, paymentId);
  const [payment] = await db.select().from(schema.payments).where(where).limit(1);
  if (!payment) throw new ApiError("PAYMENT_NOT_FOUND", "Payment was not found.", 404);
  return payment;
}

export async function reconcilePayment(
  paymentId: string,
  options: { userId?: string; force?: boolean } = {},
) {
  let payment = await findPayment(paymentId, options.userId);
  const recentlyPolled = payment.lastPolledAt && Date.now() - payment.lastPolledAt.getTime() < POLL_INTERVAL_MS;
  if (!canReconcilePayment(payment.status, payment.grantAppliedAt) || (recentlyPolled && !options.force)) {
    return { payment: paymentDto(payment), granted: false, duplicate: Boolean(payment.grantAppliedAt) };
  }
  if (!payment.providerPaymentId) {
    throw new ApiError("PAYMENT_PENDING", "The provider has not assigned a payment ID yet.", 409);
  }

  const response = await fetch(nowPaymentsUrl(`/payment/${encodeURIComponent(payment.providerPaymentId)}`), {
    headers: nowPaymentsHeaders(),
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
  const payload = (await response.json().catch(() => ({}))) as NowPaymentsPayment;
  if (!response.ok) {
    throw new ApiError("PAYMENT_PROVIDER_ERROR", "Unable to reconcile this payment.", 502);
  }
  if (payload.payment_id && String(payload.payment_id) !== payment.providerPaymentId) {
    throw new ApiError("PAYMENT_ID_MISMATCH", "The provider returned a different payment.", 502);
  }
  if (payload.order_id && payload.order_id !== payment.orderId) {
    throw new ApiError("PAYMENT_ORDER_MISMATCH", "The provider returned a different order.", 502);
  }
  payload.order_id = payment.orderId;
  await db
    .update(schema.payments)
    .set({ lastPolledAt: new Date() })
    .where(eq(schema.payments.id, payment.id));
  const result = await processPaymentUpdate(payload);
  payment = await findPayment(paymentId, options.userId);
  return { payment: paymentDto(payment), ...result };
}
