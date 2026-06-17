# Platform template

Use this as the starting shape when documenting a new sales platform.
Copy this file to `docs/platforms/<platform>.md` and fill in each
section. The `add-sales-platform` skill walks through populating it.

Every adapter is thin: gate on the URL slug, parse the platform's
payload into the normalized shape, delegate to `_core.js`. This doc
captures the parts that differ per platform.

---

## Identity

- **Platform name**: e.g. "ExamplePay".
- **Webhook endpoint**: `/webhook/<platform>/<SLUG>` — keep lowercase,
  no dashes unless the platform name really has one.
- **Adapter file**: `functions/webhook/<platform>/[slug].js`.
- **Sandbox availability**: yes / no. If no, document how the recipient
  triggers a test purchase (100%-off coupon, paused live product, etc.).

## Endpoint security — obscure URL

All adapters share the same gate: an unguessable 36-character UUID v4
stored as `env.<PLATFORM>_WEBHOOK_SLUG`. The adapter compares the slug
from the URL path (`context.params.slug`) against the env var via
`guardSlug()` from `functions/webhook/_utils.js`. Wrong slug → 404,
indistinguishable from a nonexistent route.

Platform-native signature schemes (HMAC, static bearer tokens, JWT) are
deliberately NOT verified in v1. If the platform offers one, document
it here for the future `harden-tracking` skill to pick up:

- **Signature header name**:
- **Algorithm** (HMAC-SHA256 hex, HMAC-SHA1 hex, static token, etc.):
- **What is signed** (raw body, specific fields, query string, etc.):
- **Recipient dashboard path for the signing secret**:

## The `trk` field

- **URL parameter name on checkout URL**: the field the sales page
  appends (e.g. `trk`, `xcod`, `sck`, `custom1`).
- **Webhook payload field path**: where that value appears in the
  incoming JSON (e.g. `body.tracker.code1`, `body.order.TrackingParameters.sck`).
- **Character-set constraints**: does the platform mangle the value?
  Most strip characters or truncate at some length. Test with a 36-char
  UUID; if it comes back chopped, document the safe length.

## Payload shape

Paste a real (sanitized) webhook body here. This is the single most
useful thing in the platform doc — the adapter's parser is grown
directly from it.

```json
{
  "event": "…",
  "data": { "…": "…" }
}
```

Annotate the fields that map to the normalized shape:

| Normalized field | Payload path |
|---|---|
| `trk` | `body.???` |
| `email` | `body.???` |
| `name` | `body.???` |
| `phone` | `body.???` (or `''` if the platform doesn't provide it) |
| `value` | `body.???` — note whether it's decimal, cents-int, or cents-string |
| `currency` | `body.???` |
| `transactionId` | `body.???` |
| `productId` | `body.???` (stringify if numeric) |
| `productName` | `body.???` |
| `items[]` | `body.???` (or single-item synthesized from `productId`+`productName`+`value`) |
| `platformUtm.utm_source` | `body.???` — or `''` if the platform doesn't carry UTMs |

## Paid-sale filter

Platforms send webhooks for pending, approved, refunded, chargeback,
etc. Only process the "paid" one; acknowledge the rest with 200 so the
platform stops retrying.

- **Paid status value(s)**: e.g. `'paid'`, `'PURCHASE_APPROVED'`,
  `'order_approved'`.
- **Status field path(s)**: e.g. `body.status`, `body.event`,
  `body.order.order_status`.
- **Other statuses the platform fires** (to acknowledge-and-skip):

## Known gotchas

- Anything the platform's documentation lies about.
- Rate limits.
- Retry behavior (how often, for how long, with what backoff).
- Quirks like "value comes in cents for some products, reais for
  others", "field names differ between v1 and v2 webhooks", "no phone
  by default, must enable in dashboard".
- Anything that took debugging to figure out the first time.

## Verification test

1. Run `deploy-stack` (or the add-sales-platform skill if this is a new
   platform added post-setup); note the webhook URL printed.
2. Paste the URL into the platform's webhook configuration.
3. Fire a real test purchase (sandbox or 100%-off coupon).
4. Query `purchase_log` for the new row. Confirm normalized fields
   landed correctly:
   ```
   wrangler d1 execute <db> --remote --command \
     "SELECT transaction_id, trk, value, currency, meta_response_ok FROM purchase_log ORDER BY created_at DESC LIMIT 1"
   ```
5. Hit `/webhook/<platform>/wrong-slug` directly — expect 404.

Document the exact commands above so the recipient can repeat them
after any future platform-side API change.
