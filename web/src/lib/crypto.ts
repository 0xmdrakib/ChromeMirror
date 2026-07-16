import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { env } from "@/lib/env";

const LICENSE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function canonicalToken(value: string) {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function encryptionKey() {
  const raw = env.LICENSE_KEY_ENCRYPTION_KEY.trim();
  const decoded = /^[0-9a-f]{64}$/i.test(raw)
    ? Buffer.from(raw, "hex")
    : Buffer.from(raw, "base64");
  if (decoded.length !== 32) {
    throw new Error("LICENSE_KEY_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  }
  return decoded;
}

function randomGroup(length = 4) {
  const bytes = randomBytes(length);
  return Array.from(bytes, (byte) => LICENSE_ALPHABET[byte % LICENSE_ALPHABET.length]).join("");
}

export function generateLicenseKey() {
  return `CMIR-${randomGroup()}-${randomGroup()}-${randomGroup()}-${randomGroup()}`;
}

export function licenseKeyHash(value: string) {
  return createHash("sha256").update(canonicalToken(value)).digest("hex");
}

export function encryptLicenseKey(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptLicenseKey(input: {
  keyCiphertext: string;
  keyIv: string;
  keyTag: string;
}) {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(input.keyIv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(input.keyTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(input.keyCiphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export function maskLicenseKey(value: string) {
  const groups = value.split("-");
  if (groups.length < 3) return `••••-${value.slice(-4)}`;
  return `${groups[0]}-••••-••••-••••-${groups.at(-1)}`;
}

export function generateRedeemCode(plan: "annual" | "lifetime") {
  const prefix = plan === "lifetime" ? "LIFE" : "YEAR";
  return `CMRD-${prefix}-${randomGroup()}-${randomGroup()}-${randomGroup()}`;
}

export function redeemCodeHash(value: string) {
  return createHmac("sha256", env.REDEEM_CODE_PEPPER)
    .update(canonicalToken(value))
    .digest("hex");
}

export function secureHexEqual(left: string, right: string) {
  try {
    const a = Buffer.from(left, "hex");
    const b = Buffer.from(right, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((result, key) => {
        result[key] = canonicalJson((value as Record<string, unknown>)[key]);
        return result;
      }, {});
  }
  return value;
}

export function verifyNowPaymentsSignature(payload: unknown, signature: string | null) {
  if (!signature || !env.NOWPAYMENTS_IPN_SECRET) return false;
  const expected = createHmac("sha512", env.NOWPAYMENTS_IPN_SECRET)
    .update(JSON.stringify(canonicalJson(payload)))
    .digest("hex");
  return secureHexEqual(expected, signature);
}
