import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  decryptLicenseKey,
  encryptLicenseKey,
  generateLicenseKey,
  licenseKeyHash,
  verifyNowPaymentsSignature,
} from "@/lib/crypto";

describe("license key protection", () => {
  it("encrypts and decrypts a generated key with AES-GCM", () => {
    const key = generateLicenseKey();
    const encrypted = encryptLicenseKey(key);
    expect(decryptLicenseKey({
      keyCiphertext: encrypted.ciphertext,
      keyIv: encrypted.iv,
      keyTag: encrypted.tag,
    })).toBe(key);
  });

  it("hashes equivalent formatted keys to the same lookup value", () => {
    expect(licenseKeyHash("CMIR-ABCD-EFGH-JKLM-NPQR"))
      .toBe(licenseKeyHash("cmir abcdefghjklmnpqr"));
  });
});

describe("NOWPayments signature verification", () => {
  it("sorts nested payload keys before HMAC SHA-512 verification", () => {
    const payload = { payment_status: "finished", nested: { z: 1, a: 2 }, order_id: "cm_1" };
    const signature = createHmac("sha512", process.env.NOWPAYMENTS_IPN_SECRET!)
      .update(JSON.stringify(canonicalJson(payload)))
      .digest("hex");
    expect(verifyNowPaymentsSignature(payload, signature)).toBe(true);
    expect(verifyNowPaymentsSignature({ ...payload, order_id: "cm_2" }, signature)).toBe(false);
  });
});
