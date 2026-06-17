// -----------------------------------------------------------------------------
// Webhook core — platform-agnostic purchase processing.
//
// Each sales platform (Eduzz / Hotmart / Kiwify / etc.) has its own thin
// adapter file in this directory. The adapter is responsible for:
//   1. Reading the raw request body.
//   2. Verifying the platform-specific signature.
//   3. Parsing the platform's payload shape into the normalized purchase
//      object described below.
//   4. Calling processPurchase() with that normalized object.
//
// Normalized purchase object (what each adapter must produce):
//
//   {
//     platform:      'eduzz' | 'hotmart' | 'kiwify' | string,
//     trk:           string,
//     email:         string,
//     name:          string,
//     phone:         string,
//     value:         number,
//     currency:      string,
//     transactionId: string,
//     productId:     string,
//     productName:   string,
//     items:         Array<{ productId, name, price: { value, currency } }>,
//     platformUtm:   { utm_source, utm_medium, utm_campaign, utm_content, utm_term },
//   }
// -----------------------------------------------------------------------------

import PRODUCTS_CONFIG from '../../config/products.js';

export async function processPurchase({ parsed, env, context }) {
  const productConfig = PRODUCTS_CONFIG[parsed.platform]?.[parsed.productId] || null;

  // Look up originating checkout session (UTMs, fbclid, etc.)
  let checkoutData = {};
  if (parsed.trk && env.DB) {
    try {
      const row = await env.DB.prepare(
        'SELECT * FROM checkout_sessions WHERE trk = ?'
      ).bind(parsed.trk).first();
      if (row) checkoutData = row;
    } catch (e) {
      console.error('D1 checkout lookup error:', e.message);
    }
  }

  const enriched = { ...parsed, productConfig, checkoutData };
  const eventId = crypto.randomUUID();
  const eventTime = Math.floor(Date.now() / 1000);

  const handlerPromises = [];

  if (productConfig && parsed.email) {
    handlerPromises.push(
      handleEncharge({ parsed: enriched, env })
        .then(r => ({ handler: 'encharge', ...r }))
        .catch(e => ({ handler: 'encharge', error: e.message }))
    );
  }

  if (productConfig && parsed.phone) {
    handlerPromises.push(
      handleManyChat({ parsed: enriched, env })
        .then(r => ({ handler: 'manychat', ...r }))
        .catch(e => ({ handler: 'manychat', error: e.message }))
    );
  }

  const results = await Promise.allSettled(handlerPromises);
  const resultMap = {};
  for (const r of results) {
    const val = r.status === 'fulfilled' ? r.value : { handler: 'unknown', error: r.reason?.message };
    resultMap[val.handler] = val;
  }

  context.waitUntil(
    handlePurchaseLog({ parsed: enriched, eventId, eventTime, resultMap, env })
  );

  return { eventId, handlers: Object.keys(resultMap) };
}

// -----------------------------------------------------------------------------
// HANDLER: Encharge — email marketing
// -----------------------------------------------------------------------------
async function handleEncharge({ parsed, env }) {
  if (!env.ENCHARGE_API_KEY) {
    return { statusCode: 0, responseOk: 0, responseBody: 'Missing ENCHARGE_API_KEY' };
  }

  const { email, name, productConfig } = parsed;
  if (!productConfig?.enchargeTag) {
    return { statusCode: 0, responseOk: 0, responseBody: 'No enchargeTag for this product' };
  }
  const nameParts = splitName(name);

  const response = await fetch('https://api.encharge.io/v1/people', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Encharge-Token': env.ENCHARGE_API_KEY,
    },
    body: JSON.stringify({
      email: email,
      firstName: nameParts.fn,
      tags: productConfig.enchargeTag,
    }),
  });

  let responseBody = '';
  try { responseBody = await response.text(); } catch (e) { responseBody = `Read error: ${e.message}`; }

  return { statusCode: response.status, responseOk: response.ok ? 1 : 0, responseBody };
}

// -----------------------------------------------------------------------------
// HANDLER: ManyChat — create subscriber + add tag
// -----------------------------------------------------------------------------
async function handleManyChat({ parsed, env }) {
  if (!env.MANYCHAT_KEY) {
    return { statusCode: 0, responseOk: 0, responseBody: 'Missing MANYCHAT_KEY' };
  }

  const { name, phone, productConfig } = parsed;
  if (!productConfig?.manychatTagId) {
    return { statusCode: 0, responseOk: 0, responseBody: 'No manychatTagId for this product' };
  }
  const nameParts = splitName(name);
  const manychatPhone = normalizePhone(phone, env.DEFAULT_COUNTRY_CODE);

  if (!manychatPhone) {
    return { statusCode: 0, responseOk: 0, responseBody: 'No valid phone for ManyChat' };
  }

  const authHeaders = {
    'Authorization': `Bearer ${env.MANYCHAT_KEY}`,
    'Content-Type': 'application/json',
  };

  const createRes = await fetch('https://api.manychat.com/fb/subscriber/createSubscriber', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      first_name: nameParts.fn,
      last_name: nameParts.ln,
      whatsapp_phone: manychatPhone,
    }),
  });

  let createBody = '';
  try { createBody = await createRes.text(); } catch (e) { createBody = `Read error: ${e.message}`; }

  if (!createRes.ok) {
    return { statusCode: createRes.status, responseOk: 0, responseBody: `createSubscriber failed: ${createBody}` };
  }

  let subscriberId = '';
  try {
    const createData = JSON.parse(createBody);
    subscriberId = createData.data?.id || '';
  } catch (e) {
    return { statusCode: createRes.status, responseOk: 0, responseBody: `Parse error: ${e.message}` };
  }

  if (!subscriberId) {
    return { statusCode: createRes.status, responseOk: 0, responseBody: `No subscriber_id: ${createBody}` };
  }

  const tagRes = await fetch('https://api.manychat.com/fb/subscriber/addTag', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ subscriber_id: subscriberId, tag_id: productConfig.manychatTagId }),
  });

  let tagBody = '';
  try { tagBody = await tagRes.text(); } catch (e) { tagBody = `Read error: ${e.message}`; }

  return {
    statusCode: tagRes.status,
    responseOk: tagRes.ok ? 1 : 0,
    responseBody: `createSubscriber: ${createBody} | addTag: ${tagBody}`,
  };
}

