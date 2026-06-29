// ============================================================================
// Edge Function: verify
// Body: { token }
// Returns the fresh token + license info if still valid; rejects otherwise.
// Used by the app at boot and on each heartbeat.
// ============================================================================
import { verifyToken, signToken, TOKEN_TTL_SEC } from '../_shared/jwt.ts';
import { json, supabase, JWT_SECRET, corsHeaders } from '../_shared/cors.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  let body;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }

  const { token } = body || {};
  if (!token) return json({ error: 'token required' }, 400);

  try {
    let claims;
    try {
      claims = await verifyToken(token, JWT_SECRET());
    } catch (e) {
      return json({ valid: false, error: e.message, code: 'BAD_TOKEN' }, 401);
    }

    // Load the license by id (claims.lid) and verify the device + status.
    const rows = await supabase('GET', `/licenses`, {
      query: {
        id: `eq.${claims.lid}`,
        select: 'id,license_key,label,status,bound_device_id,expires_at',
        limit: '1',
      },
    });
    const lic = Array.isArray(rows) && rows[0];
    if (!lic) return json({ valid: false, error: 'license not found', code: 'NOT_FOUND' }, 404);

    if (lic.bound_device_id !== claims.did) {
      return json({ valid: false, error: 'device mismatch', code: 'DEVICE_MISMATCH' }, 403);
    }
    if (lic.status === 'suspended')  return json({ valid: false, error: 'license suspended',  code: 'SUSPENDED'  }, 403);
    if (lic.status === 'cancelled')  return json({ valid: false, error: 'license cancelled',  code: 'CANCELLED'  }, 403);
    if (lic.expires_at && new Date(lic.expires_at) < new Date()) {
      return json({ valid: false, error: 'license expired', code: 'EXPIRED' }, 403);
    }

    // Rotate the token (fresh exp) so a continuously-running app keeps a valid
    // token as long as the license stays in good standing.
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
    console.error('verify error', e);
    return json({ valid: false, error: 'server error', code: 'SERVER_ERROR' }, 500);
  }
});
