/**
 * Drive → resources DB 동기화.
 *  - listFiles(folderId)로 파일 목록 조회
 *  - upsert (기존이면 updated_at만 갱신)
 *  - Drive에 없는 기존 파일은 soft-delete
 */
const path = require('path');
const repo = require('../db/resourceRepository');

let _drive = null;
function getDrive() {
  if (_drive) return _drive;
  const GoogleDriveAPI = require('../api/googleDriveAPI');
  // 기존 GoogleDriveAPI 기본 credential path = '../../config/credentials.json'
  // 하지만 이 경로는 /src/api/에서 본 경로라 /src/services/에서는 다르므로 절대 경로로 지정
  const credPath = path.join(__dirname, '..', '..', 'config', 'credentials.json');
  _drive = new GoogleDriveAPI(credPath);
  return _drive;
}

async function syncFolder(folderId) {
  const folder = await repo.getFolder(folderId);
  if (!folder) throw new Error('자료실 폴더를 찾을 수 없습니다');
  if (!folder.driveFolderId) throw new Error('Drive 폴더 ID가 설정되지 않았습니다');

  const drive = getDrive();
  let files;
  try {
    files = await drive.listFiles(folder.driveFolderId);
  } catch (e) {
    throw new Error(`Drive 조회 실패: ${e.message}`);
  }

  // 서비스 계정이 폴더 접근 권한 없으면 빈 배열 리턴 — 경고
  if (!Array.isArray(files)) files = [];

  if (files.length > 0) {
    await repo.upsertResources(folderId, files);
  }
  await repo.markMissingAsDeleted(folderId, files.map(f => f.id));
  await repo.recordSync(folderId, files.length);

  return { folderId, fileCount: files.length };
}

async function syncAll() {
  const folders = await repo.listFolders({ activeOnly: true });
  const results = [];
  for (const f of folders) {
    try {
      const r = await syncFolder(f.id);
      results.push({ ...r, name: f.name, ok: true });
    } catch (e) {
      results.push({ folderId: f.id, name: f.name, ok: false, error: e.message });
    }
  }
  return results;
}

module.exports = { syncFolder, syncAll };
