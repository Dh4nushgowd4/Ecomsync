-- =============================================================================
-- EcomSync — Supabase/Postgres Initial Schema Migration
-- Run via: supabase db push  OR  paste into Supabase SQL editor
-- =============================================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =============================================================================
-- TABLE: products
-- Core product catalogue. base_quantity is the "ground truth" stock level.
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.products (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  sku           TEXT         NOT NULL UNIQUE,
  name          TEXT         NOT NULL,
  base_quantity INTEGER      NOT NULL DEFAULT 0 CHECK (base_quantity >= 0),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  public.products IS 'Master product catalogue with SKU and ground-truth stock quantity.';
COMMENT ON COLUMN public.products.sku           IS 'Unique stock-keeping unit identifier across all channels.';
COMMENT ON COLUMN public.products.base_quantity IS 'Canonical quantity; channels may diverge temporarily during sync.';

-- =============================================================================
-- TABLE: channels
-- Represents an individual sales channel (Shopify, Amazon, eBay, etc.)
-- config stores channel-specific credentials/settings as JSONB.
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.channels (
  id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT         NOT NULL UNIQUE CHECK (name IN ('shopify', 'amazon', 'ebay', 'walmart', 'etsy')),
  config     JSONB        NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  public.channels IS 'Sales channel registry with per-channel JSONB configuration.';
COMMENT ON COLUMN public.channels.name   IS 'Channel identifier: shopify | amazon | ebay | walmart | etsy';
COMMENT ON COLUMN public.channels.config IS 'Stores API keys, webhook secrets, rate limits, etc. (encrypted at rest by Supabase Vault in prod).';

-- =============================================================================
-- TABLE: channel_inventory
-- Per-channel quantity view with optimistic concurrency via version column.
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.channel_inventory (
  product_id     UUID         NOT NULL REFERENCES public.products(id)  ON DELETE CASCADE,
  channel_id     UUID         NOT NULL REFERENCES public.channels(id)  ON DELETE CASCADE,
  quantity       INTEGER      NOT NULL DEFAULT 0,
  last_synced_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  version        INTEGER      NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, channel_id)
);

COMMENT ON TABLE  public.channel_inventory IS 'Per-channel quantity with optimistic concurrency control (version column).';
COMMENT ON COLUMN public.channel_inventory.version IS 'Incremented on every mutation; callers must send the version they read to prevent lost updates.';

-- Index: frequent lookup by product across channels
CREATE INDEX IF NOT EXISTS idx_channel_inventory_product_id ON public.channel_inventory (product_id);
-- Index: lookup by channel for channel-health queries
CREATE INDEX IF NOT EXISTS idx_channel_inventory_channel_id ON public.channel_inventory (channel_id);

-- =============================================================================
-- TABLE: sync_events
-- Append-only audit log of every inventory mutation attempt.
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.sync_events (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id         UUID         NOT NULL REFERENCES public.products(id)  ON DELETE CASCADE,
  channel_id         UUID         NOT NULL REFERENCES public.channels(id)  ON DELETE CASCADE,
  delta              INTEGER      NOT NULL,                    -- positive = stock in, negative = sold/removed
  resulting_quantity INTEGER      NOT NULL,
  status             TEXT         NOT NULL CHECK (status IN ('success', 'failure', 'partial', 'retrying')),
  error              TEXT,                                     -- error message / stack if status = 'failure'
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  public.sync_events IS 'Append-only audit log of every inventory delta applied per channel.';
COMMENT ON COLUMN public.sync_events.delta              IS 'Signed quantity change: negative for sales, positive for restocks.';
COMMENT ON COLUMN public.sync_events.resulting_quantity IS 'Channel quantity after the delta was applied.';
COMMENT ON COLUMN public.sync_events.status             IS 'success | failure | partial | retrying';

-- Index: look up recent events by product for anomaly scanning
CREATE INDEX IF NOT EXISTS idx_sync_events_product_created ON public.sync_events (product_id, created_at DESC);
-- Index: look up events by channel for channel-health queries
CREATE INDEX IF NOT EXISTS idx_sync_events_channel_created ON public.sync_events (channel_id, created_at DESC);
-- Index: look up failures quickly
CREATE INDEX IF NOT EXISTS idx_sync_events_status          ON public.sync_events (status) WHERE status != 'success';

-- =============================================================================
-- ROW LEVEL SECURITY
-- All tables are locked down by default; server-side code uses the service role
-- key which bypasses RLS. The anon/authenticated keys are scoped for a future
-- multi-tenant UI where each user only sees their own data.
-- =============================================================================

ALTER TABLE public.products          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channels          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_events       ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------
-- products: authenticated users can read; only service role can mutate
-- -----------------------------------------------------------------------
CREATE POLICY "products_select_authenticated"
  ON public.products
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "products_all_service_role"
  ON public.products
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- -----------------------------------------------------------------------
-- channels: same pattern — read for authenticated, full for service role
-- -----------------------------------------------------------------------
CREATE POLICY "channels_select_authenticated"
  ON public.channels
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "channels_all_service_role"
  ON public.channels
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- -----------------------------------------------------------------------
-- channel_inventory: read for authenticated, full for service role
-- -----------------------------------------------------------------------
CREATE POLICY "channel_inventory_select_authenticated"
  ON public.channel_inventory
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "channel_inventory_all_service_role"
  ON public.channel_inventory
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- -----------------------------------------------------------------------
-- sync_events: read for authenticated (audit trail), full for service role
-- -----------------------------------------------------------------------
CREATE POLICY "sync_events_select_authenticated"
  ON public.sync_events
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "sync_events_all_service_role"
  ON public.sync_events
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- =============================================================================
-- HELPER VIEWS
-- =============================================================================

-- Denormalized view for the dashboard — avoids N+1 joins on the frontend
CREATE OR REPLACE VIEW public.inventory_dashboard AS
  SELECT
    p.id          AS product_id,
    p.sku,
    p.name,
    p.base_quantity,
    c.id          AS channel_id,
    c.name        AS channel_name,
    ci.quantity   AS channel_quantity,
    ci.last_synced_at,
    ci.version
  FROM public.products         p
  JOIN public.channel_inventory ci ON ci.product_id = p.id
  JOIN public.channels           c  ON c.id = ci.channel_id
  ORDER BY p.sku, c.name;

COMMENT ON VIEW public.inventory_dashboard IS 'Flat denormalized view for dashboard queries; read-only.';
