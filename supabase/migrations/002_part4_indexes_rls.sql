CREATE INDEX IF NOT EXISTS idx_orders_order_no ON orders(order_no);
CREATE INDEX IF NOT EXISTS idx_orders_platform ON orders(platform);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_date ON orders(order_date DESC);
CREATE INDEX IF NOT EXISTS idx_orders_sku ON orders(sku);
CREATE INDEX IF NOT EXISTS idx_b2b_buyers_buyer_id ON b2b_buyers(buyer_id);
CREATE INDEX IF NOT EXISTS idx_b2b_invoices_no ON b2b_invoices(invoice_no);
CREATE INDEX IF NOT EXISTS idx_b2b_invoices_buyer ON b2b_invoices(buyer_id);
CREATE INDEX IF NOT EXISTS idx_b2b_invoices_status ON b2b_invoices(status);
CREATE INDEX IF NOT EXISTS idx_sku_scores_sku ON sku_scores(sku);
CREATE INDEX IF NOT EXISTS idx_sku_scores_class ON sku_scores(classification);
CREATE INDEX IF NOT EXISTS idx_sku_scores_norm ON sku_scores(normalized_score DESC);
CREATE INDEX IF NOT EXISTS idx_score_history_sku_date ON sku_score_history(sku, date DESC);
CREATE INDEX IF NOT EXISTS idx_price_history_sku_date ON price_history(sku, date DESC);
CREATE INDEX IF NOT EXISTS idx_price_history_platform ON price_history(sku, platform);
CREATE INDEX IF NOT EXISTS idx_sync_history_platform ON sync_history(platform);
CREATE INDEX IF NOT EXISTS idx_sync_history_created ON sync_history(created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_orders_updated') THEN
    CREATE TRIGGER trg_orders_updated BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_b2b_buyers_updated') THEN
    CREATE TRIGGER trg_b2b_buyers_updated BEFORE UPDATE ON b2b_buyers FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_b2b_invoices_updated') THEN
    CREATE TRIGGER trg_b2b_invoices_updated BEFORE UPDATE ON b2b_invoices FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_sku_scores_updated') THEN
    CREATE TRIGGER trg_sku_scores_updated BEFORE UPDATE ON sku_scores FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END
$$;

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE b2b_buyers ENABLE ROW LEVEL SECURITY;
ALTER TABLE b2b_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE sku_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE sku_score_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_all" ON orders FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_all" ON b2b_buyers FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_all" ON b2b_invoices FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_all" ON sku_scores FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_all" ON sku_score_history FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_all" ON price_history FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_all" ON sync_history FOR ALL USING (true) WITH CHECK (true);
