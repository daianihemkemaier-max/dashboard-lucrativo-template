-- Add adset columns to ad_spend so Meta sync can pull at adset level.
-- After applying this migration, trigger a fresh Meta sync so the table
-- gets repopulated with adset-level rows. Old campaign-level rows (where
-- adset_id IS NULL) continue to aggregate correctly because the campaign
-- summary query groups by campaign_id regardless of adset_id.
ALTER TABLE ad_spend ADD COLUMN adset_id TEXT;
ALTER TABLE ad_spend ADD COLUMN adset_name TEXT;

-- Rebuild unique index to allow one row per (platform, date, campaign, adset, ad).
DROP INDEX IF EXISTS idx_ad_spend_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ad_spend_unique
  ON ad_spend(platform, date, campaign_id, COALESCE(adset_id, ''), COALESCE(ad_id, ''));
