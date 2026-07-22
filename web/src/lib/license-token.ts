import "server-only";

import { SignJWT, compactVerify, jwtVerify } from "jose";
import { env } from "@/lib/env";
import { ApiError } from "@/lib/utils";

const key = new TextEncoder().encode(env.LICENSE_JWT_SECRET);
const issuer = "chrome-mirror";
const audience = "chrome-mirror-desktop";

export type DesktopClaims = {
  licenseId: string;
  sessionId: string;
  deviceId: string;
  tokenVersion: number;
};

export async function signDesktopToken(claims: DesktopClaims) {
  return new SignJWT({
    sid: claims.sessionId,
    did: claims.deviceId,
    ver: claims.tokenVersion,
    typ: "desktop",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.licenseId)
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(key);
}

export async function verifyDesktopToken(token: string): Promise<DesktopClaims> {
  try {
    const { payload } = await jwtVerify(token, key, { issuer, audience });
    if (
      payload.typ !== "desktop" ||
      !payload.sub ||
      typeof payload.sid !== "string" ||
      typeof payload.did !== "string" ||
      typeof payload.ver !== "number"
    ) {
      throw new Error("Malformed token");
    }
    return {
      licenseId: payload.sub,
      sessionId: payload.sid,
      deviceId: payload.did,
      tokenVersion: payload.ver,
    };
  } catch {
    throw new ApiError("BAD_TOKEN", "Activation session is invalid or expired.", 401);
  }
}

export async function verifyDesktopResumeToken(token: string): Promise<DesktopClaims> {
  try {
    // Resume credentials are still signature-, issuer-, audience- and
    // server-session-checked; only the short access-token exp is ignored.
    const { payload: bytes, protectedHeader } = await compactVerify(token, key);
    if (protectedHeader.alg !== "HS256") throw new Error("Unexpected algorithm");
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    const tokenAudience = payload.aud;
    const audienceMatches = tokenAudience === audience
      || (Array.isArray(tokenAudience) && tokenAudience.includes(audience));
    if (
      payload.iss !== issuer
      || !audienceMatches
      || payload.typ !== "desktop"
      || typeof payload.sub !== "string"
      || typeof payload.sid !== "string"
      || typeof payload.did !== "string"
      || typeof payload.ver !== "number"
    ) {
      throw new Error("Malformed token");
    }
    return {
      licenseId: payload.sub,
      sessionId: payload.sid,
      deviceId: payload.did,
      tokenVersion: payload.ver,
    };
  } catch {
    throw new ApiError("BAD_TOKEN", "Activation session is invalid.", 401);
  }
}
