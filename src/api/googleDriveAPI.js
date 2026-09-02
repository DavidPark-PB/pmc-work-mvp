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
   * Google Sheets → PDF 변환 다운로드
   *
   * 2026-09-02 · Owner Directive: files.export 는 옵션 없어서 여러 시트 · gridlines
   *   등 다 포함. Sheets export URL 로 · 첫 시트만 · A4 · fit width · gridlines off.
   *
   * 첫 시트 gid 는 · xlsx 변환 시 자동 할당 · 0 이 아닐 수 있음 → sheets.get 으로
   * 첫 시트 sheetId 획득 후 gid 파라미터에 사용.
   */
  async exportAsPdf(fileId) {
    await this._ensureDrive();
    const { google } = require('googleapis');
    const sheets = google.sheets({ version: 'v4', auth: this.auth });

    // 첫 시트 gid 획득 (xlsx→sheets 변환 시 · 첫 시트가 gid=0 이 아닐 수 있음)
    let firstGid = '0';
    try {
      const meta = await sheets.spreadsheets.get({
        spreadsheetId: fileId,
        fields: 'sheets(properties(sheetId,index,title))',
      });
      const first = (meta.data.sheets || []).find(s => s.properties?.index === 0) || meta.data.sheets?.[0];
      if (first?.properties?.sheetId != null) firstGid = String(first.properties.sheetId);
    } catch (e) { console.warn('[exportAsPdf] sheets.get 실패 · gid=0 fallback:', e.message); }

    const params = new URLSearchParams({
      format: 'pdf',
      gid: firstGid,         // 첫 시트만 (INVOICE) · 나머지 시트 제외
      portrait: 'true',
      size: 'A4',
      scale: '2',            // 2 = fit to width
      sheetnames: 'false',
      printtitle: 'false',
      pagenumbers: 'false',
      gridlines: 'false',
      fzr: 'false',
      top_margin: '0.5',
      bottom_margin: '0.5',
      left_margin: '0.5',
      right_margin: '0.5',
      horizontal_alignment: 'CENTER',
      vertical_alignment: 'TOP',
    });
    const url = `https://docs.google.com/spreadsheets/d/${fileId}/export?${params.toString()}`;
    const tokenObj = await this.auth.getAccessToken();
    const token = typeof tokenObj === 'string' ? tokenObj : (tokenObj?.token || tokenObj?.access_token);
    const axios = require('axios');
    try {
      const res = await axios.get(url, {
        responseType: 'arraybuffer',
        headers: { Authorization: `Bearer ${token}` },
      });
      return Buffer.from(res.data);
    } catch (e) {
      // Sheets export URL 이 특정 조합에 400 반환 시 · files.export fallback
      const status = e.response?.status;
      console.warn(`[exportAsPdf] Sheets export URL 실패 (${status}) · files.export fallback`);
      const fallback = await this.drive.files.export(
        { fileId, mimeType: 'application/pdf' },
        { responseType: 'arraybuffer' }
      );
      return Buffer.from(fallback.data);
    }
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
