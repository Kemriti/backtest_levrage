// Cloudflare Pages Function — served at /api/yahoo
// Proxies Yahoo Finance's chart API server-side (no CORS restriction between
// two servers) and re-emits the response with permissive CORS headers so the
// browser-side app can read it directly, with no localhost proxy required.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

export async function onRequestGet({ request }) {
  const { searchParams } = new URL(request.url);
  const ticker  = searchParams.get('ticker');
  const period1 = searchParams.get('period1');
  const period2 = searchParams.get('period2');

  if (!ticker || !period1 || !period2) {
    return new Response(JSON.stringify({ error: 'Missing ticker/period1/period2' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  }

  const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`
    + `?period1=${period1}&period2=${period2}&interval=1d&events=history&includeAdjustedClose=true`;

  try {
    const res  = await fetch(yahooUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const body = await res.text();
    return new Response(body, {
      status: res.status,
      headers: {
        'Content-Type': res.headers.get('content-type') || 'application/json',
        'Cache-Control': 'public, max-age=300',
        ...CORS_HEADERS,
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: CORS_HEADERS });
}
