export async function onRequestGet(context) {
  const { request, env } = context;

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  if (!env.DASH_KEY || key !== env.DASH_KEY) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: corsHeaders,
    });
  }

  const days = Math.min(parseInt(url.searchParams.get('days') || '7', 10), 365);
  const since = Math.floor(Date.now() / 1000) - days * 86400;

  try {
    const [pv, co, pu] = await Promise.all([
      env.DB.prepare(
        `SELECT COUNT(*) AS n FROM event_log WHERE event_name = 'PageView' AND is_bot = 0 AND timestamp >= ?`
      ).bind(since).first(),
      env.DB.prepare(
        `SELECT COUNT(*) AS n FROM event_log WHERE event_name = 'InitiateCheckout' AND is_bot = 0 AND timestamp >= ?`
      ).bind(since).first(),
      env.DB.prepare(
        `SELECT COUNT(*) AS n FROM purchase_log WHERE created_at >= ?`
      ).bind(since).first(),
    ]);

    return new Response(JSON.stringify({
      pageviews: pv?.n || 0,
      checkouts: co?.n || 0,
      purchases: pu?.n || 0,
    }), { status: 200, headers: corsHeaders });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: corsHeaders,
    });
  }
}
