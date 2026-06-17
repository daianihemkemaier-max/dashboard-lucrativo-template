# Ad spend sync — Meta Ads

The dashboard's paid-traffic attribution card shows CPA and ROAS only when
Meta spend data is present in D1. This guide walks through the one-time
setup to connect Meta Marketing API and schedule hourly syncs.

Google Ads spend sync arrives in v1.1 — until then the Google column shows
attributed revenue only (purchases with a gclid on the originating session)
without spend / CPA / ROAS.

---

## What the sync does

```
external cron (hourly)
     │
     ▼
POST /api/sync/meta-ads     ← this endpoint, in your deployment
     │ (guarded by x-sync-secret header)
     ▼
Meta Marketing API          ← pulls campaign-level insights
     │
     ▼
D1 ad_spend table           ← UPSERT by (platform, date, campaign_id)
```

The dashboard queries `ad_spend` directly; it never calls Meta during a page
load. That keeps dashboard load times fast and isolates the operator view
from Meta API rate limits.

If the sync cron breaks for a few hours, the dashboard still renders — it
just shows older spend. The dashboard card surfaces the last successful sync
timestamp so you can tell at a glance whether the data is stale.

---

## One-time configuration

### 1. Get a Meta Marketing API access token

You need a token with the `ads_read` permission for the ad account whose
spend you want to track. The easiest way:

1. Go to https://business.facebook.com/settings/system-users
2. Create a system user (if you don't already have one) with
   **Employee** access.
3. Click **Generate new token** for that system user.
4. Select your app (any Meta app you own works, or create a minimal one
   under https://developers.facebook.com/apps).
5. Check the `ads_read` permission.
6. Set token expiration to **Never** (system user tokens can be non-expiring).
7. Copy the generated token — you will only see it once.

System user tokens don't expire and don't require refresh logic. This is the
right token type for server-side syncs.

### 2. Find your ad account ID

1. Go to https://business.facebook.com/adsmanager
2. Look at the URL — it contains `act=1234567890`
3. Copy just the number (no `act_` prefix)

### 3. Set the three required environment variables

In the Cloudflare dashboard → your Pages project → **Settings →
Environment variables → Add variable** (set each under Production,
click **Encrypt** 🔒 on all three since they're sensitive):

| Name | Value |
|---|---|
| `META_ADS_ACCESS_TOKEN` 🔒 | the token from step 1 |
| `META_ADS_ACCOUNT_ID` | the ID from step 2 (digits only, no `act_` prefix) |
| `SYNC_SECRET` 🔒 | a random string, e.g. `openssl rand -hex 32` — this gates `/api/sync/meta-ads`; only requests with a matching `x-sync-secret` header are accepted |

Env-var changes don't apply to existing deployments — trigger a redeploy:
either Cloudflare dashboard → **Deployments** → **Retry deployment** on
the latest build, or push any commit to `main`.

### 4. Verify the endpoint works

Manually trigger a sync to confirm everything is wired up:

```bash
curl -X POST https://your-deployment.pages.dev/api/sync/meta-ads \
  -H "x-sync-secret: <YOUR_SYNC_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"date_from":"2026-04-01","date_to":"2026-04-14"}'
```

A healthy response looks like:

```json
{
  "ok": true,
  "rows_upserted": 42,
  "duration_ms": 1183,
  "date_from": "2026-04-01",
  "date_to": "2026-04-14"
}
```

If you get `{"error":"Unauthorized"}`, the `x-sync-secret` header doesn't
match `SYNC_SECRET`. If you get `{"ok":true,"skipped":true,...}`, the Meta
token or account ID isn't set. If you get `{"ok":false,"error":"Meta API 400..."}`,
the token is invalid or missing the `ads_read` permission.

### 5. Schedule hourly syncs

Pick any cron provider that can POST a request with custom headers on a
schedule. Three free options, in order of recipient-friendliness:

**cron-job.org** (recommended for first-time users)
1. Create a free account at https://cron-job.org
2. Create a new cron job pointing at
   `https://your-deployment.pages.dev/api/sync/meta-ads`
3. Set the schedule: every hour, at minute 0
4. Under **Advanced → Request method**: POST
5. Under **Advanced → Request headers**, add:
   - Name: `x-sync-secret`
   - Value: your SYNC_SECRET value
   - Name: `Content-Type`
   - Value: `application/json`
6. Under **Advanced → Request body**: leave empty (the endpoint defaults
   to the last 7 days, which is what you want for hourly re-fetches).
7. Save. Click the **Run now** button to test.

**GitHub Actions** (if you already use GitHub)

Create `.github/workflows/sync-meta-ads.yml` in any repo you own:

```yaml
name: Sync Meta Ads spend
on:
  schedule:
    - cron: '0 * * * *'
  workflow_dispatch:

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - name: POST to sync endpoint
        run: |
          curl -X POST ${{ secrets.SYNC_URL }} \
            -H "x-sync-secret: ${{ secrets.SYNC_SECRET }}" \
            -H "Content-Type: application/json" \
            -d '{}'
```

Then add `SYNC_URL` and `SYNC_SECRET` to the repo secrets.

**EasyCron / Upstash Scheduler / any other provider**

Same pattern: schedule a POST request with the `x-sync-secret` header set.

### 6. Check the dashboard

Open `/dash` in your deployment. The paid-traffic attribution card should
now show Meta spend, CPA, and ROAS alongside the attribution counts. The
"last sync" timestamp under the section header should update within an
hour of scheduling the cron.

---

## Troubleshooting

**The endpoint returns 200 but spend_cents never populates.**
Meta Marketing API returns an empty `data` array for time ranges with no
spend. Check the ad account actually had activity in your requested window.

**The dashboard shows stale spend data.**
Look at the "last sync" timestamp next to the paid-traffic section. If
it's more than an hour old, your cron provider stopped firing — check its
log. If it's recent but the numbers still look wrong, run a manual sync
with a wider date range and confirm the `rows_upserted` count is growing.

**The sync was working and suddenly returns 400 errors.**
Most common cause: system user tokens can be invalidated if the system
user is deleted, the app is deleted, or the ad account access is revoked.
Generate a new token following step 1 and update the secret.

**I don't see any spend at all in the dashboard.**
Check `sync_log` directly:

```bash
wrangler d1 execute <your-db-name> --remote --command \
  "SELECT platform, status, rows_upserted, run_at, error_message FROM sync_log ORDER BY run_at DESC LIMIT 10"
```

If you see `status = 'error'`, the `error_message` column has the reason.
If you see no rows at all, the cron isn't firing — check the provider's
own log or trigger a manual run.

**I want to sync a wider historical window (e.g. last 90 days).**

```bash
curl -X POST https://your-deployment.pages.dev/api/sync/meta-ads \
  -H "x-sync-secret: <SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"date_from":"2026-01-14","date_to":"2026-04-14"}'
```

This is safe to run repeatedly — the upsert uses
`(platform, date, campaign_id)` as the unique key, so re-syncing the same
window replaces existing rows rather than duplicating them.
