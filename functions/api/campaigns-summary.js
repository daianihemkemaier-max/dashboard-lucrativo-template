// GET /api/campaigns-summary?key=...&days=30
//
// For the Campanhas page. Crosses three data sources:
//   - ad_spend    (Meta Marketing API sync): spend, impressions, clicks
//   - event_log   (own pixel tracking):      PageView, InitiateCheckout counts, bots excluded
//   - purchase_log (webhook-confirmed):      purchase count
//
// Conversion rates (Taxa Compra, Taxa Conv. Página) are derived from own
// tracking only. Meta's attributed conversions are not used here — they are
// inconsistent compared to the purchase data sent via HTTP request.

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  if (!env.DASH_KEY || key !== env.DASH_KEY) return json({ error: 'Unauthorized' }, 401);

  const days = clampInt(url.searchParams.get('days'), 30, 1, 365);
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const sinceDate = ymd(new Date(since * 1000));

  try {
    const [spendRow, eventCounts, purchaseRow, campaigns, adsets, firstPartyEvents, firstPartyPurchases] = await Promise.all([

      // Meta ad spend totals
      env.DB.prepare(`
        SELECT
          COALESCE(SUM(spend_cents),        0) AS spend_cents,
          COALESCE(SUM(impressions),        0) AS impressions,
          COALESCE(SUM(clicks),             0) AS clicks,
          COALESCE(SUM(landing_page_views), 0) AS landing_page_views
        FROM ad_spend
        WHERE platform = 'meta' AND date >= ?
      `).bind(sinceDate).first(),

      // Own tracking funnel totals — bots excluded
      env.DB.prepare(`
        SELECT event_name, COUNT(*) AS cnt
        FROM event_log
        WHERE event_name IN ('PageView', 'InitiateCheckout')
          AND is_bot = 0
          AND timestamp >= ?
        GROUP BY event_name
      `).bind(since).all(),

      // Total purchases
      env.DB.prepare(`
        SELECT COUNT(*) AS cnt FROM purchase_log WHERE created_at >= ?
      `).bind(since).first(),

      // Per-campaign Meta spend breakdown
      env.DB.prepare(`
        SELECT
          campaign_id,
          campaign_name,
          COALESCE(SUM(spend_cents),        0) AS spend_cents,
          COALESCE(SUM(impressions),        0) AS impressions,
          COALESCE(SUM(clicks),             0) AS clicks,
          COALESCE(SUM(landing_page_views), 0) AS landing_page_views
        FROM ad_spend
        WHERE platform = 'meta' AND date >= ?
        GROUP BY campaign_id, campaign_name
        ORDER BY spend_cents DESC
        LIMIT 50
      `).bind(sinceDate).all(),

      // Per-adset breakdown (only rows synced at adset level)
      env.DB.prepare(`
        SELECT
          campaign_id,
          adset_id,
          adset_name,
          COALESCE(SUM(spend_cents),  0) AS spend_cents,
          COALESCE(SUM(impressions),  0) AS impressions,
          COALESCE(SUM(clicks),       0) AS clicks
        FROM ad_spend
        WHERE platform = 'meta' AND date >= ? AND adset_id IS NOT NULL AND adset_id != ''
        GROUP BY campaign_id, adset_id, adset_name
        ORDER BY campaign_id, spend_cents DESC
      `).bind(sinceDate).all(),

      // Per-campaign first-party events (PageView + InitiateCheckout)
      // Normalizes utm_campaign: replaces hyphens with spaces to match Meta campaign names
      env.DB.prepare(`
        SELECT
          LOWER(REPLACE(s.utm_campaign, '-', ' ')) AS norm_campaign,
          SUM(CASE WHEN el.event_name = 'PageView'          THEN 1 ELSE 0 END) AS pageviews,
          SUM(CASE WHEN el.event_name = 'InitiateCheckout'  THEN 1 ELSE 0 END) AS checkouts
        FROM event_log el
        JOIN sessions s ON el.session_id = s.session_id
        WHERE el.is_bot = 0
          AND el.timestamp >= ?
          AND s.utm_campaign != ''
          AND el.event_name IN ('PageView', 'InitiateCheckout')
        GROUP BY norm_campaign
      `).bind(since).all(),

      // Per-campaign purchases from purchase_log
      env.DB.prepare(`
        SELECT
          LOWER(REPLACE(utm_campaign, '-', ' ')) AS norm_campaign,
          COUNT(*) AS purchases,
          COALESCE(SUM(value), 0) AS revenue
        FROM purchase_log
        WHERE created_at >= ?
          AND utm_campaign != ''
        GROUP BY norm_campaign
      `).bind(since).all(),
    ]);

    const evMap = {};
    for (const r of eventCounts.results || []) evMap[r.event_name] = Number(r.cnt || 0);

    // Index first-party data by normalized campaign name
    const fpEvents = {};
    for (const r of firstPartyEvents.results || []) {
      fpEvents[r.norm_campaign] = { pageviews: Number(r.pageviews || 0), checkouts: Number(r.checkouts || 0) };
    }
    const fpPurchases = {};
    for (const r of firstPartyPurchases.results || []) {
      fpPurchases[r.norm_campaign] = { purchases: Number(r.purchases || 0), revenue: Number(r.revenue || 0) };
    }

    // Group adsets by campaign_id
    const adsetsByCampaign = {};
    for (const a of adsets.results || []) {
      if (!adsetsByCampaign[a.campaign_id]) adsetsByCampaign[a.campaign_id] = [];
      adsetsByCampaign[a.campaign_id].push({
        adset_id:   a.adset_id,
        adset_name: a.adset_name,
        spend:      Number(a.spend_cents) / 100,
        impressions: Number(a.impressions),
        clicks:     Number(a.clicks),
      });
    }

    return json({
      days,
      spend:                Number(spendRow?.spend_cents        || 0) / 100,
      impressions:          Number(spendRow?.impressions        || 0),
      clicks:               Number(spendRow?.clicks             || 0),
      meta_landing_page_views: Number(spendRow?.landing_page_views || 0),
      pageviews:            evMap['PageView']         || 0,
      checkouts:            evMap['InitiateCheckout'] || 0,
      purchases:            Number(purchaseRow?.cnt   || 0),
      campaigns: (campaigns.results || []).map(c => {
        const key = c.campaign_name.toLowerCase();
        const fp  = fpEvents[key]    || { pageviews: 0, checkouts: 0 };
        const fpp = fpPurchases[key] || { purchases: 0, revenue: 0 };
        const spend = Number(c.spend_cents) / 100;
        return {
          campaign_id:        c.campaign_id,
          campaign_name:      c.campaign_name,
          spend,
          impressions:        Number(c.impressions),
          clicks:             Number(c.clicks),
          landing_page_views: Number(c.landing_page_views),
          pageviews:          fp.pageviews,
          checkouts:          fp.checkouts,
          purchases:          fpp.purchases,
          cpa:                fpp.purchases > 0 ? spend / fpp.purchases : null,
          taxa_compra:        fp.checkouts  > 0 ? fpp.purchases / fp.checkouts : null,
          adsets:             adsetsByCampaign[c.campaign_id] || [],
        };
      }),
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

function ymd(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

function clampInt(raw, fallback, min, max) {
  const n = parseInt(raw || '', 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
