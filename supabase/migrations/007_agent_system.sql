-- 007: Agent System Tables
-- agent_recommendations, agent_alerts, agent_audit_logs

-- ===== agent_recommendations =====
CREATE TABLE IF NOT EXISTS agent_recommendations (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_name        TEXT NOT NULL,
  type              TEXT NOT NULL,
  sku               TEXT,
  platform          TEXT,
  priority          TEXT DEFAULT 'medium',
  current_value     JSONB DEFAULT '{}'::jsonb,
  recommended_value JSONB DEFAULT '{}'::jsonb,
  reason            TEXT DEFAULT '',
  confidence        NUMERIC(3,2) DEFAULT 0.50,
  status            TEXT DEFAULT 'pending',
  approved_by       TEXT,
  executed_at       TIMESTAMPTZ,
  execution_result  JSONB DEFAULT '{}'::jsonb,
  expires_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ar_status ON agent_recommendations(status);
CREATE INDEX IF NOT EXISTS idx_ar_agent ON agent_recommendations(agent_name);
CREATE INDEX IF NOT EXISTS idx_ar_sku ON agent_recommendations(sku) WHERE sku IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ar_priority ON agent_recommendations(priority, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ar_pending ON agent_recommendations(status, created_at DESC) WHERE status = 'pending';

CREATE TRIGGER trg_ar_updated BEFORE UPDATE ON agent_recommendations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ===== agent_alerts =====
CREATE TABLE IF NOT EXISTS agent_alerts (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_name    TEXT NOT NULL,
  type          TEXT NOT NULL,
  severity      TEXT DEFAULT 'warning',
  title         TEXT NOT NULL,
  message       TEXT DEFAULT '',
  sku           TEXT,
  platform      TEXT,
  context_data  JSONB DEFAULT '{}'::jsonb,
  is_read       BOOLEAN DEFAULT false,
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_aa_unread ON agent_alerts(is_read, created_at DESC) WHERE NOT is_read;
CREATE INDEX IF NOT EXISTS idx_aa_severity ON agent_alerts(severity, created_at DESC);

-- ===== agent_audit_logs =====
CREATE TABLE IF NOT EXISTS agent_audit_logs (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_name    TEXT NOT NULL,
  action_type   TEXT NOT NULL,
  sku           TEXT,
  platform      TEXT,
  decision      TEXT DEFAULT '',
  reason        TEXT DEFAULT '',
  confidence    NUMERIC(3,2),
  input_data    JSONB DEFAULT '{}'::jsonb,
  output_data   JSONB DEFAULT '{}'::jsonb,
  result        TEXT DEFAULT 'success',
  duration_ms   INTEGER DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_al_agent ON agent_audit_logs(agent_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_al_action ON agent_audit_logs(action_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_al_sku ON agent_audit_logs(sku) WHERE sku IS NOT NULL;

-- ===== RLS =====
ALTER TABLE agent_recommendations ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY service_all_agent_recommendations ON agent_recommendations
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY service_all_agent_alerts ON agent_alerts
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY service_all_agent_audit_logs ON agent_audit_logs
  FOR ALL TO service_role USING (true) WITH CHECK (true);
