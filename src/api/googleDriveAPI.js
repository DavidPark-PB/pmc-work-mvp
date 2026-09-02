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
   * xlsx 파일 → Google Sheets로 변환 업로드 → PDF export → 삭제
   * (xlsx를 PDF로 변환하는 우회 방법)
   *
   * 2026-09-02 · Owner Directive fix: service account 자체 Drive quota=0 이라
   *   임시 파일 create 자체가 storageQuotaExceeded 실패. 사장님 shared drive
   *   PMCCoperation > 02_B2B invoice 폴더에 임시 create · quota 문제 해결.
   *   env B2B_TEMP_FOLDER_ID override 지원.
   */
  async convertXlsxToPdf(xlsxBuffer, tempName = 'temp-invoice') {
    await this._ensureDrive();
    const { Readable } = require('stream');

    const parentFolderId = process.env.B2B_TEMP_FOLDER_ID
      || '1FduYLrs9G8qU197QoYqYtLY0Il3t4Tet'; // PMCCoperation > 02_B2B invoice

    // 1. xlsx를 Google Sheets로 변환 업로드 (shared drive parent 지정)
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
      // 3. 임시 파일 삭제 (permanent · shared drive)
      try {
        await this.drive.files.delete({ fileId: tempFileId, supportsAllDrives: true });
      } catch (e) {
        console.warn('임시 파일 삭제 실패:', e.message);
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
