# Eduzz

The reference adapter. Eduzz is Brazilian, uses Portuguese field names in
its dashboard, and has a well-behaved webhook. Everything else (Hotmart,
Kiwify, future platforms) is structured by copying this adapter.

## Identity

- **Webhook endpoint**: `/webhook/eduzz/<EDUZZ_WEBHOOK_SLUG>`
- **Adapter file**: `functions/webhook/eduzz/[slug].js`
- **Sandbox availability**: no native sandbox. Test by creating a product
  with a 100%-off coupon and running a real purchase.
- **Dashboard URL for webhook config**: Eduzz → Minha Conta → Integrações
  → Webhooks.

## Endpoint security — obscure URL

The full endpoint is `/webhook/eduzz/<slug>` where `<slug>` is a
36-character UUID v4 generated for the recipient by `deploy-stack` and
stored as `env.EDUZZ_WEBHOOK_SLUG`. A request to `/webhook/eduzz/<any
wrong slug>` returns 404 — indistinguishable from a nonexistent route,
so drive-by scanners learn nothing.

Platform-native HMAC verification (`x-signature` header, HMAC-SHA256
over raw body) is **deliberately not implemented** in v1. The obscure
URL is the only gate. This is the same pattern n8n / Zapier / GitHub /
Stripe use for webhook endpoints. If a recipient wants to harden
further, the post-launch `harden-tracking` skill will layer real HMAC
verification on top without changing the adapter's shape.

## The `trk` field

- **URL parameter name on checkout URL**: `trk` (the Eduzz custom tracker
  slot labelled `tracker.code1` internally).
- **Webhook payload path**: `body.tracker.code1`.
- **Character-set**: Eduzz preserves full 36-char UUIDs without mangling.

When you create the Eduzz product you'll see a "Rastreamento" field in
the checkout configuration. Leave it empty; the sales page appends `trk`
at click time as a query parameter, and Eduzz copies query parameters
into `tracker.code1` automatically.

## Payload shape

Eduzz wraps its payload as `{ event_name, data: {...} }`. The adapter
unwraps transparently: `const body = rawPayload.data || rawPayload;`.

```json
{
  "event_name": "sale.paid",
  "data": {
    "id": "eduzz-sale-987654",
    "status": "paid",
    "transaction": {
      "id": "eduzz-sale-987654",
      "paid_at": "2026-04-15 14:32:10"
    },
    "paid": { "value": 97.00, "currency": "BRL" },
    "price": { "value": 97.00, "currency": "BRL" },
    "items": [
      {
        "productId": 1234567,
        "name": "My Product",
        "price": { "value": 97.00, "currency": "BRL" }
      }
    ],
    "buyer": {
      "name": "Alice Silva",
      "email": "alice@example.com",
      "cellphone": "+55 11 98765-4321"
    },
    "tracker": {
      "code1": "f2d1a9c0-3e8b-4a2e-9c1d-3e7b8f4a2c6d",
      "code2": "",
      "code3": ""
    },
    "utm": {
      "source": "facebook",
      "medium": "paid",
      "campaign": "black-friday-2026",
      "content": "ad-variant-a",
      "term": ""
    }
  }
}
```

| Normalized field | Payload path |
|---|---|
| `trk` | `body.tracker.code1` |
| `email` | `body.buyer.email` (fallback `body.student.email`) |
| `name` | `body.buyer.name` (fallback `body.student.name`) |
| `phone` | `body.buyer.cellphone` (fallback `body.buyer.phone`) |
| `value` | `body.paid.value` (fallback `body.price.value`) |
| `currency` | `body.paid.currency` (fallback `body.price.currency`, else `'BRL'`) |
| `transactionId` | `body.transaction.id` (fallback `body.id`) |
| `productId` | `String(body.items[0].productId)` |
| `productName` | `body.items[0].name` |
| `items[]` | `body.items` as-is (already matches the normalized item shape) |
| `platformUtm.utm_*` | `body.utm.{source,medium,campaign,content,term}` |

## Paid-sale filter

- **Paid status value**: `'paid'` (exact string, lowercase).
- **Status field path**: `body.status`.

Other statuses you'll see in the Eduzz webhook stream: `pending`
(Pix/boleto not yet settled), `refunded`, `chargeback`, `canceled`. The
adapter acknowledges all of them with `200 { ok: true, skipped: 'not
paid' }` so Eduzz stops retrying.

## Known gotchas

- **Subscriptions**: recurring products fire `sale.paid` on the initial
  purchase AND on each renewal. Each is a separate `Purchase` event,
  which is correct for revenue tracking. If the recipient only wants
  first-charge attribution, filter by `body.recurrence?.current_cycle ===
  1` in the adapter.
- **Currency variance**: Eduzz supports BRL, USD, EUR on some accounts.
  The adapter defaults to `'BRL'` when the payload omits currency —
  audit if the recipient sells in multiple currencies.
- **`cellphone` vs `phone`**: Eduzz used to send just `phone`; newer
  accounts send `cellphone`. The adapter tries both.
- **Test webhooks from the Eduzz dashboard** send a fixed example
  payload that does NOT include `tracker.code1`. That row lands in
  `purchase_log` without `checkoutData` — expected, not a bug.

## Verification test

1. Run `deploy-stack`; note the Eduzz webhook URL it prints
   (format: `https://<project>.pages.dev/webhook/eduzz/<uuid>`).
2. Paste that URL into Eduzz → Minha Conta → Integrações → Webhooks.
3. Click "Enviar teste" in the Eduzz webhook settings. Expect a 200
   response. `purchase_log` should have a new row with `trk = ''`
   (test payloads have no tracker).
4. Create a coupon that brings one of your products to R$ 0,00.
5. Complete a real purchase flow starting from your sales page.
6. Query D1:
   ```
   wrangler d1 execute <db> --remote --command \
     "SELECT transaction_id, trk, meta_response_ok, ga4_response_ok, google_ads_response_ok, value, currency FROM purchase_log ORDER BY created_at DESC LIMIT 1"
   ```
7. The row should have: non-empty `trk`, `meta_response_ok = 1`,
   `ga4_response_ok = 1`, and (if `gclid` was present)
   `google_ads_response_ok = 1`.
8. Check Meta Events Manager → Test Events for the matching `Purchase`.
9. Separately, hit `/webhook/eduzz/wrong-slug` directly — it must return
   404. If you get 200, something is wrong with the slug guard.
