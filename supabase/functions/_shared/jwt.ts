// ============================================================================
// Shared JWT helpers for Chrome Mirror Edge Functions.
// Tokens are HMAC-SHA256 signed with the project's JWT_SECRET (Supabase sets
// this automatically for every function as JWT_SECRET).
//
// Token payload: { lid: licenseId, did: deviceId, iat, exp }
// ===========================================================================

const enc = new TextEncoder();

function b64urlEncode(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}

function strToBuf(s) {
  return enc.encode(s);
}

async function hmacKey(secret) {
  return await crypto.subtle.importKey(
    'raw',
    strToBuf(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

export const TOKEN_TTL_SEC = 60 * 60; // 1 hour

// ---------------------------------------------------------------------------
export async function signToken(payload, secret, ttlSec = TOKEN_TTL_SEC) {
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + ttlSec };
  const header = { alg: 'HS256', typ: 'JWT' };

  const headerB = b64urlEncode(strToBuf(JSON.stringify(header)));
  const bodyB = b64urlEncode(strToBuf(JSON.stringify(body)));
  const signingInput = `${headerB}.${bodyB}`;

  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, strToBuf(signingInput)));

  return `${signingInput}.${b64urlEncode(sig)}`;
}

// ---------------------------------------------------------------------------
export async function verifyToken(token, secret) {
  if (!token || typeof token !== 'string') throw new Error('missing token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed token');

  const signingInput = `${parts[0]}.${parts[1]}`;
  const key = await hmacKey(secret);

  const ok = await crypto.subtle.verify(
    'HMAC',
    key,
    b64urlDecode(parts[2]),
    strToBuf(signingInput)
  );
  if (!ok) throw new Error('invalid signature');

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
  } catch {
    throw new Error('malformed payload');
  }

  if (typeof payload.exp !== 'number' || Math.floor(Date.now() / 1000) >= payload.exp) {
    throw new Error('token expired');
  }
  if (!payload.lid || !payload.did) throw new Error('token missing claims');
  return payload;
}
