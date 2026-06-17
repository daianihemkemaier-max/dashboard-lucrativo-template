---
name: deploy-stack
description: First-time bootstrap of the tracking stack into a recipient's Cloudflare account. Use when the recipient says "set this up", "deploy this", "I just downloaded this", "first-time setup", "get this running", "install", "configure", or when the repo looks freshly unpacked (no wrangler.toml, .dev.vars missing, no prior deployment). Hybrid flow: wrangler only for D1 (create, bind config, migrations); the recipient creates the Cloudflare Pages project manually in the dashboard, connects it to a new private GitHub repo, binds the D1 manually, and sets env vars manually. Generates slugs and the DASH_KEY locally. Creates the GitHub repo via `gh` CLI and pushes.
---

# Skill: deploy-stack

You are helping a recipient deploy this tracking stack into their own Cloudflare account for the first time. The recipient is almost certainly a non-developer. Talk to them plainly, explain *why* each step matters in one sentence, and don't dump raw command output on them — summarize.

This skill runs once per recipient. When it's done, they should have:
- A **private GitHub repo** containing the stack code on `main`
- A **Cloudflare Pages project** connected to that repo (production branch = `main`)
- A **D1 database** created and bound to the Pages project (binding name = `DB`)
- All **required env vars** set in the Pages project via the Cloudflare dashboard

The deployment model is hybrid by design:
- **wrangler** is used **only** for D1 (login, database create, migrations) and to generate `wrangler.toml` for local development.
- **git** drives page deploys — a push to `main` triggers Cloudflare Pages to redeploy automatically.
- **The recipient** does the manual connective work in the Cloudflare dashboard: creates the Pages project, binds the D1, adds env vars. This preserves the recipient's control over their infrastructure and keeps the skill from silently running one-shot CLI commands that are hard to reason about or reverse.

The next step for them after this skill is the `verify-tracking` skill — but only after they have at least one page deployed (call `add-page` first).

## Before you start

