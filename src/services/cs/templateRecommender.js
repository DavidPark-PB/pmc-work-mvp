/**
 * TemplateRecommender — 카테고리 → top 3 템플릿 추천 (PR CS-G1)
 *
 * 정책:
 *   - cs_templates 의 deleted_at IS NULL AND is_active=true 만
 *   - 카테고리 정확 매칭 후 usage_count desc 정렬
 *   - language 옵션 매칭 (기본 모든 언어)
 */
'use strict';

const { getClient } = require('../../db/supabaseClient');

/**
 * @param {string} category — spec 7 카테고리 (또는 cs_templates 의 기존 카테고리 — restock/order/general 등)
 * @param {Object} [opts]
 * @param {string} [opts.language] — 'en'|'ko'|... 미지정 시 모든 언어
 * @param {number} [opts.limit=3]
 * @returns {Promise<Array>}
 */
async function recommend(category, opts = {}) {
  if (!category) return [];
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 3, 1), 10);

  let q = getClient()
    .from('cs_templates')
    .select('id, title, language, category, body, variables, usage_count, last_used_at')
    .eq('category', category)
    .eq('is_active', true)
    .is('deleted_at', null)
    .order('usage_count', { ascending: false })
    .limit(limit);

  if (opts.language) q = q.eq('language', opts.language);

  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

module.exports = { recommend };
