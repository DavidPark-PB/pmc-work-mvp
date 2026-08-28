const { google } = require('googleapis');
const path = require('path');

/**
 * Google Drive API 클래스
 * Service Account 인증을 사용하여 Google Drive 파일 관리
 */
class GoogleDriveAPI {
  constructor(credentialsPath = '../../config/credentials.json') {
    this.credentialsPath = credentialsPath;
    this.auth = null;
    this.drive = null;
  }

  async authenticate() {
    try {
      // env-var 우선 (Railway 등 파일 마운트 불가 호스팅), 없으면 keyFile.
      const credsJson = process.env.GOOGLE_CREDENTIALS_JSON;
      const baseConfig = {
        scopes: [
          'https://www.googleapis.com/auth/drive',
          'https://www.googleapis.com/auth/spreadsheets',
        ],
      };
      const authConfig = credsJson
        ? { ...baseConfig, credentials: JSON.parse(credsJson) }
        : { ...baseConfig, keyFile: this.credentialsPath };

      const auth = new google.auth.GoogleAuth(authConfig);
      this.auth = await auth.getClient();
      this.drive = google.drive({ version: 'v3', auth: this.auth });
      return true;
    } catch (error) {
      console.error('❌ Google Drive API 인증 실패:', error.message);
      throw error;
    }
  }

  async _ensureDrive() {
    if (!this.drive) await this.authenticate();
  }

  /**
   * 폴더 내 파일 목록 조회
   */
  async listFiles(folderId, query) {
    await this._ensureDrive();
    let q = `'${folderId}' in parents and trashed = false`;
    if (query) q += ` and ${query}`;

    const response = await this.drive.files.list({
      q,
      fields: 'files(id, name, mimeType, createdTime, modifiedTime, webViewLink, size)',
      orderBy: 'modifiedTime desc',
      pageSize: 100,
    });

    return response.data.files || [];
  }

  /**
   * 파일 업로드 (buffer → Drive)
   */
  async uploadFile(folderId, fileName, mimeType, buffer) {
    await this._ensureDrive();
    const { Readable } = require('stream');

    const response = await this.drive.files.create({
      requestBody: {
        name: fileName,
        parents: [folderId],
      },
      media: {
        mimeType,
        body: Readable.from(buffer),
      },
      fields: 'id, name, webViewLink, webContentLink',
    });

    // 링크 공유 설정 (누구나 링크로 보기)
    await this.drive.permissions.create({
      fileId: response.data.id,
      requestBody: {
        role: 'reader',
        type: 'anyone',
      },
    });

    console.log(`✅ Drive 업로드: ${fileName} (ID: ${response.data.id})`);
    return response.data;
  }

  /**
   * 파일 다운로드 (Drive → buffer)
   */
  async downloadFile(fileId) {
    await this._ensureDrive();
    const response = await this.drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'arraybuffer' }
    );
    return Buffer.from(response.data);
  }

  /**
   * Google Sheets/Docs → PDF 변환 다운로드
   */
  async exportAsPdf(fileId) {
    await this._ensureDrive();
    const response = await this.drive.files.export(
      { fileId, mimeType: 'application/pdf' },
      { responseType: 'arraybuffer' }
    );
    return Buffer.from(response.data);
  }

  /**
   * xlsx 파일 → Google Sheets로 변환 업로드 → PDF export → 정리
   * (xlsx를 PDF로 변환하는 우회 방법)
   *
   * parentFolderId 는 필수다. 서비스 계정은 개인 Drive 저장 용량이 0 이라
   * parents 없이 files.create 하면 무조건
   *   "The user's Drive storage quota has been exceeded."
   * 로 실패한다 (2026-08-28 B2B PDF 버튼 장애의 원인 — Drive 가 찬 게 아니라
   * 처음부터 쓸 공간이 0 이었다). 공유 드라이브 폴더를 지정하면 그 드라이브의
   * 용량을 쓰므로 정상 동작한다.
   *
   * @param {Buffer} xlsxBuffer
   * @param {string} tempName        임시 파일 이름
   * @param {string} parentFolderId  공유 드라이브 내 폴더 ID (필수)
   */
  async convertXlsxToPdf(xlsxBuffer, tempName = 'temp-invoice', parentFolderId) {
    if (!parentFolderId) {
      throw new Error(
        'convertXlsxToPdf: parentFolderId 필수 — 서비스 계정 개인 Drive 는 용량이 0 이라 ' +
        '공유 드라이브 폴더를 지정해야 합니다 (예: B2B_DRIVE_FOLDER_ID).'
      );
    }
    await this._ensureDrive();
    const { Readable } = require('stream');

    // 1. xlsx를 Google Sheets로 변환 업로드 (공유 드라이브 폴더 안에)
    const uploaded = await this.drive.files.create({
      requestBody: {
        name: tempName,
        mimeType: 'application/vnd.google-apps.spreadsheet', // 변환
        parents: [parentFolderId],
      },
      media: {
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        body: Readable.from(xlsxBuffer),
      },
      fields: 'id',
      supportsAllDrives: true,
    });

    const tempFileId = uploaded.data.id;

    try {
      // 2. PDF로 export
      const pdfBuffer = await this.exportAsPdf(tempFileId);
      return pdfBuffer;
    } finally {
      // 3. 임시 파일 정리.
      //    서비스 계정은 공유 드라이브에서 Contributor 라 files.delete 권한이 없다
      //    (canDelete=false / canTrash=true). 영구 삭제를 시도하면 File not found 로
      //    실패하고 임시 파일이 그대로 쌓이므로 휴지통 이동을 먼저 쓴다.
      //    휴지통은 공유 드라이브 설정에 따라 30일 후 자동 비워진다.
      try {
        await this.drive.files.update({
          fileId: tempFileId,
          requestBody: { trashed: true },
          supportsAllDrives: true,
        });
      } catch (e) {
        console.warn('임시 파일 휴지통 이동 실패:', e.message);
        try {
          await this.drive.files.delete({ fileId: tempFileId, supportsAllDrives: true });
        } catch (e2) {
          console.warn('임시 파일 삭제도 실패 (수동 정리 필요):', tempFileId, e2.message);
        }
      }
    }
  }

  /**
   * 파일 메타데이터 조회
   */
  async getFileMetadata(fileId) {
    await this._ensureDrive();
    const response = await this.drive.files.get({
      fileId,
      fields: 'id, name, mimeType, createdTime, modifiedTime, webViewLink, size',
    });
    return response.data;
  }

  /**
   * 파일 삭제
   */
  async deleteFile(fileId) {
    await this._ensureDrive();
    await this.drive.files.delete({ fileId });
  }
}

module.exports = GoogleDriveAPI;