Confirm with the recipient:
1. They have a Cloudflare account (free tier is fine).
2. They have a GitHub account and `gh` CLI authenticated. Run `gh auth status` to verify. If missing or unauthenticated, tell them to install (`brew install gh` on macOS, or follow [cli.github.com](https://cli.github.com)) and run `gh auth login`.
3. `wrangler` is reachable via `npx wrangler@latest --version`. Node/npm must be installed; if missing, stop and point at [nodejs.org](https://nodejs.org). Global install of wrangler is not required — `npx wrangler@latest` works in both cases and is the form used throughout this skill.
4. The repo is a git repository (`.git/` exists in the project root). The template ships as one; if the recipient somehow unpacked it without, run `git init && git add -A && git commit -m "Initial import of tracking stack template"` before Step 7.

## Step 1 — Login to Cloudflare

```bash
npx wrangler@latest login
```

This opens their browser. Wait for them to confirm "Allow" in the Cloudflare dashboard. When wrangler prints "Successfully logged in", move on.

## Step 2 — Pick a project name

Ask: "What should we call this tracking project? It becomes part of three things at once — your public URL (`<name>.pages.dev`), your D1 database (`<name>-db`), and your GitHub repo. Use lowercase letters, numbers, hyphens only. Examples: `acme-tracking`, `brand-ads-2026`."

Store the answer as `PROJECT_NAME`. The D1 database will be named `${PROJECT_NAME}-db`.

## Step 3 — Create the D1 database

```bash
npx wrangler@latest d1 create ${PROJECT_NAME}-db
```

**Parse the output carefully.** Wrangler prints a snippet including `database_id = "..."` on success. Extract that UUID — you'll use it in the next step.

If creation fails with "already exists", run:

```bash
npx wrangler@latest d1 list
```

...find the matching row, use its `database_id`, and tell the recipient you're reusing the existing database.

## Step 4 — Write `wrangler.toml` from the template

Read `wrangler.toml.example` and substitute:
- `__REPLACE_ME_PROJECT_NAME__` → `PROJECT_NAME` from Step 2
- `__REPLACE_ME_DB_NAME__` → `${PROJECT_NAME}-db`
- `__REPLACE_ME_DB_ID__` → the UUID from Step 3

Write the result to `wrangler.toml`. This file is gitignored; it stays local.

**Important context for the recipient**: Cloudflare Pages with a git integration does NOT read this `wrangler.toml` at deploy time. The file exists so that (a) `wrangler d1 migrations apply` can find the database, and (b) `wrangler pages dev` works for local development. The production D1 binding will be configured manually via the Cloudflare dashboard in Step 9.

## Step 5 — Apply migrations

```bash
npx wrangler@latest d1 migrations apply ${PROJECT_NAME}-db --remote
```

You should see all migrations applied successfully (numbered 0001-00XX with 0005 intentionally missing). If any migration fails, stop and investigate — do not try to work around it. Likely causes: stale local wrangler state, network timeout, or a schema conflict if they reused an existing database with data in it.

## Step 6 — Generate local secrets

Three values don't come from any external service — you generate them locally and print them to the recipient at the handoff.

**Always generate**:

```bash
DASH_KEY=$(openssl rand -hex 32)
```

`DASH_KEY` gates `/dash` and the read-only `/api/*` endpoints. Tell the recipient to save it in a password manager — it's the only way to open the dashboard.

**Sales-platform webhook slugs** — ask: "Which sales platforms will you use — Eduzz, Hotmart, Kiwify, none of those, or not sure yet?"

For each YES, generate a UUID:

```bash
EDUZZ_SLUG=$(uuidgen | tr '[:upper:]' '[:lower:]')
HOTMART_SLUG=$(uuidgen | tr '[:upper:]' '[:lower:]')
KIWIFY_SLUG=$(uuidgen | tr '[:upper:]' '[:lower:]')
```

These are the only thing standing between a public URL and arbitrary purchase injection, so treat them like secrets. The recipient will paste the corresponding full webhook URL into each platform's dashboard later.

If the recipient has no sales page and no sales platform yet, skip slug generation entirely — they can come back with `add-sales-platform` when they need one.

Keep every generated value in your context — Step 10 lists them back to the recipient as part of the env-var checklist.

## Step 7 — Create the GitHub repo and push

Ask the recipient: "Should the repo be **private** (recommended — Cloudflare Pages connects to private repos via its GitHub App without extra steps) or **public**?"

Default to private unless they say otherwise.

Confirm there's nothing embarrassing to push (run `git status` — the template's `.gitignore` already covers `wrangler.toml`, `.dev.vars`, and `.env*`; nothing with real secrets should be staged).

If the repo has no remote yet, create it in a single shot:

```bash
GH_USER=$(gh api user -q .login)
gh repo create ${GH_USER}/${PROJECT_NAME} --private --source=. --remote=origin --push
```

(Omit `--private` and pass `--public` if the recipient chose public.)

This creates the repo on GitHub, adds it as `origin`, and pushes `main`. Print the repo URL back: `https://github.com/${GH_USER}/${PROJECT_NAME}`.

If the repo already has an `origin` and uncommitted work, commit first with a sensible message (e.g. `Initial deploy of tracking stack`) and then `git push -u origin main`.

## Step 8 — Manual: create the Cloudflare Pages project

This is the first of four steps the recipient does in their own browser. Walk them through them one at a time; don't overwhelm them with the whole list at once.

Tell them:

> In the Cloudflare dashboard: **Workers & Pages → Create → Pages → Connect to Git**.
>
> 1. If this is your first Pages project, Cloudflare will ask to install its GitHub App on your account — authorize it for the new repo (or for all repos, your call).
> 2. Pick the repo `${GH_USER}/${PROJECT_NAME}`.
> 3. **Project name**: `${PROJECT_NAME}` (must match — it controls the `.pages.dev` subdomain).
> 4. **Production branch**: `main`.
> 5. **Framework preset**: None.
> 6. **Build command**: (leave empty).
> 7. **Build output directory**: `/` (just a forward slash).
>
> Click "Save and Deploy". The first deploy will probably fail or serve a blank page because the D1 binding and env vars aren't set yet. That's expected — the next two steps fix it.

Wait for the recipient to confirm the project was created before moving on. Don't move past this until they say "OK" or "done".

## Step 9 — Manual: bind the D1 database

Tell them:

> In the same Pages project: **Settings → Bindings → Add → D1 database**.
>
> - **Variable name**: `DB` (exactly this — the code reads `env.DB`)
> - **D1 database**: `${PROJECT_NAME}-db`
> - **Apply to**: Production
>
> Save.

If they use Preview deployments and want them to hit the same DB (usually yes for a single-recipient stack), tell them to repeat the binding for Preview.

## Step 10 — Manual: add environment variables

Give the recipient this checklist, prefilled with every value you generated. Tell them:

> In the same Pages project: **Settings → Environment variables → Add variable**. Add each row below under **Production**. Click **Encrypt** on the rows marked 🔒 — once encrypted, the value won't be visible again.

**Required** — the stack won't fire server-side events without these:

| Name | Value | How to get it | Encrypt? |
|---|---|---|---|
| `META_PIXEL_ID` | numeric Pixel ID | Meta Events Manager → your Pixel → top of page | no |
| `META_ACCESS_TOKEN` | long-lived CAPI token | Events Manager → your Pixel → Settings → **Generate access token** | 🔒 |
| `DASH_KEY` | `<the value you generated in Step 6>` | generated above | 🔒 |

**Optional — add only the rows the recipient actually wants now:**

*Meta debugging*:
- `META_TEST_EVENT_CODE` — any code from Events Manager → Test Events. Events with this code land in the Test Events tab (separate pipeline, doesn't affect production attribution).

*Timezone / locale*:
- `TIMEZONE_OFFSET` — default `-03:00` (São Paulo). Set to the recipient's ISO offset (e.g. `-05:00`, `+00:00`) if they're elsewhere. Must match their Google Ads account timezone or conversions get rejected.
- `DEFAULT_COUNTRY_CODE` — default `55` (Brazil). Prepended to local-format phone numbers before hashing for Meta CAPI. Set to `1` (US/CA), `44` (UK), `351` (PT), etc. if audience is primarily there. Skip if Brazilian.

*GA4* (both required together — if either is missing, GA4 silently skips):
- `GA4_MEASUREMENT_ID` — from GA4 Admin → Data Streams → your stream → top right (`G-XXXXXXXXXX`)
- `GA4_API_SECRET` 🔒 — GA4 Admin → Data Streams → your stream → **Measurement Protocol API secrets** → Create

*Google Ads conversion uploads* (all six required together — any missing = integration silently skips):
- `GOOGLE_ADS_CLIENT_ID`
- `GOOGLE_ADS_CLIENT_SECRET` 🔒
- `GOOGLE_ADS_REFRESH_TOKEN` 🔒
- `GOOGLE_ADS_DEVELOPER_TOKEN` 🔒
- `GOOGLE_ADS_CUSTOMER_ID` (format `1234567890`, no hyphens)
- `GOOGLE_ADS_LOGIN_CUSTOMER_ID` (MCC/manager ID; use the same value as `CUSTOMER_ID` if no MCC)

If the recipient doesn't have a developer token yet, tell them it takes a few days to get Google approval and skip for now — can add later.

*Email/messaging automation*:
- `ENCHARGE_API_KEY` 🔒 — from Encharge → Apps → HTTP API
- `MANYCHAT_KEY` 🔒 — from ManyChat → Settings → API → Your API Key

*Meta Ads spend sync* (so `/dash` shows Meta spend, CPA, ROAS):
- `SYNC_SECRET` 🔒 — generate with `openssl rand -hex 32`
- `META_ADS_ACCESS_TOKEN` 🔒 — Meta Marketing API token (system-user recommended; see `docs/ad-spend-sync.md`)
- `META_ADS_ACCOUNT_ID` — ad account ID, digits only, no `act_` prefix

If they set these, remind them they still need to schedule an external cron to hit `/api/sync/meta-ads` hourly. See `docs/ad-spend-sync.md` for three cron-provider walkthroughs.

**Webhook slugs** — add ONLY for the platforms they said they'd use in Step 6. Hand over the full webhook URLs — these are what they paste into each platform's dashboard webhook config.

| Platform | Env var | Value | Webhook URL to paste into the platform dashboard |
|---|---|---|---|
| Eduzz | `EDUZZ_WEBHOOK_SLUG` 🔒 | `<generated UUID>` | `https://${PROJECT_NAME}.pages.dev/webhook/eduzz/<slug>` |
| Hotmart | `HOTMART_WEBHOOK_SLUG` 🔒 | `<generated UUID>` | `https://${PROJECT_NAME}.pages.dev/webhook/hotmart/<slug>` |
| Kiwify | `KIWIFY_WEBHOOK_SLUG` 🔒 | `<generated UUID>` | `https://${PROJECT_NAME}.pages.dev/webhook/kiwify/<slug>` |

Tell the recipient: "These URLs are how each sales platform reaches your stack. Save them in a password manager — if anyone else gets a URL, they can inject fake purchases into your reporting."

Wait for confirmation that all variables are saved before moving on.

## Step 11 — Trigger a redeploy

Env-var and binding changes don't apply to existing deployments. Two ways to redeploy:

- **Preferred**: Cloudflare dashboard → Pages project → **Deployments** tab → find the most recent deployment → **Retry deployment**.
- **Or**: make any commit to `main` and push — Cloudflare auto-deploys on every push.

Wait for the deploy to turn green (~1-2 minutes for this stack). The URL is `https://${PROJECT_NAME}.pages.dev`.

## Step 12 — Report and hand off

Show the recipient a summary:

```
✓ Project:      ${PROJECT_NAME}
✓ Live at:      https://${PROJECT_NAME}.pages.dev
✓ GitHub:       https://github.com/${GH_USER}/${PROJECT_NAME}  (private)
✓ D1:           ${PROJECT_NAME}-db (migrations applied, bound as DB)
✓ Env vars set: <list the ones they configured, not the values>

Dashboard: https://${PROJECT_NAME}.pages.dev/dash/?key=<DASH_KEY>
           (Save DASH_KEY in a password manager — it's the only way in.)

Next steps:
  1. Add your first page — say "add a lead page" or "add a sales page".
  2. After a page is live and you've submitted/visited it once, run "verify tracking".
  3. If you use Meta Ads, configure ad-spend sync — see docs/ad-spend-sync.md.
```

Do NOT suggest running `verify-tracking` immediately. The verify skill needs real traffic in D1 to check anything meaningful — the recipient has to add a page and visit it first.

## Troubleshooting

**`wrangler login` opens the browser but never returns.**
The recipient probably didn't click "Allow" in the Cloudflare dashboard. Ask them to check the browser tab.

**"No account found" or similar after login.**
The Cloudflare account might not be fully activated yet. Tell them to visit [dash.cloudflare.com](https://dash.cloudflare.com) once to accept any pending terms.

**`gh repo create` fails with "repository already exists on this account".**
They probably created it manually earlier. Either delete it in GitHub (if empty and safe to wipe) and retry, or add the existing repo as origin manually: `git remote add origin https://github.com/<user>/<repo>.git && git push -u origin main`.

**`npm install -g wrangler` fails with a permission error.**
Skip it — this skill uses `npx wrangler@latest` throughout, which doesn't need global install.

**Pages deploys, but `/dash/?key=…` returns 401.**
Most likely `DASH_KEY` was pasted with a trailing space or newline. Edit the env var in the dashboard and re-paste carefully.

**Pages deploys, but pages return blank / 404.**
Likely the "Build output directory" was set to something other than `/`. Go to Pages project → Settings → Builds → Configure production deployments and set output to `/`.

**Migrations apply but `sessions` table is empty after visiting a page.**
The D1 binding isn't wired. Re-check Pages → Settings → Bindings: the variable name must be `DB` (exactly), and the database must be `${PROJECT_NAME}-db`. After fixing, retry the deploy.

**The recipient asks "is it working?"**
That's `verify-tracking`'s job. Don't answer yourself — tell them to add a page first (via `add-page`), visit it, and then run `verify-tracking`.
