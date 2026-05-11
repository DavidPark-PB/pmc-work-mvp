/**
 * cs_sales_options — 카테고리별 영업 옵션 (PR CS-G1)
 *
 * 직원이 답변 작성 시 체크박스로 선택해 본문에 결합.
 * 활성/비활성 토글 + sort_order 만 운영. 시드 7 row 는 046 마이그레이션 ON CONFLICT 시드.
 */
'use strict';

const { getClient } = require('./supabaseClient');

function decorate(row) {
  if (!row) return null;
  return {
    id: row.id,
    category: row.category,
    label: row.label,
    contentSnippet: row.content_snippet,
    sortOrder: row.sort_order,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function listByCategory(category, { activeOnly = true } = {}) {
  if (!category) return [];
  let q = getClient().from('cs_sales_options')
    .select('*')
    .eq('category', category)
    .order('sort_order', { ascending: true });
  if (activeOnly) q = q.eq('is_active', true);
  const { data, error } = await q;
  if (error) throw error;
  return (data || []).map(decorate);
}

async function listAll({ activeOnly = false } = {}) {
  let q = getClient().from('cs_sales_options')
    .select('*')
    .order('category', { ascending: true })
    .order('sort_order', { ascending: true });
  if (activeOnly) q = q.eq('is_active', true);
  const { data, error } = await q;
  if (error) throw error;
  return (data || []).map(decorate);
}

async function getById(id) {
  const { data, error } = await getClient().from('cs_sales_options')
    .select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return decorate(data);
}

async function getByIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const { data, error } = await getClient().from('cs_sales_options')
    .select('*').in('id', ids).order('sort_order', { ascending: true });
  if (error) throw error;
  return (data || []).map(decorate);
}

module.exports = { listByCategory, listAll, getById, getByIds };