// -----------------------------------------------------------------------------
// HANDLER: Purchase Log — D1 insert (always runs, background)
// -----------------------------------------------------------------------------
async function handlePurchaseLog({ parsed, eventId, eventTime, resultMap, env }) {
  if (!env.DB) return;

  const { trk, email, name, phone, value, currency, transactionId, productId, productName, checkoutData, platformUtm, items } = parsed;
  const encharge = resultMap.encharge || {};
  const manychat = resultMap.manychat || {};

  const createdAt = Math.floor(Date.now() / 1000);
  let purchaseId = null;

  try {
    const result = await env.DB.prepare(`
      INSERT INTO purchase_log (
        trk, event_id, event_time,
        raw_email, raw_name, raw_phone,
        hashed_em, hashed_fn, hashed_ln, hashed_ph, hashed_external_id,
        client_ip_address, client_user_agent, fbp, fbc,
        value, currency, transaction_id,
        event_source_url,
        meta_status_code, meta_response_ok, meta_response_body, meta_payload_sent,
        ga4_status_code, ga4_response_ok, ga4_response_body, ga4_payload_sent,
        google_ads_status_code, google_ads_response_ok, google_ads_response_body, google_ads_payload_sent,
        gclid, gbraid, wbraid,
        utm_source, utm_medium, utm_campaign, utm_content, utm_term,
        product_id, product_name,
        encharge_status_code, encharge_response_ok, encharge_response_body,
        manychat_status_code, manychat_response_ok, manychat_response_body,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      trk || '', eventId, eventTime,
      email, name, phone,
      '', '', '', '', '',
      checkoutData.ip_address || '', checkoutData.user_agent || '',
      checkoutData.fbp || '', checkoutData.fbc || '',
      parseFloat(value) || 0, currency, transactionId,
      checkoutData.event_source_url || '',
      0, 0, '', null,
      0, 0, '', null,
      0, 0, '', null,
      checkoutData.gclid || '', checkoutData.gbraid || '', checkoutData.wbraid || '',
      platformUtm.utm_source || checkoutData.utm_source || '',
      platformUtm.utm_medium || checkoutData.utm_medium || '',
      platformUtm.utm_campaign || checkoutData.utm_campaign || '',
      platformUtm.utm_content || checkoutData.utm_content || '',
      platformUtm.utm_term || checkoutData.utm_term || '',
      productId || '', productName || '',
      encharge.statusCode || 0, encharge.responseOk || 0, encharge.responseBody || '',
      manychat.statusCode || 0, manychat.responseOk || 0, manychat.responseBody || '',
      createdAt
    ).run();

    purchaseId = result.meta?.last_row_id ?? null;
  } catch (e) {
    console.error('D1 purchase_log error:', e.message);
    return;
  }

  if (purchaseId == null || !Array.isArray(items) || items.length === 0) return;

  try {
    const itemStmt = env.DB.prepare(`
      INSERT INTO purchase_items (
        purchase_id, transaction_id, product_id, product_name,
        value, currency, created_at,
        utm_source, utm_campaign, utm_medium, utm_content, utm_term
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const batch = items.map(item => itemStmt.bind(
      purchaseId,
      transactionId || null,
      String(item.productId || ''),
      item.name || null,
      parseFloat(item?.price?.value) || 0,
      item?.price?.currency || currency || 'BRL',
      createdAt,
      platformUtm.utm_source || checkoutData.utm_source || null,
      platformUtm.utm_campaign || checkoutData.utm_campaign || null,
      platformUtm.utm_medium || checkoutData.utm_medium || null,
      platformUtm.utm_content || checkoutData.utm_content || null,
      platformUtm.utm_term || checkoutData.utm_term || null,
    ));

    await env.DB.batch(batch);
  } catch (e) {
    console.error('D1 purchase_items error, rolling back parent row', { transactionId, purchaseId, error: e.message });
    try {
      await env.DB.prepare('DELETE FROM purchase_log WHERE id = ?').bind(purchaseId).run();
    } catch (rollbackErr) {
      console.error('CRITICAL: purchase_log rollback failed', { transactionId, purchaseId, error: rollbackErr.message });
    }
  }
}

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------
function normalizePhone(ph, countryCode) {
  if (!ph) return '';
  const cc = String(countryCode || '55');
  const digits = ph.replace(/\D/g, '').replace(/^0+/, '');
  if (!digits) return '';
  if (digits.startsWith(cc) && digits.length >= cc.length + 8 && digits.length <= cc.length + 11) return digits;
  if (digits.length >= 8 && digits.length <= 11) return cc + digits;
  return digits;
}

function normalizeName(name) {
  if (!name) return '';
  return name.trim().toLowerCase();
}

function splitName(fullName) {
  const parts = (fullName || '').trim().split(/\s+/);
  return { fn: parts[0] || '', ln: parts.slice(1).join(' ') || '' };
}
