// ============================================================================
// Edge Function: activate
// Body: { license_key, device_id, machine_info? }
//
// Validates the license, binds it to the device (if not already bound), and
// returns a signed JWT activation token + license info. Idempotent: activating
// the same key on the same device multiple times succeeds.
// ============================================================================
import { signToken, TOKEN_TTL_SEC } from '../_shared/jwt.ts';
import { json, supabase, JWT_SECRET, clientIp, corsHeaders } from '../_shared/cors.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  let body;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }

  const { license_key, device_id, machine_info } = body || {};
  if (!license_key || typeof license_key !== 'string') return json({ error: 'license_key required' }, 400);
  if (!device_id || typeof device_id !== 'string') return json({ error: 'device_id required' }, 400);

  try {
    // --- 1. Load the license row (by exact key) ---------------------------
    const rows = await supabase('GET', `/licenses`, {
      query: {
        license_key: `eq.${license_key}`,
        select: 'id,license_key,label,status,bound_device_id,max_devices,expires_at,created_at',
        limit: '1',
      },
    });
    const lic = Array.isArray(rows) && rows[0];
    if (!lic) return json({ error: 'invalid license key', code: 'INVALID_KEY' }, 404);

    const nowIso = new Date().toISOString();

    // --- 2. Status checks -------------------------------------------------
    if (lic.status === 'suspended') return json({ error: 'this license is suspended', code: 'SUSPENDED' }, 403);
    if (lic.status === 'cancelled') return json({ error: 'this license has been cancelled', code: 'CANCELLED' }, 403);
    if (lic.expires_at && new Date(lic.expires_at) < new Date()) {
      return json({ error: 'this license has expired', code: 'EXPIRED' }, 403);
    }

    // --- 3. Device-binding logic -----------------------------------------
    if (lic.bound_device_id && lic.bound_device_id !== device_id) {
      // Already bound to ANOTHER device.
      return json({
        error: 'this license is already activated on another device',
        code: 'DEVICE_MISMATCH',
      }, 403);
    }

    // Bind it (first time) or re-affirm the existing binding.
    const patch = lic.bound_device_id
      ? { status: 'active' }
      : { bound_device_id: device_id, bound_at: nowIso, status: 'active' };

    const updated = await supabase('PATCH', `/licenses?id=eq.${lic.id}`, { body: patch });
    const newLic = Array.isArray(updated) && updated[0] ? updated[0] : lic;

    // --- 4. Record device + heartbeat seed -------------------------------
    await supabase('POST', '/devices', {
      body: {
        license_id: lic.id,
        device_id,
        machine_info: machine_info || null,
        last_seen_at: nowIso,
      },
      // upsert via PostgREST prefer header would be cleaner, but we tolerate dup
    }).catch(() => {});

    // If device row already exists, update its last_seen + info instead.
    await supabase('PATCH', `/devices?license_id=eq.${lic.id}&device_id=eq.${device_id}`, {
      body: { last_seen_at: nowIso, machine_info: machine_info || null },
    }).catch(() => {});

    // Audit
    await supabase('POST', '/license_events', {
      body: {
        license_id: lic.id,
        event: 'activated',
        actor: 'device',
        detail: { device_id, machine_info: machine_info || null, ip: clientIp(req) },
      },
    }).catch(() => {});

    // --- 5. Issue JWT -----------------------------------------------------
    const token = await signToken({ lid: lic.id, did: device_id }, JWT_SECRET(), TOKEN_TTL_SEC);

    return json({
      ok: true,
      token,
      expires_in: TOKEN_TTL_SEC,
      license: {
        license_key: newLic.license_key,
        label: newLic.label,
        status: newLic.status,
        expires_at: newLic.expires_at,
      },
    });
  } catch (e) {
    console.error('activate error', e);
    return json({ error: 'server error', code: 'SERVER_ERROR' }, 500);
  }
});
