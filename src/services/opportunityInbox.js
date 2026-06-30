/**
 * src/services/opportunityInbox.js — Opportunity Inbox service (PR R0)
 *
 * 역할:
 *   직원/알바가 발견한 상품 후보 / 콘텐츠 소재 / 경쟁셀러 / 번개장터·마트 소싱 /
 *   Qoo10·Shopify·Alibaba 등록 후보 / Proxy Shipping 문제 등을 통합 inbox 로 관리.
 *
 * 정책:
 *   - 외부 API 호출 0 (eBay/Shopify/Telegram/Kakao/Alibaba 등)
 *   - AI 호출 0 / 가격 크롤링 0 / 플랫폼 등록 0
 *   - allowlist 기반 검증 (opportunity_type / source_type / input_channel /
 *     status / priority / estimated_demand / target_platforms[] / PLATFORMS)
 *   - linked_sku_id / linked_order_id / linked_task_id 는 존재 여부 사전 확인
 *   - secret/token/password/raw_payload 저장·로그 출력 금지
 *   - metadata stringify 5000자 cap
 *
 * 권한:
 *   - 직원: 본인 후보 / 본인 assigned 후보 조회 + 본인 후보의 notes 등 일부 수정
 *   - admin: 전체 조회 / 상태 변경 / approve / reject
 *   - require* 가드는 route 단에서 적용; 본 service 는 user 객체로 권한 분기
 */
'use strict';

const crypto = require('crypto');
const { getClient } = require('../db/supabaseClient');

// ──────────────────────────────────────────────────────────────────────────
// Allowlists (사장님 spec)
// ──────────────────────────────────────────────────────────────────────────
const OPPORTUNITY_TYPES = new Set([
  'product_sourcing',
  'content_idea',
  'competitor_product',
  'b2b_buyer',
  'qoo10_candidate',
  'shopee_candidate',
  'shopify_candidate',
  'alibaba_candidate',
  'proxy_shipping_issue',
  'price_attack_candidate',
  // Hermes AI Business OS generated opportunity candidate types.
  'inventory_restock_review',
  'dead_stock_review',
  'listing_quality_review',
  'price_or_margin_review',
  'cost_data_completion',
  'competition_watch',
  'urgent_price_attack_review',
]);

const SOURCE_TYPES = new Set([
  'bunjang', 'mart', 'competitor', 'staff_idea', 'buyer_request',
  'alibaba_inquiry', 'qoo10', 'shopee', 'shopify',
  'instagram', 'x', 'tiktok', 'youtube_shorts', 'xiaohongshu',
  'wechat', 'discord', 'naver_blog',
]);

const INPUT_CHANNELS = new Set(['web', 'mobile', 'telegram', 'kakao_share', 'api']);

const PLATFORMS = new Set([
  'shopify', 'ebay', 'alibaba', 'qoo10', 'shopee',
  'naver_smartstore', 'coupang',
  'x', 'instagram', 'tiktok', 'youtube_shorts', 'xiaohongshu',
  'wechat', 'discord', 'naver_blog',
]);

const STATUSES = new Set([
  'new', 'reviewing', 'approved', 'auto_handled',
  'rejected', 'draft_ready', 'assigned', 'published', 'archived',
]);

const PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);

const DEMAND_LEVELS = new Set(['low', 'medium', 'high', 'unknown']);
const HERMES_REVIEW_ACTIONS = new Set(['reviewing', 'approved', 'rejected', 'archived']);
const TABLE = 'opportunity_inbox';

// ──────────────────────────────────────────────────────────────────────────
// helpers
// ──────────────────────────────────────────────────────────────────────────
class ValidationError extends Error {
  constructor(message) { super(message); this.code = 'opportunityInbox/validation'; }
}
class NotFoundError extends Error {
  constructor(message) { super(message); this.code = 'opportunityInbox/not_found'; }
}
class ForbiddenError extends Error {
  constructor(message) { super(message); this.code = 'opportunityInbox/forbidden'; }
}

