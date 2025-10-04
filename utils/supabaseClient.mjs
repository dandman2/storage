import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error('Supabase credentials are not set');
}
if (/\bstorage\.supabase\.co\b/.test(SUPABASE_URL) || /\/storage\/v1\b/.test(SUPABASE_URL)) {
  throw new Error(
    `Invalid SUPABASE_URL: ${SUPABASE_URL}\n` +
    `Use the project base URL (e.g., https://<ref>.supabase.co), not the storage subdomain or /storage/v1.`
  );
}

/**
 * Fetch with error logging (safe: uses res.clone()).
 */
const fetchWithLogging = async (input, init) => {
  const method =
    (init && init.method) ||
    (typeof input === 'object' && input?.method) ||
    'GET';
  const url =
    (typeof input === 'string' && input) ||
    (typeof input === 'object' && input?.url) ||
    String(input);

  const res = await fetch(input, init);
  if (!res.ok) {
    try {
      const headers = Object.fromEntries(res.headers.entries());
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      const resClone = res.clone();

      console.error('Supabase request failed', { method, url, status: res.status, headers });

      if (ct.includes('application/json') || ct.includes('text/') || ct.includes('xml')) {
        let bodyText = '';
        try { bodyText = await resClone.text(); } catch {}
        if (bodyText) {
          const max = 4000;
          if (bodyText.length > max) bodyText = bodyText.slice(0, max) + '…[truncated]';
          console.error('Supabase error body:', bodyText);
        }
      }
    } catch (e) {
      console.error('Failed to log Supabase error response', e);
    }
  }
  return res;
};

export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  global: {
    fetch: fetchWithLogging,
    headers: { Accept: 'application/json' },
  },
});

export default supabase;
