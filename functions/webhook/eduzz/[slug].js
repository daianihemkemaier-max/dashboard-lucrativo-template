// -----------------------------------------------------------------------------
// Eduzz webhook adapter.
//
// URL shape: /webhook/eduzz/<EDUZZ_WEBHOOK_SLUG>
// The per-recipient UUID stored in env.EDUZZ_WEBHOOK_SLUG gates the endpoint;
// scanners hitting /webhook/eduzz without the right slug get a 404.
//
// Platform specifics:
//   - Unique checkout identifier arrives as `body.tracker.code1` → maps to `trk`.
//   - Eduzz wraps the payload as `{ event_name, data: {...} }` — unwrap if present.
//   - Sale statuses that indicate a real paid purchase: 'paid'.
// -----------------------------------------------------------------------------

import { processPurchase } from '../_core.js';
import { guardSlug } from '../_utils.js';

export async function onRequestPost(context) {
  const { request, env, params } = context;

  const slugFailure = guardSlug(params.slug, env.EDUZZ_WEBHOOK_SLUG);
  if (slugFailure) return slugFailure;

  try {
    const rawPayload = await request.json();

    // Eduzz wraps the payload as { event_name, data: {...} }
    const body = rawPayload.data || rawPayload;
    const firstItem = body.items?.[0] || {};

    // Only process paid sales. Other statuses (pending, refunded, chargeback)
    // get acknowledged with 200 so Eduzz stops retrying.
    const saleStatus = body.status || '';
    if (saleStatus !== 'paid') {
      return new Response(
        JSON.stringify({ ok: true, skipped: 'not paid', status: saleStatus }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const parsed = {
      platform: 'eduzz',
      trk: body.tracker?.code1 || '',
      email: body.buyer?.email || body.student?.email || '',
      name: body.buyer?.name || body.student?.name || '',
      phone: body.buyer?.cellphone || body.buyer?.phone || '',
      value: body.paid?.value || body.price?.value || 0,
      currency: body.paid?.currency || body.price?.currency || 'BRL',
      transactionId: body.transaction?.id || body.id || '',
      productId: String(firstItem.productId || ''),
      productName: firstItem.name || '',
      items: body.items || [],
      platformUtm: {
        utm_source: body.utm?.source || '',
        utm_medium: body.utm?.medium || '',
        utm_campaign: body.utm?.campaign || '',
        utm_content: body.utm?.content || '',
        utm_term: body.utm?.term || '',
      },
    };

    const result = await processPurchase({ parsed, env, context });

    return new Response(
      JSON.stringify({ ok: true, event_id: result.eventId }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    console.error('Eduzz webhook error:', err.message);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
