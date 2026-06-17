# Kiwify

Brazilian platform. Webhook body is nested under `order`, currency
values arrive as integer cents, and `sck` is the custom-tracking field.
Parser below was confirmed against a real `order_approved` capture.

## Identity

- **Webhook endpoint**: `/webhook/kiwify/<KIWIFY_WEBHOOK_SLUG>`
- **Adapter file**: `functions/webhook/kiwify/[slug].js`
- **Sandbox availability**: no native sandbox. Test with a real product
  under a 100%-off coupon.
- **Dashboard URL for webhook config**: Kiwify → Configurações →
  Webhooks.

## Endpoint security — obscure URL

Same pattern as Eduzz and Hotmart. `/webhook/kiwify/<slug>` with
`<slug>` stored as `env.KIWIFY_WEBHOOK_SLUG`. Wrong slug → 404.

Kiwify's platform-native signature is a 40-char hex string at
`rawPayload.signature` (HMAC-SHA1 over a subset of the payload). The v1
adapter ignores it deliberately — the future `harden-tracking` skill
adds verification if the recipient wants it.

## The `trk` field

- **URL parameter name on checkout URL**: `sck`. Kiwify's "source code"
  parameter, surfaced in Kiwify reports as "SCK".
- **Webhook payload path**: `body.order.TrackingParameters.sck`.
- **Character-set**: Kiwify truncates tracking values at ~50 chars. A
  36-char UUID is well under the limit.
- **Alternative slots**: `TrackingParameters` also has `src`, `s1`, `s2`,
  `s3`. We ignore them. `sck` is the canonical slot.

## Payload shape (from real order_approved capture)

Kiwify wraps the whole payload under `rawPayload.order`. The root also
carries `url` (destination URL Kiwify posted to) and `signature` (which
we ignore).

```json
{
  "url": "https://<your-project>.pages.dev/webhook/kiwify/<slug>",
  "signature": "601783caff445ff8843f73d230b8bf57defd1068",
  "order": {
    "order_id": "d9b7a395-9ae0-4a3b-ba41-fe6b02de108b",
    "order_ref": "JlqSqjS",
    "order_status": "paid",
    "product_type": "membership",
    "payment_method": "credit_card",
    "store_id": "j1WCwyAY0l2fXT5",
    "installments": 1,
    "created_at": "2026-04-22 03:05",
    "approved_date": "2026-04-22 03:05",
    "webhook_event_type": "order_approved",
    "Product": {
      "product_id": "32ea5930-35b0-11ef-b625-0f7569a9c525",
      "product_name": "My Product"
    },
    "Customer": {
      "full_name": "Alice Silva",
      "first_name": "Alice",
      "email": "alice@example.com",
      "mobile": "+5547999999999",
      "CPF": "…",
      "ip": "…",
      "country": "br"
    },
    "Commissions": {
      "charge_amount": 100000,
      "product_base_price": 100000,
      "product_base_price_currency": "BRL",
      "kiwify_fee": 9239,
      "currency": "BRL",
      "my_commission": 90761,
      "funds_status": "waiting"
    },
    "TrackingParameters": {
      "src": null,
      "sck": "f2d1a9c0-3e8b-4a2e-9c1d-3e7b8f4a2c6d",
      "utm_source": "facebook",
      "utm_medium": "paid",
      "utm_campaign": "black-friday-2026",
      "utm_content": "ad-variant-a",
      "utm_term": null,
      "s1": null, "s2": null, "s3": null
    },
    "Subscription": {
      "…": "only present for membership products"
    }
  }
}
```

| Normalized field | Payload path |
|---|---|
| `trk` | `body.order.TrackingParameters.sck` |
| `email` | `body.order.Customer.email` |
| `name` | `body.order.Customer.full_name` (or `first_name + " " + last_name` fallback) |
| `phone` | `body.order.Customer.mobile` |
| `value` | `body.order.Commissions.charge_amount / 100` (integer cents → reais) |
| `currency` | `body.order.Commissions.currency` |
| `transactionId` | `body.order.order_id` (UUID) |
| `productId` | `String(body.order.Product.product_id)` |
| `productName` | `body.order.Product.product_name` |
| `items[]` | Single-item array synthesized from `Product` + computed value |
| `platformUtm.utm_*` | `body.order.TrackingParameters.utm_*` |

## Paid-sale filter

- **Paid event**: `body.order.webhook_event_type === 'order_approved'`
- **Status check**: `body.order.order_status === 'paid'`

Other event types acknowledged-and-skipped:
- `order_refunded`
- `order_chargeback`
- `pix_created` / `billet_created` (awaiting payment)
- `subscription_canceled`

## Known gotchas

- **Everything is under `order`.** The adapter does
  `const body = rawPayload.order || {}` at the top. If you forget this
  prefix, every field path returns undefined and the parser silently
  produces empty values.
- **`charge_amount` is integer cents, not a string.** `100000` = R$
  1000.00. Divide by 100 exactly; a decimal value in this field would
  indicate a payload change worth investigating.
- **Casing is inconsistent** — PascalCase for `Product`, `Customer`,
  `Commissions`, `TrackingParameters`; snake_case everywhere else
  (`order_id`, `order_status`, `webhook_event_type`). Match the payload
  exactly, don't assume.
- **`order_id` is a UUID**, not a prefixed string. `transactionId`
  derives directly from it.
- **UTMs inside the payload**: Kiwify forwards the UTMs the buyer
  landed with. The adapter still trusts `checkout_sessions.utm_*` (from
  the session at sales-page visit time) as the source of truth for
  attribution, because that's what matched the recipient's ad. Use
  `platformUtm` only for audit comparison.
- **Kiwify retries aggressively**: failing to return 200 within ~5s
  triggers a retry storm. The unique index on `purchase_log.transaction_id`
  prevents duplicate rows, but each retry still costs a Cloudflare
  request — fail fast on parse errors.
- **Subscription renewals** use a NEW `order_id` per cycle and fire
  `order_approved` each time. They're legitimately new purchases and
  DO get logged — correct for Meta revenue tracking.
- **`signature` and `url` at root**: Kiwify puts these two fields
  alongside `order`. The adapter ignores both. If you're debugging,
  `url` is useful for confirming Kiwify hit the right endpoint.

## Verification test

1. Run `deploy-stack`; note the Kiwify webhook URL.
2. Paste it into Kiwify → Configurações → Webhooks.
3. Create a 100%-off coupon on a Kiwify product.
4. Complete a purchase through your sales page with the coupon.
5. Query D1:
   ```
   wrangler d1 execute <db> --remote --command \
     "SELECT transaction_id, trk, value, currency, utm_source, meta_response_ok FROM purchase_log ORDER BY created_at DESC LIMIT 1"
   ```
6. Confirm: `trk` matches the sales-page UUID, `value = 1000.00` (not
   100000), `currency = 'BRL'`, `meta_response_ok = 1` (if Meta creds
   set).
7. Fire a refund from Kiwify. Confirm the adapter acknowledges with
   200 but does NOT fire a second Meta event.
8. Hit `/webhook/kiwify/wrong-slug` directly — expect 404.
