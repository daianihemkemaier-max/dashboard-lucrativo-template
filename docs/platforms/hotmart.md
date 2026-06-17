# Hotmart

Brazilian platform with international reach. Custom tracking lands under
the `xcod` field. The webhook body is well-structured and v2.0.0 is
stable; the parser below was confirmed against a real `PURCHASE_APPROVED`
capture.

## Identity

- **Webhook endpoint**: `/webhook/hotmart/<HOTMART_WEBHOOK_SLUG>`
- **Adapter file**: `functions/webhook/hotmart/[slug].js`
- **Sandbox availability**: yes — Hotmart has "Ambiente de testes" mode
  per product. Create a sandbox product, point its webhook at the
  staging URL, fire test purchases with fake card numbers.
- **Dashboard URL for webhook config**: Hotmart → Ferramentas → Webhook.

## Endpoint security — obscure URL

Same pattern as Eduzz. `/webhook/hotmart/<slug>` with `<slug>` stored as
`env.HOTMART_WEBHOOK_SLUG`. Wrong slug → 404. Platform-native `hottok`
verification is deliberately deferred to the future `harden-tracking`
skill — Hotmart's `hottok` is a static bearer token, which leaks like an
obscure URL leaks, so adding it alongside the slug doesn't meaningfully
raise the bar for v1.

## The `trk` field

- **URL parameter name on checkout URL**: `xcod`. Hotmart calls this the
  "source code" (SCK) and surfaces it in Analytics under that name.
- **Webhook payload path**: `body.data.purchase.origin.xcod`.
- **Do NOT** use `body.data.purchase.origin.sck` as a fallback for `trk`
  — `sck` is repurposed by this stack to carry UTMs (see below) or, when
  empty, falls through to Hotmart's own traffic-source enum.
- **Character-set**: Hotmart preserves full 36-char UUIDs.

## UTM pass-through (the `sck` merge trick)

Hotmart does NOT forward `utm_*` URL query params on the checkout URL
into the webhook JSON. Only `origin.xcod` and `origin.sck` survive the
checkout round-trip. To recover attribution, the sales page packs the
UTMs into `sck` as a pipe-joined, URL-encoded bundle:

```
?xcod=<trk>&sck=<utm_source>|<utm_medium>|<utm_campaign>|<utm_content>|<utm_term>
```

Each UTM value is `encodeURIComponent`'d before the join so a `|` inside
a UTM value (rare, but possible with auto-populated `utm_content`)
doesn't corrupt parsing. The adapter's `parseSckBundle()` decodes each
part on receipt.

When the sales page has no UTMs on its URL, it skips appending `sck`
entirely and Hotmart fills `origin.sck` with its own traffic-source enum
(`HOTMART_PRODUCT_PAGE`, `HOTMART_CHECKOUT_CART`, etc.). The adapter
detects this by the absence of `|` and returns empty UTMs; `_core.js`
then falls back to `checkout_sessions.utm_*` (what the sales page
persisted at visit time) so attribution still lands in `purchase_log`.

## Payload shape (from real PURCHASE_APPROVED capture)

```json
{
  "id": "22445a52-72ce-47fd-a607-96ff951fcbfc",
  "creation_date": 1771935156138,
  "event": "PURCHASE_APPROVED",
  "version": "2.0.0",
  "data": {
    "product": {
      "id": 5413386,
      "ucode": "50d5cde2-1f92-4b61-a42a-1f287383a7c4",
      "name": "My Product",
      "warranty_date": "2026-03-03T00:00:00Z",
      "has_co_production": false,
      "is_physical_product": false
    },
    "affiliates": [{ "affiliate_code": "", "name": "" }],
    "buyer": {
      "email": "alice@example.com",
      "name": "Alice Silva",
      "first_name": "Alice",
      "last_name": "Silva",
      "address": {
        "city": "São Paulo", "country": "Brasil", "country_iso": "BR",
        "state": "SP", "neighborhood": "…", "zipcode": "…",
        "address": "…", "number": "…", "complement": "…"
      },
      "document": "…",
      "document_type": "CPF"
    },
    "producer": {
      "name": "…", "document": "…", "legal_nature": "…"
    },
    "commissions": [
      { "value": 10.6, "source": "MARKETPLACE", "currency_value": "BRL" },
      { "value": 83.91, "source": "PRODUCER", "currency_value": "BRL" }
    ],
    "purchase": {
      "approved_date": 1771935138000,
      "full_price": { "value": 97, "currency_value": "BRL" },
      "price": { "value": 97, "currency_value": "BRL" },
      "checkout_country": { "name": "Brasil", "iso": "BR" },
      "order_bump": { "is_order_bump": false },
      "origin": {
        "sck": "HOTMART_PRODUCT_PAGE",
        "xcod": "f2d1a9c0-3e8b-4a2e-9c1d-3e7b8f4a2c6d"
      },
      "original_offer_price": { "value": 97, "currency_value": "BRL" },
      "order_date": 1771935084000,
      "status": "APPROVED",
      "transaction": "HP3159595263",
      "payment": {
        "installments_number": 1,
        "type": "PIX",
        "pix_qrcode": "…",
        "pix_code": "…",
        "pix_expiration_date": 1772107885000
      },
      "offer": { "code": "a8wswzvg" },
      "invoice_by": "SELLER",
      "subscription_anticipation_purchase": false,
      "is_funnel": false,
      "business_model": "I"
    }
  }
}
```

