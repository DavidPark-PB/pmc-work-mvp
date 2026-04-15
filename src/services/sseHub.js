/**
 * Server-Sent Events 허브 — 사용자별 실시간 알림 스트림 관리
 *
 * 동일 유저가 여러 탭에서 접속할 수 있으므로 userId 당 Set<res>.
 * 서버 재시작 시 클라이언트는 EventSource 자동 재연결로 복구.
 */
const clients = new Map(); // userId(number) → Set<ServerResponse>

function register(userId, res) {
  const uid = Number(userId);
  if (!uid) return;
  if (!clients.has(uid)) clients.set(uid, new Set());
  clients.get(uid).add(res);
}

function unregister(userId, res) {
  const uid = Number(userId);
  const set = clients.get(uid);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) clients.delete(uid);
}

/**
 * 특정 사용자에게 이벤트 전송
 * @param {number} userId
 * @param {object} event { type, ...payload }
 */
function sendTo(userId, event) {
  const set = clients.get(Number(userId));
  if (!set || set.size === 0) return 0;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  let sent = 0;
  for (const res of set) {
    try { res.write(payload); sent++; }
    catch { /* 연결 끊긴 것은 close 핸들러에서 정리 */ }
  }
  return sent;
}

function sendToMany(userIds, event) {
  let total = 0;
  for (const uid of userIds) total += sendTo(uid, event);
  return total;
}

function stats() {
  return {
    connectedUsers: clients.size,
    totalConnections: [...clients.values()].reduce((a, s) => a + s.size, 0),
  };
}

module.exports = { register, unregister, sendTo, sendToMany, stats };
