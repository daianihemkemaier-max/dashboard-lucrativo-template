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
//
// Per-ad funnel numbers (pageviews/checkouts/purchases inside `ads[]`) are
// matched via utm_content, by convention holding the ad's name, keyed
// together with the campaign as "campaign|content" so the same creative
// name across two campaigns doesn't collide.
//
// Matching a UTM back to a Meta campaign/ad name is normalized(), not a
// literal string compare: real campaign names commonly carry brackets,
// colons, pipes, emoji — symbols a URL-safe UTM slug can't reproduce.
// Both sides get reduced to only [a-z0-9] before comparing, so
// "[26C - Descoberta]" and a UTM of "26c-descoberta" (or "26C_Descoberta",
// or any other separator choice) match on their shared alphanumeric
// fingerprint instead of requiring the slug to reconstruct the exact
// original punctuation.

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  if (!env.DASH_KEY || key !== env.DASH_KEY) return json({ error: 'Unauthorized' }, 401);

  const days = clampInt(url.searchParams.get('days'), 30, 1, 365);
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const sinceDate = ymd(new Date(since * 1000));

  try {
    const [spendRow, eventCounts, purchaseRow, campaigns, adsets, ads, firstPartyEvents, firstPartyPurchases, firstPartyAdEvents, firstPartyAdPurchases] = await Promise.all([

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

      // Per-ad breakdown (only rows synced at ad level)
      env.DB.prepare(`
        SELECT
          campaign_id,
          adset_id,
          adset_name,
          ad_id,
          ad_name,
          COALESCE(SUM(spend_cents),        0) AS spend_cents,
          COALESCE(SUM(impressions),        0) AS impressions,
          COALESCE(SUM(clicks),             0) AS clicks,
          COALESCE(SUM(landing_page_views), 0) AS landing_page_views
        FROM ad_spend
        WHERE platform = 'meta' AND date >= ? AND ad_id IS NOT NULL AND ad_id != ''
        GROUP BY campaign_id, adset_id, ad_id, ad_name
        ORDER BY campaign_id, spend_cents DESC
      `).bind(sinceDate).all(),

      // Per-campaign first-party events (PageView + InitiateCheckout).
      // Grouped by the raw utm_campaign — merging different raw spellings
      // that share the same normalized() fingerprint happens in JS below,
      // since SQLite has no regex-strip to do it here. Reads utm_campaign
      // frozen on the event_log row itself (see migration 0018) instead of
      // joining the mutable sessions row — a session's utm_campaign gets
      // overwritten on every new visit, which used to silently reattribute
      // a returning visitor's earlier events to whatever campaign they most
      // recently arrived from.
      env.DB.prepare(`
        SELECT
          utm_campaign,
          SUM(CASE WHEN event_name = 'PageView'          THEN 1 ELSE 0 END) AS pageviews,
          SUM(CASE WHEN event_name = 'InitiateCheckout'  THEN 1 ELSE 0 END) AS checkouts
        FROM event_log
        WHERE is_bot = 0
          AND timestamp >= ?
          AND utm_campaign != ''
          AND event_name IN ('PageView', 'InitiateCheckout')
        GROUP BY utm_campaign
      `).bind(since).all(),

      // Per-campaign purchases from purchase_log
      env.DB.prepare(`
        SELECT
          utm_campaign,
          COUNT(*) AS purchases,
          COALESCE(SUM(value), 0) AS revenue
        FROM purchase_log
        WHERE created_at >= ?
          AND utm_campaign != ''
        GROUP BY utm_campaign
      `).bind(since).all(),

      // Per-ad first-party events (PageView + InitiateCheckout).
      // utm_content carries the ad name (see teste.html convention). Keyed by
      // campaign+content together since the same creative name could be
      // reused across different campaigns. Reads straight off event_log
      // (frozen at event time — see migration 0018), same reasoning as the
      // campaign-level query above.
      env.DB.prepare(`
        SELECT
          utm_campaign,
          utm_content,
          SUM(CASE WHEN event_name = 'PageView'          THEN 1 ELSE 0 END) AS pageviews,
          SUM(CASE WHEN event_name = 'InitiateCheckout'  THEN 1 ELSE 0 END) AS checkouts
        FROM event_log
        WHERE is_bot = 0
          AND timestamp >= ?
          AND utm_campaign != ''
          AND utm_content != ''
          AND event_name IN ('PageView', 'InitiateCheckout')
        GROUP BY utm_campaign, utm_content
      `).bind(since).all(),

      // Per-ad purchases from purchase_log
      env.DB.prepare(`
        SELECT
          utm_campaign,
          utm_content,
          COUNT(*) AS purchases,
          COALESCE(SUM(value), 0) AS revenue
        FROM purchase_log
        WHERE created_at >= ?
          AND utm_campaign != ''
          AND utm_content != ''
        GROUP BY utm_campaign, utm_content
      `).bind(since).all(),
    ]);

    const evMap = {};
    for (const r of eventCounts.results || []) evMap[r.event_name] = Number(r.cnt || 0);

    // Index first-party data by normalized campaign name — merges any raw
    // utm_campaign spellings that share the same alphanumeric fingerprint.
    const fpEvents = {};
    for (const r of firstPartyEvents.results || []) {
      const k = normalize(r.utm_campaign);
      const acc = fpEvents[k] || (fpEvents[k] = { pageviews: 0, checkouts: 0 });
      acc.pageviews += Number(r.pageviews || 0);
      acc.checkouts += Number(r.checkouts || 0);
    }
    const fpPurchases = {};
    for (const r of firstPartyPurchases.results || []) {
      const k = normalize(r.utm_campaign);
      const acc = fpPurchases[k] || (fpPurchases[k] = { purchases: 0, revenue: 0 });
      acc.purchases += Number(r.purchases || 0);
      acc.revenue += Number(r.revenue || 0);
    }

    // Index first-party ad-level data by "normalized campaign|normalized content"
    const fpAdEvents = {};
    for (const r of firstPartyAdEvents.results || []) {
      const k = `${normalize(r.utm_campaign)}|${normalize(r.utm_content)}`;
      const acc = fpAdEvents[k] || (fpAdEvents[k] = { pageviews: 0, checkouts: 0 });
      acc.pageviews += Number(r.pageviews || 0);
      acc.checkouts += Number(r.checkouts || 0);
    }
    const fpAdPurchases = {};
    for (const r of firstPartyAdPurchases.results || []) {
      const k = `${normalize(r.utm_campaign)}|${normalize(r.utm_content)}`;
      const acc = fpAdPurchases[k] || (fpAdPurchases[k] = { purchases: 0, revenue: 0 });
      acc.purchases += Number(r.purchases || 0);
      acc.revenue += Number(r.revenue || 0);
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

    // Group ads by campaign_id
    const adsByCampaign = {};
    for (const a of ads.results || []) {
      if (!adsByCampaign[a.campaign_id]) adsByCampaign[a.campaign_id] = [];
      adsByCampaign[a.campaign_id].push({
        adset_id:    a.adset_id,
        adset_name:  a.adset_name,
        ad_id:       a.ad_id,
        ad_name:     a.ad_name,
        spend:       Number(a.spend_cents) / 100,
        impressions: Number(a.impressions),
        clicks:      Number(a.clicks),
        landing_page_views: Number(a.landing_page_views),
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
        const key = normalize(c.campaign_name);
        const fp  = fpEvents[key]    || { pageviews: 0, checkouts: 0 };
        const fpp = fpPurchases[key] || { purchases: 0, revenue: 0 };
        const spend = Number(c.spend_cents) / 100;

        const ads = (adsByCampaign[c.campaign_id] || []).map(a => {
          const adKey = `${key}|${normalize(a.ad_name)}`;
          const adFp  = fpAdEvents[adKey]    || { pageviews: 0, checkouts: 0 };
          const adFpp = fpAdPurchases[adKey] || { purchases: 0, revenue: 0 };
          return {
            ...a,
            pageviews:   adFp.pageviews,
            checkouts:   adFp.checkouts,
            purchases:   adFpp.purchases,
            cpa:         adFpp.purchases > 0 ? a.spend / adFpp.purchases : null,
            taxa_compra: adFp.checkouts  > 0 ? adFpp.purchases / adFp.checkouts : null,
          };
        });

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
          ads,
        };
      }),
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

// Reduces a name to its shared alphanumeric fingerprint (lowercase, no
// spaces/punctuation/symbols) so a UTM slug and a Meta campaign/ad name that
// differ only in separators or symbols still match. See file header comment.
function normalize(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
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
