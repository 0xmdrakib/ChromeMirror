import { describe, expect, it } from "vitest";
import {
  paymentAmountMatches,
  shouldApplyPaymentGrant,
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

  it("rejects a mismatched currency or order amount", () => {
    expect(paymentAmountMatches({ price_currency: "usd", price_amount: 20 }, 2000)).toBe(true);
    expect(paymentAmountMatches({ price_currency: "usd", price_amount: 19 }, 2000)).toBe(false);
    expect(paymentAmountMatches({ price_currency: "eur", price_amount: 20 }, 2000)).toBe(false);
  });
});
