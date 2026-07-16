import { describe, expect, it } from "vitest";
import { calculateGrantTerm } from "@/lib/license-service";

describe("license term grants", () => {
  const now = new Date("2026-07-16T00:00:00.000Z");

  it("starts an annual grant from today when the old term is expired", () => {
    const result = calculateGrantTerm({
      currentPlan: "annual",
      currentExpiry: new Date("2026-07-01T00:00:00.000Z"),
      grantPlan: "annual",
      now,
    });
    expect(result.plan).toBe("annual");
    expect(result.expiresAt?.toISOString()).toBe("2027-07-16T00:00:00.000Z");
  });

  it("extends an active annual grant from its current expiry", () => {
    const result = calculateGrantTerm({
      currentPlan: "annual",
      currentExpiry: new Date("2026-08-01T00:00:00.000Z"),
      grantPlan: "annual",
      now,
    });
    expect(result.expiresAt?.toISOString()).toBe("2027-08-01T00:00:00.000Z");
  });

  it("makes lifetime dominant over later annual grants", () => {
    expect(calculateGrantTerm({
      currentPlan: "lifetime",
      currentExpiry: null,
      grantPlan: "annual",
      now,
    })).toEqual({ plan: "lifetime", expiresAt: null });
  });
});
