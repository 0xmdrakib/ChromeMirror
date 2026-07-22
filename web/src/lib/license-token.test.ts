import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { env } from "@/lib/env";
import { verifyDesktopResumeToken, verifyDesktopToken } from "@/lib/license-token";

async function expiredDesktopToken() {
  const key = new TextEncoder().encode(env.LICENSE_JWT_SECRET);
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    sid: "session-one",
    did: "0123456789abcdef0123456789abcdef",
    ver: 7,
    typ: "desktop",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("license-one")
    .setIssuer("chrome-mirror")
    .setAudience("chrome-mirror-desktop")
    .setIssuedAt(now - 1200)
    .setExpirationTime(now - 600)
    .sign(key);
}

describe("desktop activation resume tokens", () => {
  it("rejects an expired token as an access token but accepts it for same-session resume", async () => {
    const token = await expiredDesktopToken();
    await expect(verifyDesktopToken(token)).rejects.toMatchObject({ code: "BAD_TOKEN" });
    await expect(verifyDesktopResumeToken(token)).resolves.toEqual({
      licenseId: "license-one",
      sessionId: "session-one",
      deviceId: "0123456789abcdef0123456789abcdef",
      tokenVersion: 7,
    });
  });

  it("still rejects a tampered resume token", async () => {
    const token = await expiredDesktopToken();
    const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
    await expect(verifyDesktopResumeToken(tampered)).rejects.toMatchObject({ code: "BAD_TOKEN" });
  });
});
