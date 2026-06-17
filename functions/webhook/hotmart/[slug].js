// -----------------------------------------------------------------------------
// Hotmart webhook adapter.
//
// URL shape: /webhook/hotmart/<HOTMART_WEBHOOK_SLUG>
// The per-recipient UUID stored in env.HOTMART_WEBHOOK_SLUG gates the endpoint.
//
// Platform specifics (confirmed against a real PURCHASE_APPROVED webhook):
//   - Everything is nested under `rawPayload.data`.
//   - `trk` arrives as `data.purchase.origin.xcod`.
//   - `data.purchase.origin.sck` has TWO possible shapes:
//       (a) a pipe-joined UTM bundle emitted by our sales page:
//           `<utm_source>|<utm_medium>|<utm_campaign>|<utm_content>|<utm_term>`
//           with each part URL-encoded. Hotmart does not forward `utm_*`
//           URL params into the webhook body, so this is how attribution
//           survives the checkout round-trip.
//       (b) Hotmart's own traffic-source enum (e.g. "HOTMART_PRODUCT_PAGE",
//           "HOTMART_CHECKOUT_CART") set when no sck was passed on the URL.
//     Presence of `|` in the value distinguishes (a) from (b); enum values
//     never contain pipes.
//   - Hotmart pre-splits buyer name into `first_name` + `last_name`; use those
//     directly instead of re-splitting `name`.
//   - No phone field on the buyer by default. `body.buyer` has `email`,
//     `name`, `first_name`, `last_name`, `document`, `address` — no
//     `mobile` / `phone` / `checkout_phone`. ManyChat fan-out will skip.
//   - Paid event: `rawPayload.event === 'PURCHASE_APPROVED'` combined with
//     `data.purchase.status === 'APPROVED'`. Hotmart fires other events
//     (PURCHASE_COMPLETE, PURCHASE_REFUNDED, etc.) — acknowledge-and-skip.
//   - `data.product.id` is a number; stringify for storage.
//   - Price values are already decimals (97 not 9700); no cents conversion.
// -----------------------------------------------------------------------------

import { processPurchase } from '../_core.js';
import { guardSlug } from '../_utils.js';

export async function onRequestPost(context) {
  const { request, env, params } = context;

  const slugFailure = guardSlug(params.slug, env.HOTMART_WEBHOOK_SLUG);
  if (slugFailure) return slugFailure;

  try {
    const rawPayload = await request.json();
    const body = rawPayload.data || {};
    const eventName = rawPayload.event || '';

    // Only process approved purchases. Every other event (PURCHASE_COMPLETE,
    // PURCHASE_REFUNDED, PURCHASE_CHARGEBACK, PURCHASE_DELAYED,
    // PURCHASE_CANCELED, SUBSCRIPTION_*) returns 200 and skips.
    if (eventName !== 'PURCHASE_APPROVED' || body.purchase?.status !== 'APPROVED') {
      return new Response(
        JSON.stringify({ ok: true, skipped: 'not an approved purchase', event: eventName, status: body.purchase?.status }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const buyer = body.buyer || {};
    const product = body.product || {};
    const purchase = body.purchase || {};
    const price = purchase.price || purchase.full_price || {};

    // Build a "name" string from pre-split first/last so downstream helpers
    // that expect a full name still work. If only one is provided, that's fine.
    const fullName = buyer.name
      || [buyer.first_name, buyer.last_name].filter(Boolean).join(' ')
      || '';

    const productIdStr = String(product.id || product.ucode || '');
    const platformUtm = parseSckBundle(purchase.origin?.sck);

    const parsed = {
      platform: 'hotmart',
      trk: purchase.origin?.xcod || '',
      email: buyer.email || '',
      name: fullName,
      // Hotmart doesn't surface phone on the default PURCHASE_APPROVED
      // payload; leave empty. ManyChat fan-out is conditional on phone
      // and will silently skip.
      phone: '',
      value: parseFloat(price.value) || 0,
      currency: price.currency_value || 'BRL',
      transactionId: purchase.transaction || '',
      productId: productIdStr,
      productName: product.name || '',
      // Hotmart v2 webhooks don't ship cart arrays on standard purchases —
      // synthesize a single-item array from the product block so
      // purchase_items stays populated.
      items: [{
        productId: productIdStr,
        name: product.name || '',
        price: { value: parseFloat(price.value) || 0, currency: price.currency_value || 'BRL' },
      }],
      // UTMs recovered from the sck bundle when the sales page packed
      // them there; otherwise empty and `_core.js` falls back to
      // `checkout_sessions.utm_*` (the attribution the sales page
      // persisted at visit time).
      platformUtm,
    };

    const result = await processPurchase({ parsed, env, context });

    return new Response(
      JSON.stringify({ ok: true, event_id: result.eventId }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    console.error('Hotmart webhook error:', err.message);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

// Unpack the pipe-joined UTM bundle the sales page may have written to
// `origin.sck`. Returns empty strings when the input is absent, is
// Hotmart's own traffic-source enum (no `|`), or is malformed.
function parseSckBundle(sck) {
  const empty = { utm_source: '', utm_medium: '', utm_campaign: '', utm_content: '', utm_term: '' };
  if (!sck || typeof sck !== 'string' || !sck.includes('|')) return empty;
  const parts = sck.split('|').map(p => {
    try { return decodeURIComponent(p); } catch (_) { return p; }
  });
  return {
    utm_source: parts[0] || '',
    utm_medium: parts[1] || '',
    utm_campaign: parts[2] || '',
    utm_content: parts[3] || '',
    utm_term: parts[4] || '',
  };
}
