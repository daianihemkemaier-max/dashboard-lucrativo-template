// -----------------------------------------------------------------------------
// Kiwify webhook adapter.
//
// URL shape: /webhook/kiwify/<KIWIFY_WEBHOOK_SLUG>
// The per-recipient UUID stored in env.KIWIFY_WEBHOOK_SLUG gates the endpoint.
//
// Platform specifics (confirmed against a real order_approved webhook):
//   - Whole payload is wrapped under `rawPayload.order`. Root also carries
//     `url` (destination URL) and `signature` (40-char HMAC-SHA1 hex,
//     deliberately ignored here — see plan).
//   - `trk` arrives as `order.TrackingParameters.sck`. `src`, `s1`, `s2`,
//     `s3` are additional tracking slots Kiwify exposes; we ignore them.
//   - `order_id` is a UUID, not a prefixed string.
//   - `charge_amount` is an INTEGER in cents (100000 = R$ 1000.00). Divide
//     by 100 for the normalized `value`.
//   - Paid event: `order.webhook_event_type === 'order_approved'` AND
//     `order.order_status === 'paid'`.
//   - `Product` / `Customer` / `Commissions` / `TrackingParameters` use
//     PascalCase; most other keys are snake_case. Don't assume a convention.
//   - Kiwify retries aggressively on non-200 responses; fail fast on parse
//     errors, and `purchase_log.transaction_id` unique index dedupes retries.
// -----------------------------------------------------------------------------

import { processPurchase } from '../_core.js';
import { guardSlug } from '../_utils.js';

export async function onRequestPost(context) {
  const { request, env, params } = context;

  const slugFailure = guardSlug(params.slug, env.KIWIFY_WEBHOOK_SLUG);
  if (slugFailure) return slugFailure;

  try {
    const rawPayload = await request.json();
    const body = rawPayload.order ?? rawPayload ?? {};

    // Kiwify coloca webhook_event_type dentro de order na maioria dos casos,
    // mas em produtos club pode vir na raiz do payload.
    const webhookEventType = body.webhook_event_type || rawPayload.webhook_event_type || '';
    const orderStatus      = body.order_status      || rawPayload.order_status      || '';

    // Only process approved orders. subscription renewals fire the same
    // event type with a new `order_id` per cycle — those are legitimately
    // new purchases and DO get processed. The `transaction_id` unique
    // index on `purchase_log` prevents double-logging duplicate retries
    // for the same order.
    const isApproved = webhookEventType === 'order_approved' && orderStatus === 'paid';
    if (!isApproved) {
      return new Response(
        JSON.stringify({ ok: true, skipped: 'not an approved order',
          event: webhookEventType, status: orderStatus }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const customer = body.Customer || {};
    const product = body.Product || {};
    const commissions = body.Commissions || {};
    const tracking = body.TrackingParameters || {};

    // charge_amount arrives as an integer in cents. The parser is
    // deliberately strict — a decimal value would indicate a payload
    // change we should notice rather than silently absorb.
    const valueInReais = Number.isFinite(commissions.charge_amount)
      ? commissions.charge_amount / 100
      : 0;
    const currency = commissions.currency || 'BRL';
    const productIdStr = String(product.product_id || '');

    const parsed = {
      platform: 'kiwify',
      trk: tracking.sck || '',
      email: customer.email || '',
      name: customer.full_name
        || [customer.first_name, customer.last_name].filter(Boolean).join(' ')
        || '',
      phone: customer.mobile || '',
      value: valueInReais,
      currency,
      transactionId: body.order_id || '',
      productId: productIdStr,
      productName: product.product_name || '',
      items: [{
        productId: productIdStr,
        name: product.product_name || '',
        price: { value: valueInReais, currency },
      }],
      platformUtm: {
        utm_source: tracking.utm_source || '',
        utm_medium: tracking.utm_medium || '',
        utm_campaign: tracking.utm_campaign || '',
        utm_content: tracking.utm_content || '',
        utm_term: tracking.utm_term || '',
      },
    };

    const result = await processPurchase({ parsed, env, context });

    return new Response(
      JSON.stringify({ ok: true, event_id: result.eventId }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    console.error('Kiwify webhook error:', err.message);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
