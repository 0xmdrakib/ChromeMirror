import { describe, expect, it } from "vitest";
import {
  canReconcilePayment,
  paymentAmountMatches,
  paymentCurrencyMatches,
  paymentReceivedAmountCovers,
  shouldApplyPaymentGrant,
  stablecoinOptions,
} from "@/lib/payments";

describe("payment grant rules", () => {
  it("grants only on the final finished status", () => {
    expect(shouldApplyPaymentGrant("waiting", null)).toBe(false);
    expect(shouldApplyPaymentGrant("partially_paid", null)).toBe(false);
    expect(shouldApplyPaymentGrant("failed", null)).toBe(false);
    expect(shouldApplyPaymentGrant("finished", null)).toBe(true);
  });

  it("treats duplicate finished callbacks as idempotent", () => {
    expect(shouldApplyPaymentGrant("finished", new Date())).toBe(false);
  });

  it("allows an ungranted finished payment to recover through reconciliation", () => {
    expect(canReconcilePayment("finished", null)).toBe(true);
    expect(canReconcilePayment("finished", new Date())).toBe(false);
    expect(canReconcilePayment("expired", null)).toBe(false);
    expect(canReconcilePayment("waiting", null)).toBe(true);
  });

  it("rejects a mismatched currency or order amount", () => {
    expect(paymentAmountMatches({ price_currency: "usd", price_amount: 20 }, 2000)).toBe(true);
    expect(paymentAmountMatches({ price_currency: "usd", price_amount: 19 }, 2000)).toBe(false);
    expect(paymentAmountMatches({ price_currency: "eur", price_amount: 20 }, 2000)).toBe(false);
  });

  it("requires the selected crypto ticker to match exactly", () => {
    expect(paymentCurrencyMatches({ pay_currency: "USDTTRC20" }, "usdttrc20")).toBe(true);
    expect(paymentCurrencyMatches({ pay_currency: "usdterc20" }, "usdttrc20")).toBe(false);
    expect(paymentCurrencyMatches({ pay_currency: "usdttrc20" }, null)).toBe(false);
  });

  it("requires an explicit fully paid final amount", () => {
    expect(paymentReceivedAmountCovers({ actually_paid: "20" }, "20")).toBe(true);
    expect(paymentReceivedAmountCovers({ actually_paid: "19.99" }, "20")).toBe(false);
    expect(paymentReceivedAmountCovers({}, "20")).toBe(false);
    expect(paymentReceivedAmountCovers({}, null)).toBe(false);
  });

  it("filters and labels only USDT and USDC networks", () => {
    expect(stablecoinOptions([
      "btc",
      "usdttrc20",
      "usdterc20",
      { code: "usdcmatic", network: "Polygon" },
      "usdcsol",
    ])).toEqual([
      { code: "usdcmatic", asset: "USDC", network: "Polygon", label: "USDC - Polygon" },
      { code: "usdcsol", asset: "USDC", network: "Solana", label: "USDC - Solana" },
      { code: "usdterc20", asset: "USDT", network: "Ethereum (ERC-20)", label: "USDT - Ethereum (ERC-20)" },
      { code: "usdttrc20", asset: "USDT", network: "Tron (TRC-20)", label: "USDT - Tron (TRC-20)" },
    ]);
  });
});