| Normalized field | Payload path |
|---|---|
| `trk` | `body.purchase.origin.xcod` |
| `email` | `body.buyer.email` |
| `name` | `body.buyer.name` (or `first_name + " " + last_name`) |
| `phone` | `''` — **not surfaced** in default PURCHASE_APPROVED payload |
| `value` | `body.purchase.price.value` (plain number, already in reais) |
| `currency` | `body.purchase.price.currency_value` (note: `currency_value`, not `currency`) |
| `transactionId` | `body.purchase.transaction` |
| `productId` | `String(body.product.id)` |
| `productName` | `body.product.name` |
| `items[]` | Single-item array synthesized from `body.product` + `body.purchase.price` |
| `platformUtm.utm_*` | Unpacked from `body.purchase.origin.sck` if it contains `\|` (our UTM bundle); otherwise empty, and `_core.js` falls back to `checkout_sessions.utm_*` |

## Paid-sale filter

- **Paid event**: `rawPayload.event === 'PURCHASE_APPROVED'`
- **Status check**: `body.purchase.status === 'APPROVED'`

Hotmart fires separate events for different lifecycle stages:
`PURCHASE_APPROVED`, `PURCHASE_COMPLETE` (product delivered),
`PURCHASE_REFUNDED`, `PURCHASE_CHARGEBACK`, `PURCHASE_DELAYED` (Pix/boleto
pending), `PURCHASE_CANCELED`. Only fire Meta/GA4/Ads on
`PURCHASE_APPROVED`; acknowledge everything else with 200 and skip.

## Known gotchas

- **No phone number on default payload.** `body.buyer` has `email`,
  `name`, `first_name`, `last_name`, `document`, `address` — but no
  `phone` / `mobile` / `checkout_phone`. ManyChat fan-out silently skips
  for Hotmart purchases. If a recipient needs phone for WhatsApp
  automation, they'd need Hotmart to enable a custom-field pass-through
  in their product settings (platform-side config, not ours to fix).
- **`origin.sck` is dual-purpose.** When the sales page passes it, it
  carries our pipe-joined UTM bundle. When we don't, Hotmart fills it
  with a traffic-source enum string like `"HOTMART_PRODUCT_PAGE"` or
  `"HOTMART_CHECKOUT_CART"`. The adapter distinguishes the two by the
  presence of `|`. It never carries the `trk` — that's `xcod` only.
- **`first_name` / `last_name` are pre-split.** Don't re-split `name`
  yourself; use the fields Hotmart provides. (The adapter does.)
- **`product.id` is numeric.** Always stringify before storage — D1's
  `product_id` column is TEXT.
- **Price is a decimal number, not cents.** `97` means R$ 97.00. Do NOT
  divide by 100 like Kiwify requires.
- **Multiple offers per product**: `product.id` is constant across
  offers; use `purchase.offer.code` if per-offer segmentation is needed.
- **Installment sales**: `PURCHASE_APPROVED` fires on the first paid
  installment, then separate events per subsequent installment. Meta
  sees one `Purchase` event at full value — correct for ROAS, may
  surprise recipients comparing Meta revenue to cash flow.
- **Sandbox vs production webhooks**: Hotmart issues webhook config per
  environment. Sandbox test purchases go to the sandbox URL; production
  to the prod URL. Point the right slug at each.

## Verification test

1. Run `deploy-stack`; note the Hotmart webhook URL.
2. Paste it into Hotmart → Ferramentas → Webhook (or the sandbox
   equivalent).
3. Fire a real test purchase (sandbox or 100%-off coupon).
4. Query D1:
   ```
   wrangler d1 execute <db> --remote --command \
     "SELECT transaction_id, trk, value, currency, meta_response_ok, product_id, product_name FROM purchase_log ORDER BY created_at DESC LIMIT 1"
   ```
5. Confirm: non-empty `trk` matching what your sales page generated,
   `value = 97.00`, `currency = 'BRL'`, `meta_response_ok = 1` (if
   Meta creds are set), `product_id` stringified from the numeric
   Hotmart ID.
6. Hit `/webhook/hotmart/wrong-slug` directly — expect 404.
