-- 008: AI Executive Team Tables
-- platform_messages, b2b_leads, email_outreach, keyword_trends, tasks

-- ===== 1. platform_messages (eBay/Alibaba buyer messages) =====
CREATE TABLE IF NOT EXISTS platform_messages (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  platform        TEXT NOT NULL,
  message_id      TEXT NOT NULL,
  thread_id       TEXT,
  direction       TEXT NOT NULL DEFAULT 'inbound',
  sender          TEXT DEFAULT '',
  recipient       TEXT DEFAULT '',
  subject         TEXT DEFAULT '',
  body            TEXT DEFAULT '',
  item_id         TEXT,
  order_id        TEXT,
  sku             TEXT,
  category        TEXT DEFAULT 'general',
  language        TEXT DEFAULT 'en',
  status          TEXT DEFAULT 'new',
  draft_reply     TEXT DEFAULT '',
  approved_reply  TEXT,
  replied_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(platform, message_id)
);

CREATE INDEX IF NOT EXISTS idx_pm_status ON platform_messages(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pm_platform ON platform_messages(platform, created_at DESC);

CREATE TRIGGER trg_pm_updated BEFORE UPDATE ON platform_messages
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ===== 2. b2b_leads (sales pipeline) =====
CREATE TABLE IF NOT EXISTS b2b_leads (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  source          TEXT DEFAULT 'manual',
  company_name    TEXT DEFAULT '',
  contact_name    TEXT DEFAULT '',
  email           TEXT DEFAULT '',
  phone           TEXT DEFAULT '',
  country         TEXT DEFAULT '',
  platform        TEXT DEFAULT '',
  interest        TEXT DEFAULT '',
  stage           TEXT DEFAULT 'new',
  score           INTEGER DEFAULT 0,
  last_contacted  TIMESTAMPTZ,
  next_follow_up  TIMESTAMPTZ,
  notes           TEXT DEFAULT '',
  buyer_id        TEXT,
  tags            TEXT[] DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bl_stage ON b2b_leads(stage);
CREATE INDEX IF NOT EXISTS idx_bl_followup ON b2b_leads(next_follow_up) WHERE next_follow_up IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bl_email ON b2b_leads(email) WHERE email != '';

CREATE TRIGGER trg_bl_updated BEFORE UPDATE ON b2b_leads
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ===== 3. email_outreach (all outbound emails) =====
CREATE TABLE IF NOT EXISTS email_outreach (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  lead_id         UUID,
  buyer_id        TEXT,
  type            TEXT NOT NULL,
  to_email        TEXT NOT NULL,
  subject         TEXT NOT NULL,
  body_html       TEXT DEFAULT '',
  body_text       TEXT DEFAULT '',
  status          TEXT DEFAULT 'draft',
  resend_id       TEXT,
  sent_at         TIMESTAMPTZ,
  opened_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_eo_status ON email_outreach(status);
CREATE INDEX IF NOT EXISTS idx_eo_type ON email_outreach(type, created_at DESC);

-- ===== 4. keyword_trends =====
CREATE TABLE IF NOT EXISTS keyword_trends (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  keyword         TEXT NOT NULL,
  platform        TEXT NOT NULL,
  category        TEXT DEFAULT '',
  search_volume   INTEGER DEFAULT 0,
  trend_direction TEXT DEFAULT 'stable',
  competition     TEXT DEFAULT 'medium',
  our_coverage    BOOLEAN DEFAULT false,
  related_skus    TEXT[] DEFAULT '{}',
  data_source     TEXT DEFAULT '',
  tracked_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kt_keyword ON keyword_trends(keyword, platform);
CREATE INDEX IF NOT EXISTS idx_kt_trend ON keyword_trends(trend_direction, tracked_at DESC);

-- ===== 5. tasks (employee assignments) =====
CREATE TABLE IF NOT EXISTS tasks (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  title           TEXT NOT NULL,
  description     TEXT DEFAULT '',
  assigned_to     TEXT DEFAULT '',
  created_by      TEXT DEFAULT 'system',
  category        TEXT DEFAULT 'general',
  priority        TEXT DEFAULT 'medium',
  status          TEXT DEFAULT 'pending',
  due_date        DATE,
  related_sku     TEXT,
  related_order   TEXT,
  agent_recommendation_id UUID,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, priority);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to, status);

CREATE TRIGGER trg_tasks_updated BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ===== RLS =====
ALTER TABLE platform_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE b2b_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_outreach ENABLE ROW LEVEL SECURITY;
ALTER TABLE keyword_trends ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY service_all_platform_messages ON platform_messages FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY service_all_b2b_leads ON b2b_leads FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY service_all_email_outreach ON email_outreach FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY service_all_keyword_trends ON keyword_trends FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY service_all_tasks ON tasks FOR ALL TO service_role USING (true) WITH CHECK (true);
