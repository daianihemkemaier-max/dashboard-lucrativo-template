-- Freeze utm_campaign/utm_content onto each event_log row at insert time,
-- same as purchase_log already does. Before this, the Campanhas page
-- funnel numbers (Vis. Página / Checkouts per campaign/anúncio) were
-- computed by joining event_log to the *current* sessions row — since
-- sessions.utm_campaign gets overwritten on every new visit, a returning
-- visitor who came back via a different campaign silently reattributed
-- all of their earlier PageView/InitiateCheckout events to the new one.
ALTER TABLE event_log ADD COLUMN utm_campaign TEXT DEFAULT '';
ALTER TABLE event_log ADD COLUMN utm_content TEXT DEFAULT '';
