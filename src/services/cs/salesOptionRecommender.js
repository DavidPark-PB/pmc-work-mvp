/**
 * SalesOptionRecommender — 카테고리 → 활성 영업 옵션 list (PR CS-G1)
 *
 * 정책:
 *   - cs_sales_options 의 is_active=true 만
 *   - sort_order asc 정렬
 *   - thanks 처럼 다중 옵션도 자연 결합 (사장님 짚을 점 G — variableSubstitutor 가 \n\n 결합)
 */
'use strict';

const { getClient } = require('../../db/supabaseClient');

async function recommend(category) {
  if (!category) return [];
  const { data, error } = await getClient()
    .from('cs_sales_options')
    .select('id, category, label, content_snippet, sort_order')
    .eq('category', category)
    .eq('is_active', true)
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function listAll() {
  const { data, error } = await getClient()
    .from('cs_sales_options')
    .select('id, category, label, content_snippet, sort_order, is_active')
    .order('category', { ascending: true })
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function getByIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const { data, error } = await getClient()
    .from('cs_sales_options')
    .select('id, category, label, content_snippet, sort_order')
    .in('id', ids)
    .eq('is_active', true)
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return data || [];
}

module.exports = { recommend, listAll, getByIds };
