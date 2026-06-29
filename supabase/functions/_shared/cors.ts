// Shared helpers for talking to the Supabase REST API (PostgREST) from inside
// Edge Functions, using the service_role key so RLS is bypassed.

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

export function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders, ...extraHeaders },
  });
}

// ---------------------------------------------------------------------------
// Thin fetch wrapper around PostgREST. Uses the SERVICE ROLE key passed in the
// request `apikey` header by the app — but here we always inject it explicitly
// from env, so the client cannot impersonate.
// ---------------------------------------------------------------------------
export async function supabase(method, path, { body, query } = {}) {
  const baseUrl = SUPABASE_URL().replace(/\/$/, '');
  const url = new URL(`${baseUrl}/rest/v1${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  }

  const headers = {
    apikey: SERVICE_KEY(),
    Authorization: `Bearer ${SERVICE_KEY()}`,
    'Content-Type': 'application/json',
    Prefer: method === 'POST' ? 'return=representation' : 'return=representation',
  };

  const res = await fetch(url.toString(), {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (!res.ok) {
    throw Object.assign(new Error(`supabase ${method} ${path} -> ${res.status}`), {
      status: res.status,
      data,
    });
  }
  return data;
}

// ---------------------------------------------------------------------------
export function SUPABASE_URL() {
  const u = Deno.env.get('SUPABASE_URL');
  if (!u) throw new Error('SUPABASE_URL not configured');
  return u;
}

export function SERVICE_KEY() {
  const k = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!k) throw new Error('SUPABASE_SERVICE_ROLE_KEY not configured');
  return k;
}

export function JWT_SECRET() {
  const s = Deno.env.get('JWT_SECRET');
  if (!s) throw new Error('JWT_SECRET not configured');
  return s;
}

// Client-IP extraction (best effort) for audit logging.
export function clientIp(req) {
  return (
    req.headers.get('x-real-ip') ||
    req.headers.get('cf-connecting-ip') ||
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    null
  );
}
