// ============================================================================
// Edge Function: heartbeat
// Body: { token, app_version? }
// Verifies the token, updates the heartbeat row (online status), rotates token.
// If the license was suspended/cancelled since the last heartbeat, returns 403
// so the app can lock itself.
// ============================================================================
import { verifyToken, signToken, TOKEN_TTL_SEC } from '../_shared/jwt.ts';
import { json, supabase, JWT_SECRET, clientIp, corsHeaders } from '../_shared/cors.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  let body;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }

  const { token, app_version } = body || {};
  if (!token) return json({ error: 'token required' }, 400);

  try {
    let claims;
    try {
      claims = await verifyToken(token, JWT_SECRET());
    } catch (e) {
      return json({ valid: false, error: e.message, code: 'BAD_TOKEN' }, 401);
    }

    const rows = await supabase('GET', `/licenses`, {
      query: {
        id: `eq.${claims.lid}`,
        select: 'id,license_key,label,status,bound_device_id,expires_at',
        limit: '1',
      },
    });
    const lic = Array.isArray(rows) && rows[0];
    if (!lic) return json({ valid: false, error: 'license not found', code: 'NOT_FOUND' }, 404);

    // License revoked? → tell the app to lock.
    if (lic.status === 'suspended')  return json({ valid: false, error: 'license suspended',  code: 'SUSPENDED'  }, 403);
    if (lic.status === 'cancelled')  return json({ valid: false, error: 'license cancelled',  code: 'CANCELLED'  }, 403);
    if (lic.bound_device_id !== claims.did) return json({ valid: false, error: 'device mismatch', code: 'DEVICE_MISMATCH' }, 403);
    if (lic.expires_at && new Date(lic.expires_at) < new Date()) {
      return json({ valid: false, error: 'license expired', code: 'EXPIRED' }, 403);
    }

    const nowIso = new Date().toISOString();
    const ip = clientIp(req);

    // Upsert heartbeat (primary key = license_id + device_id).
    await supabase('POST', '/heartbeats', {
      body: {
        license_id: lic.id,
        device_id: claims.did,
        last_heartbeat_at: nowIso,
        app_version: app_version || null,
        ip: ip || null,
      },
    }).catch(async () => {
      // row exists → patch it
      await supabase('PATCH', `/heartbeats?license_id=eq.${lic.id}&device_id=eq.${claims.did}`, {
        body: { last_heartbeat_at: nowIso, app_version: app_version || null, ip: ip || null },
      }).catch(() => {});
    });

    const fresh = await signToken({ lid: lic.id, did: claims.did }, JWT_SECRET(), TOKEN_TTL_SEC);
    return json({
      valid: true,
      token: fresh,
      expires_in: TOKEN_TTL_SEC,
      license: {
        license_key: lic.license_key,
        label: lic.label,
        status: lic.status,
        expires_at: lic.expires_at,
      },
    });
  } catch (e) {
    console.error('heartbeat error', e);
    return json({ valid: false, error: 'server error', code: 'SERVER_ERROR' }, 500);
  }
});