function trimOrNull(v, max) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return max ? s.slice(0, max) : s;
}

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function intOrNull(v) {
  if (v == null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function arrOrNull(v) {
  if (v == null) return null;
  if (!Array.isArray(v)) throw new ValidationError('배열이 아닙니다');
  return v;
}

function validateMetadata(meta) {
  if (meta == null) return null;
  if (typeof meta !== 'object') throw new ValidationError('metadata 는 object 여야 합니다');
  let json;
  try { json = JSON.stringify(meta); }
  catch { throw new ValidationError('metadata 직렬화 실패'); }
  if (json.length > 5000) throw new ValidationError('metadata stringify 길이 5000자 초과');
  return meta;
}

function validateImageUrls(arr) {
  if (arr == null) return null;
  if (!Array.isArray(arr)) throw new ValidationError('image_urls 는 배열이어야 합니다');
  return arr.map(u => String(u)).filter(s => s.length > 0);
}

function validateTargetPlatforms(arr) {
  if (arr == null) return null;
  if (!Array.isArray(arr)) throw new ValidationError('target_platforms 는 배열이어야 합니다');
  for (const p of arr) {
    if (!PLATFORMS.has(p)) throw new ValidationError(`target_platforms 부적합 값: ${p}`);
  }
  return arr;
}

// linked entity 존재 확인. 없으면 ValidationError (FK 위반 방지).
async function ensureLinkedExists(supabase, table, id, label) {
  const { data, error } = await supabase.from(table).select('id').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data) throw new ValidationError(`${label} id=${id} 가 존재하지 않습니다`);
}

// row 를 일관 형태로 반환
function shape(row) {
  return row;
}

function normalizeCandidateSourceList(values) {
  return [...new Set((values || []).map(v => String(v || '').trim()).filter(Boolean))].sort();
}

function candidateDuplicateKey(candidate) {
  const payload = {
    sku: String(candidate?.sku || '').trim(),
    type: String(candidate?.type || '').trim(),
    source_signals: normalizeCandidateSourceList(candidate?.source_signals),
    source_recommendations: normalizeCandidateSourceList(candidate?.source_recommendations),
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function mapCandidatePriority(priority) {
  const p = String(priority || '').toLowerCase();
  if (p === 'critical') return 'urgent';
  if (p === 'high') return 'high';
  if (p === 'low') return 'low';
  return 'normal';
}

function candidateToOpportunityRow(candidate, duplicateKey) {
  const sku = trimOrNull(candidate?.sku, 100);
  const opportunity_type = trimOrNull(candidate?.type, 50);
  if (!sku) throw new ValidationError('candidate.sku 필수');
  if (!opportunity_type) throw new ValidationError('candidate.type 필수');
  if (!OPPORTUNITY_TYPES.has(opportunity_type)) {
    throw new ValidationError(`candidate.type 부적합: ${opportunity_type}`);
  }

  const sourceSignals = normalizeCandidateSourceList(candidate?.source_signals);
  const sourceRecommendations = normalizeCandidateSourceList(candidate?.source_recommendations);

  return {
    opportunity_type,
    source_type: 'competitor',
    input_channel: 'api',
    title: trimOrNull(candidate?.title, 255) || `${opportunity_type} for SKU ${sku}`,
    priority: mapCandidatePriority(candidate?.priority),
    status: 'new',
    submitted_by: null,
    notes: trimOrNull(candidate?.reason),
    metadata: validateMetadata({
      hermes_generated: true,
      hermes_phase: '2C',
      hermes_candidate_key: duplicateKey,
      sku,
      candidate_type: opportunity_type,
      source_signals: sourceSignals,
      source_recommendations: sourceRecommendations,
      market_analysis: candidate?.market_analysis || {},
      requires_human_review: true,
      candidate_created_at: candidate?.created_at || null,
    }),
  };
}

async function findOpportunityDuplicate(supabase, duplicateKey) {
  const { data, error } = await supabase
    .from(TABLE)
    .select('id, opportunity_type, title, priority, status, metadata, created_at')
    .eq('metadata->>hermes_candidate_key', duplicateKey)
    .limit(1);
  if (error) throw error;
  return Array.isArray(data) && data.length > 0 ? shape(data[0]) : null;
}

async function writeOpportunityCandidates({ sku, candidates = [], dryRun = true } = {}) {
  const targetSku = trimOrNull(sku, 100);
  if (!targetSku) throw new ValidationError('sku 필수');

  const result = {
    sku: targetSku,
    dry_run: dryRun !== false,
    created: [],
    skipped_duplicates: [],
    errors: [],
  };

  const supabase = getClient();
  for (const candidate of candidates || []) {
    try {
      if (String(candidate?.sku || '').trim() !== targetSku) {
        throw new ValidationError(`candidate SKU mismatch: ${candidate?.sku || '(missing)'}`);
      }
      const duplicateKey = candidateDuplicateKey(candidate);
      const duplicate = await findOpportunityDuplicate(supabase, duplicateKey);
      if (duplicate) {
        result.skipped_duplicates.push({
          candidate,
          existing: duplicate,
          duplicate_key: duplicateKey,
        });
        continue;
      }

      const row = candidateToOpportunityRow(candidate, duplicateKey);
      if (result.dry_run) {
        result.created.push({
          dry_run: true,
          candidate,
          row,
          duplicate_key: duplicateKey,
        });
        continue;
      }

      const { data, error } = await supabase.from(TABLE).insert(row).select().single();
      if (error) throw error;
      result.created.push({
        candidate,
        row: shape(data),
        duplicate_key: duplicateKey,
      });
    } catch (e) {
      result.errors.push({
        candidate,
        error: e.message || String(e),
        code: e.code || 'unknown',
      });
    }
  }

  return result;
}

function shapeHermesOpportunity(row) {
  const metadata = row?.metadata || {};
  return {
    id: row?.id || 0,
    sku: metadata.sku || '',
    type: row?.opportunity_type || metadata.candidate_type || '',
    title: row?.title || '',
    priority: row?.priority || '',
    status: row?.status || '',
    source_signals: Array.isArray(metadata.source_signals) ? metadata.source_signals : [],
    source_recommendations: Array.isArray(metadata.source_recommendations) ? metadata.source_recommendations : [],
    market_analysis: metadata.market_analysis || {},
    hermes_review: metadata.hermes_review || null,
    created_at: row?.created_at || '',
  };
}

async function listHermesOpportunities({ sku = null, status = null, opportunity_type = null, limit = 50 } = {}) {
  const safeLimit = Math.min(200, Math.max(1, intOrNull(limit) || 50));
  const supabase = getClient();
  let q = supabase
    .from(TABLE)
    .select('id, opportunity_type, title, priority, status, metadata, created_at')
    .eq('metadata->>hermes_generated', 'true')
    .order('id', { ascending: false })
    .limit(safeLimit);

  const targetSku = trimOrNull(sku, 100);
  if (targetSku) q = q.eq('metadata->>sku', targetSku);

  const targetStatus = trimOrNull(status, 30);
  if (targetStatus) {
    if (!STATUSES.has(targetStatus)) throw new ValidationError(`status 부적합: ${targetStatus}`);
    q = q.eq('status', targetStatus);
  }

  const targetType = trimOrNull(opportunity_type, 50);
  if (targetType) {
    if (!OPPORTUNITY_TYPES.has(targetType)) throw new ValidationError(`opportunity_type 부적합: ${targetType}`);
    q = q.eq('opportunity_type', targetType);
  }

  const { data, error } = await q;
  if (error) throw error;
  const rows = (data || []).map(shapeHermesOpportunity);
  return { count: rows.length, data: rows };
}

function reviewOutput({ dryRun, id, action, before, after, error = null }) {
  return {
    dry_run: dryRun !== false,
    id,
    action,
    before: before || {},
    after: after || {},
    error,
  };
}

function makeHermesReviewMetadata(existingMetadata, { action, reason, reviewed_by, reviewed_at }) {
  return validateMetadata({
    ...(existingMetadata || {}),
    hermes_review: {
      action,
      reason: reason || null,
      reviewed_by: reviewed_by == null ? null : String(reviewed_by),
      reviewed_at,
    },
  });
}

async function reviewHermesOpportunity({ id, action, reason = null, reviewed_by = null, dryRun = true } = {}) {
  const targetId = intOrNull(id);
  if (targetId == null) throw new ValidationError('id 필수');

  const nextAction = trimOrNull(action, 30);
  if (!nextAction || !HERMES_REVIEW_ACTIONS.has(nextAction)) {
    throw new ValidationError(`action 부적합: ${nextAction || '(missing)'}`);
  }

  const reviewReason = trimOrNull(reason, 1000);
  if (nextAction === 'rejected' && !reviewReason) {
    throw new ValidationError('rejected action requires reason');
  }

  const supabase = getClient();
  const { data: existing, error: selectError } = await supabase
    .from(TABLE)
    .select('id, opportunity_type, title, priority, status, metadata, created_at, updated_at')
    .eq('id', targetId)
    .maybeSingle();
  if (selectError) throw selectError;
  if (!existing) throw new NotFoundError(`opportunity id=${targetId} not found`);
  if (existing?.metadata?.hermes_generated !== true) {
    throw new ValidationError('target opportunity is not Hermes-generated');
  }

  const reviewedAt = new Date().toISOString();
  const nextMetadata = makeHermesReviewMetadata(existing.metadata, {
    action: nextAction,
    reason: reviewReason,
    reviewed_by,
    reviewed_at: reviewedAt,
  });
  const afterPreview = {
    ...existing,
    status: nextAction,
    metadata: nextMetadata,
  };

  if (dryRun !== false) {
    return reviewOutput({
      dryRun: true,
      id: targetId,
      action: nextAction,
      before: shape(existing),
      after: afterPreview,
    });
  }

  const { data: updated, error: updateError } = await supabase
    .from(TABLE)
    .update({
      status: nextAction,
      metadata: nextMetadata,
    })
    .eq('id', targetId)
    .select('id, opportunity_type, title, priority, status, metadata, created_at, updated_at')
    .single();
  if (updateError) throw updateError;

  return reviewOutput({
    dryRun: false,
    id: targetId,
    action: nextAction,
    before: shape(existing),
    after: shape(updated),
  });
}

// ──────────────────────────────────────────────────────────────────────────
// CRUD
// ──────────────────────────────────────────────────────────────────────────

/**
 * POST /api/opportunity-inbox
 * 직원도 생성 가능. submitted_by = req.user.id 로 자동 기록.
 */
async function createOpportunity({ user, body }) {
  if (!user || !Number.isFinite(user.id)) {
    throw new ForbiddenError('인증된 사용자가 아닙니다');
  }
  const b = body || {};

  // required
  const opportunity_type = trimOrNull(b.opportunity_type, 50);
  if (!opportunity_type) throw new ValidationError('opportunity_type 필수');
  if (!OPPORTUNITY_TYPES.has(opportunity_type)) {
    throw new ValidationError(`opportunity_type 부적합: ${opportunity_type}`);
  }

  // optional with allowlist
  const source_type = trimOrNull(b.source_type, 50);
  if (source_type && !SOURCE_TYPES.has(source_type)) {
    throw new ValidationError(`source_type 부적합: ${source_type}`);
  }

  const input_channel = trimOrNull(b.input_channel, 50) || 'web';
  if (!INPUT_CHANNELS.has(input_channel)) {
    throw new ValidationError(`input_channel 부적합: ${input_channel}`);
  }

  const priority = trimOrNull(b.priority, 30) || 'normal';
  if (!PRIORITIES.has(priority)) {
    throw new ValidationError(`priority 부적합: ${priority}`);
  }

  const status = trimOrNull(b.status, 30) || 'new';
  if (!STATUSES.has(status)) {
    throw new ValidationError(`status 부적합: ${status}`);
  }

  const estimated_demand = trimOrNull(b.estimated_demand, 30);
  if (estimated_demand && !DEMAND_LEVELS.has(estimated_demand)) {
    throw new ValidationError(`estimated_demand 부적합: ${estimated_demand}`);
  }

  const target_platforms = validateTargetPlatforms(arrOrNull(b.target_platforms));
  const image_urls       = validateImageUrls(arrOrNull(b.image_urls));
  const metadata         = validateMetadata(b.metadata);

  // linked_* 존재 확인 (FK 위반 방지)
  const supabase = getClient();
  const linked_sku_id   = intOrNull(b.linked_sku_id);
  const linked_order_id = intOrNull(b.linked_order_id);
  const linked_task_id  = intOrNull(b.linked_task_id);
  if (linked_sku_id   != null) await ensureLinkedExists(supabase, 'sku_master',  linked_sku_id,   'linked_sku_id');
  if (linked_order_id != null) await ensureLinkedExists(supabase, 'wms_orders',  linked_order_id, 'linked_order_id');
  if (linked_task_id  != null) await ensureLinkedExists(supabase, 'team_tasks',  linked_task_id,  'linked_task_id');

  const row = {
    opportunity_type,
    source_type,
    input_channel,
    source_url:              trimOrNull(b.source_url),
    source_name:             trimOrNull(b.source_name, 200),
    title:                   trimOrNull(b.title, 255),
    title_ko:                trimOrNull(b.title_ko, 255),
    title_en:                trimOrNull(b.title_en, 255),
    title_ja:                trimOrNull(b.title_ja, 255),
    title_zh:                trimOrNull(b.title_zh, 255),
    brand:                   trimOrNull(b.brand, 100),
    category:                trimOrNull(b.category, 100),
    expected_buy_price_krw:  numOrNull(b.expected_buy_price_krw),
    expected_sell_price_krw: numOrNull(b.expected_sell_price_krw),
    expected_sell_price_usd: numOrNull(b.expected_sell_price_usd),
    estimated_margin_rate:   numOrNull(b.estimated_margin_rate),
    estimated_demand,
    target_platforms,
    priority,
    status,
    submitted_by:            user.id,
    assigned_to:             intOrNull(b.assigned_to),
    linked_sku_id,
    linked_order_id,
    linked_task_id,
    notes:                   trimOrNull(b.notes),
    image_urls,
    metadata,
  };

  const { data, error } = await supabase.from(TABLE).insert(row).select().single();
  if (error) throw error;
  return shape(data);
}

/**
 * GET /api/opportunity-inbox
 * staff: 본인 submitted 또는 본인 assigned 만
 * admin: 전체
 *
 * filters: { status, opportunity_type, source_type, input_channel, priority,
 *            assigned_to, submitted_by, limit, offset }
 */
async function listOpportunities({ user, filters = {} }) {
  if (!user || !Number.isFinite(user.id)) {
    throw new ForbiddenError('인증된 사용자가 아닙니다');
  }
  const supabase = getClient();
  const limit  = Math.min(200, Math.max(1, intOrNull(filters.limit)  || 50));
  const offset = Math.max(0, intOrNull(filters.offset) || 0);

  let q = supabase.from(TABLE).select('*').order('id', { ascending: false }).range(offset, offset + limit - 1);

  if (filters.status            && STATUSES.has(filters.status))               q = q.eq('status', filters.status);
  if (filters.opportunity_type  && OPPORTUNITY_TYPES.has(filters.opportunity_type)) q = q.eq('opportunity_type', filters.opportunity_type);
  if (filters.source_type       && SOURCE_TYPES.has(filters.source_type))      q = q.eq('source_type', filters.source_type);
  if (filters.input_channel     && INPUT_CHANNELS.has(filters.input_channel))  q = q.eq('input_channel', filters.input_channel);
  if (filters.priority          && PRIORITIES.has(filters.priority))           q = q.eq('priority', filters.priority);

  const fAssignedTo  = intOrNull(filters.assigned_to);
  const fSubmittedBy = intOrNull(filters.submitted_by);

  if (!user.isAdmin) {
    // staff: 본인 submitted 또는 본인 assigned 만
    q = q.or(`submitted_by.eq.${user.id},assigned_to.eq.${user.id}`);
  } else {
    if (fAssignedTo  != null) q = q.eq('assigned_to', fAssignedTo);
    if (fSubmittedBy != null) q = q.eq('submitted_by', fSubmittedBy);
  }

  const { data, error } = await q;
  if (error) throw error;
  return (data || []).map(shape);
}

/**
 * GET /api/opportunity-inbox/:id
 * staff: 본인 submitted 또는 본인 assigned 만 조회 가능
 */
async function getOpportunity({ user, id }) {
  if (!user || !Number.isFinite(user.id)) {
    throw new ForbiddenError('인증된 사용자가 아닙니다');
  }
  if (!Number.isFinite(id)) throw new ValidationError('invalid id');

  const supabase = getClient();
  const { data, error } = await supabase.from(TABLE).select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data) throw new NotFoundError(`opportunity id=${id} not found`);

  if (!user.isAdmin) {
    const isMine = data.submitted_by === user.id || data.assigned_to === user.id;
    if (!isMine) throw new ForbiddenError('본인 후보만 조회할 수 있습니다');
  }
  return shape(data);
}

/**
 * PATCH /api/opportunity-inbox/:id
 * staff: 본인 후보의 notes / source_url / image_urls / metadata / category /
 *        target_platforms / estimated_demand / brand / title* 정도만 수정.
 *        status / approve 권한 없음.
 * admin: 모든 필드 수정 + 상태 변경 (단 approve/reject 는 별 endpoint 사용 권장).
 */
async function updateOpportunity({ user, id, body }) {
  if (!user || !Number.isFinite(user.id)) {
    throw new ForbiddenError('인증된 사용자가 아닙니다');
  }
  if (!Number.isFinite(id)) throw new ValidationError('invalid id');

  const supabase = getClient();
  const { data: existing, error: e1 } = await supabase.from(TABLE).select('*').eq('id', id).maybeSingle();
  if (e1) throw e1;
  if (!existing) throw new NotFoundError(`opportunity id=${id} not found`);

  const isOwner = existing.submitted_by === user.id;
  const isAssignee = existing.assigned_to === user.id;
  if (!user.isAdmin && !isOwner && !isAssignee) {
    throw new ForbiddenError('본인 후보만 수정할 수 있습니다');
  }

  const b = body || {};
  const updates = { updated_at: new Date().toISOString() };

  // staff 가 수정 가능한 필드 (자유 텍스트 / 태그 / 메모 / 평가 등)
  if (b.notes        !== undefined) updates.notes        = trimOrNull(b.notes);
  if (b.source_url   !== undefined) updates.source_url   = trimOrNull(b.source_url);
  if (b.source_name  !== undefined) updates.source_name  = trimOrNull(b.source_name, 200);
  if (b.title        !== undefined) updates.title        = trimOrNull(b.title, 255);
  if (b.title_ko     !== undefined) updates.title_ko     = trimOrNull(b.title_ko, 255);
  if (b.title_en     !== undefined) updates.title_en     = trimOrNull(b.title_en, 255);
  if (b.title_ja     !== undefined) updates.title_ja     = trimOrNull(b.title_ja, 255);
  if (b.title_zh     !== undefined) updates.title_zh     = trimOrNull(b.title_zh, 255);
  if (b.brand        !== undefined) updates.brand        = trimOrNull(b.brand, 100);
  if (b.category     !== undefined) updates.category     = trimOrNull(b.category, 100);
  if (b.expected_buy_price_krw  !== undefined) updates.expected_buy_price_krw  = numOrNull(b.expected_buy_price_krw);
  if (b.expected_sell_price_krw !== undefined) updates.expected_sell_price_krw = numOrNull(b.expected_sell_price_krw);
  if (b.expected_sell_price_usd !== undefined) updates.expected_sell_price_usd = numOrNull(b.expected_sell_price_usd);
  if (b.estimated_margin_rate   !== undefined) updates.estimated_margin_rate   = numOrNull(b.estimated_margin_rate);
  if (b.estimated_demand !== undefined) {
    const v = trimOrNull(b.estimated_demand, 30);
    if (v && !DEMAND_LEVELS.has(v)) throw new ValidationError(`estimated_demand 부적합: ${v}`);
    updates.estimated_demand = v;
  }
  if (b.target_platforms !== undefined) updates.target_platforms = validateTargetPlatforms(arrOrNull(b.target_platforms));
  if (b.image_urls       !== undefined) updates.image_urls       = validateImageUrls(arrOrNull(b.image_urls));
  if (b.metadata         !== undefined) updates.metadata         = validateMetadata(b.metadata);

  // admin 만 수정 가능
  if (user.isAdmin) {
    if (b.priority !== undefined) {
      const v = trimOrNull(b.priority, 30);
      if (v && !PRIORITIES.has(v)) throw new ValidationError(`priority 부적합: ${v}`);
      updates.priority = v;
    }
    if (b.status !== undefined) {
      const v = trimOrNull(b.status, 30);
      if (v && !STATUSES.has(v)) throw new ValidationError(`status 부적합: ${v}`);
      updates.status = v;
    }
    if (b.assigned_to !== undefined) updates.assigned_to = intOrNull(b.assigned_to);
    if (b.linked_sku_id   !== undefined) {
      const v = intOrNull(b.linked_sku_id);
      if (v != null) await ensureLinkedExists(supabase, 'sku_master', v, 'linked_sku_id');
      updates.linked_sku_id = v;
    }
    if (b.linked_order_id !== undefined) {
      const v = intOrNull(b.linked_order_id);
      if (v != null) await ensureLinkedExists(supabase, 'wms_orders', v, 'linked_order_id');
      updates.linked_order_id = v;
    }
    if (b.linked_task_id  !== undefined) {
      const v = intOrNull(b.linked_task_id);
      if (v != null) await ensureLinkedExists(supabase, 'team_tasks', v, 'linked_task_id');
      updates.linked_task_id = v;
    }
    if (b.opportunity_type !== undefined) {
      const v = trimOrNull(b.opportunity_type, 50);
      if (!OPPORTUNITY_TYPES.has(v)) throw new ValidationError(`opportunity_type 부적합: ${v}`);
      updates.opportunity_type = v;
    }
    if (b.source_type !== undefined) {
      const v = trimOrNull(b.source_type, 50);
      if (v && !SOURCE_TYPES.has(v)) throw new ValidationError(`source_type 부적합: ${v}`);
      updates.source_type = v;
    }
    if (b.input_channel !== undefined) {
      const v = trimOrNull(b.input_channel, 50);
      if (v && !INPUT_CHANNELS.has(v)) throw new ValidationError(`input_channel 부적합: ${v}`);
      updates.input_channel = v;
    }
  }

  if (Object.keys(updates).length === 1) {
    throw new ValidationError('변경할 필드가 없습니다');
  }

  const { data, error } = await supabase.from(TABLE).update(updates).eq('id', id).select().single();
  if (error) throw error;
  return shape(data);
}

/**
 * POST /api/opportunity-inbox/:id/approve  (admin only)
 */
async function approveOpportunity({ user, id }) {
  if (!user?.isAdmin) throw new ForbiddenError('관리자 전용 기능입니다');
  if (!Number.isFinite(id)) throw new ValidationError('invalid id');

  const supabase = getClient();
  const { data, error } = await supabase
    .from(TABLE)
    .update({
      status: 'approved',
      approved_by: user.id,
      approved_at: new Date().toISOString(),
      rejection_reason: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new NotFoundError(`opportunity id=${id} not found`);
  return shape(data);
}

/**
 * POST /api/opportunity-inbox/:id/reject  (admin only)
 */
async function rejectOpportunity({ user, id, reason }) {
  if (!user?.isAdmin) throw new ForbiddenError('관리자 전용 기능입니다');
  if (!Number.isFinite(id)) throw new ValidationError('invalid id');
  const r = trimOrNull(reason, 500);
  if (!r) throw new ValidationError('reason 필수');

  const supabase = getClient();
  const { data, error } = await supabase
    .from(TABLE)
    .update({
      status: 'rejected',
      approved_by: user.id,
      approved_at: new Date().toISOString(),
      rejection_reason: r,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new NotFoundError(`opportunity id=${id} not found`);
  return shape(data);
}

module.exports = {
  // allowlists
  OPPORTUNITY_TYPES, SOURCE_TYPES, INPUT_CHANNELS, PLATFORMS, STATUSES, PRIORITIES, DEMAND_LEVELS,
  // CRUD
  createOpportunity, listOpportunities, getOpportunity, updateOpportunity,
  approveOpportunity, rejectOpportunity,
  writeOpportunityCandidates, candidateDuplicateKey, listHermesOpportunities,
  reviewHermesOpportunity,
  // errors
  ValidationError, NotFoundError, ForbiddenError,
};
