/**
 * Users Repository — ccorea-auto에서 만든 users 테이블 공유
 *
 * 테이블 구조 (이미 Supabase에 존재):
 *   id, username, password_hash, display_name, role ('admin'|'staff'),
 *   is_active, created_at, last_login_at,
 *   platform, work_type, work_schedule, hourly_rate,
 *   shopee_bonus_rate, default_due_time, ui_mode, notes
 */
const bcrypt = require('bcryptjs');
const { getClient } = require('./supabaseClient');

const BCRYPT_ROUNDS = 10;

async function findByUsername(username) {
  const { data, error } = await getClient()
    .from('users')
    .select('*')
    .eq('username', username)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function findById(id) {
  const { data, error } = await getClient()
    .from('users')
    .select('id, username, display_name, role, is_active, platform, ui_mode')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function listActiveStaff() {
  const { data, error } = await getClient()
    .from('users')
    .select('id, username, display_name, role, is_active, platform, hourly_rate, default_due_time, last_login_at')
    .eq('is_active', true)
    .order('display_name', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

async function verifyPassword(plain, hash) {
  if (!hash) return false;
  return bcrypt.compare(plain, hash);
}

async function updatePassword(userId, newHash) {
  const { error } = await getClient()
    .from('users')
    .update({ password_hash: newHash })
    .eq('id', userId);
  if (error) throw error;
}

async function touchLastLogin(userId) {
  const { error } = await getClient()
    .from('users')
    .update({ last_login_at: new Date().toISOString() })
    .eq('id', userId);
  if (error) console.warn('[userRepo] last_login_at 갱신 실패:', error.message);
}

/** 랜덤 임시 비밀번호 생성 (admin이 비번 초기화할 때 사용) */
function generateTempPassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789'; // 혼동 문자 제외
  let pw = '';
  for (let i = 0; i < 8; i++) {
    pw += chars[Math.floor(Math.random() * chars.length)];
  }
  return pw;
}

module.exports = {
  findByUsername,
  findById,
  listActiveStaff,
  hashPassword,
  verifyPassword,
  updatePassword,
  touchLastLogin,
  generateTempPassword,
};
