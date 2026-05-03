const { google } = require('googleapis');
const path = require('path');
const { CREDENTIALS_PATH } = require('../config');

/**
 * Google Sheets API 클래스
 * Service Account 인증을 사용하여 구글 스프레드시트와 연결
 */
class GoogleSheetsAPI {
  constructor(credentialsPath = CREDENTIALS_PATH) {
    this.credentialsPath = credentialsPath;
    this.auth = null;
    this.sheets = null;
  }

  /**
   * Google Sheets API 인증 및 초기화.
   * 우선순위:
   *   1) process.env.GOOGLE_CREDENTIALS_JSON (Railway/Heroku 등 파일 시스템 없는 호스팅용 — JSON 문자열)
   *   2) keyFile (로컬 dev 또는 fly.io 처럼 파일 마운트 가능한 환경)
   */
  async authenticate() {
    try {
      const credsJson = process.env.GOOGLE_CREDENTIALS_JSON;
      const baseConfig = { scopes: ['https://www.googleapis.com/auth/spreadsheets'] };
      const authConfig = credsJson
        ? { ...baseConfig, credentials: JSON.parse(credsJson) }
        : { ...baseConfig, keyFile: this.credentialsPath };

      const auth = new google.auth.GoogleAuth(authConfig);
      this.auth = await auth.getClient();
      this.sheets = google.sheets({ version: 'v4', auth: this.auth });

      console.log(`✅ Google Sheets API 연결 성공 (source: ${credsJson ? 'env' : 'keyFile'})`);
      return true;
    } catch (error) {
      console.error('❌ Google Sheets 인증 실패:', error.message);
      throw error;
    }
  }

  /**
   * 스프레드시트에서 데이터 읽기
   * @param {string} spreadsheetId - 스프레드시트 ID (URL에서 확인 가능)
   * @param {string} range - 읽을 범위 (예: 'Sheet1!A1:D10')
   */
  async readData(spreadsheetId, range) {
    try {
      if (!this.sheets) {
        await this.authenticate();
      }

      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId,
        range,
      });

      const rows = response.data.values;

      if (!rows || rows.length === 0) {
        console.log('📭 데이터가 없습니다.');
        return [];
      }

      console.log(`✅ ${rows.length}개의 행을 읽었습니다.`);
      return rows;
    } catch (error) {
      console.error('❌ 데이터 읽기 실패:', error.message);
      throw error;
    }
  }

  /**
   * 스프레드시트에 데이터 쓰기 (덮어쓰기)
   * @param {string} spreadsheetId - 스프레드시트 ID
   * @param {string} range - 쓸 범위 (예: 'Sheet1!A1')
   * @param {Array<Array>} values - 2차원 배열 데이터
   */
  async writeData(spreadsheetId, range, values) {
    try {
      if (!this.sheets) {
        await this.authenticate();
      }

      const response = await this.sheets.spreadsheets.values.update({
        spreadsheetId,
        range,
        valueInputOption: 'USER_ENTERED', // 수식과 포맷 자동 인식
        resource: { values },
      });

      console.log(`✅ ${response.data.updatedCells}개의 셀이 업데이트되었습니다.`);
      return response.data;
    } catch (error) {
      console.error('❌ 데이터 쓰기 실패:', error.message);
      throw error;
    }
  }

  /**
   * 여러 범위에 한 번에 데이터 쓰기 (API 호출 1회)
   * @param {string} spreadsheetId
   * @param {Array<{range: string, values: Array<Array>}>} data - [{range, values}, ...]
   */
  async batchWriteData(spreadsheetId, data) {
    try {
      if (!this.sheets) {
        await this.authenticate();
      }

      const response = await this.sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        resource: {
          valueInputOption: 'USER_ENTERED',
          data: data.map(d => ({ range: d.range, values: d.values })),
        },
      });

      console.log(`✅ 배치 업데이트: ${response.data.totalUpdatedCells}개 셀`);
      return response.data;
    } catch (error) {
      console.error('❌ 배치 쓰기 실패:', error.message);
      throw error;
    }
  }

  /**
   * 스프레드시트에 데이터 추가 (기존 데이터 뒤에 추가)
   * @param {string} spreadsheetId - 스프레드시트 ID
   * @param {string} range - 추가할 시트 범위 (예: 'Sheet1!A:D')
   * @param {Array<Array>} values - 2차원 배열 데이터
   */
  async appendData(spreadsheetId, range, values) {
    try {
      if (!this.sheets) {
        await this.authenticate();
      }

      const response = await this.sheets.spreadsheets.values.append({
        spreadsheetId,
        range,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        resource: { values },
      });

      console.log(`✅ ${response.data.updates.updatedRows}개의 행이 추가되었습니다.`);
      return response.data;
    } catch (error) {
      console.error('❌ 데이터 추가 실패:', error.message);
      throw error;
    }
  }

  /**
   * 새로운 시트 생성
   * @param {string} spreadsheetId - 스프레드시트 ID
   * @param {string} sheetTitle - 새 시트 이름
   */
  async createSheet(spreadsheetId, sheetTitle, index) {
    try {
      if (!this.sheets) {
        await this.authenticate();
      }

      const properties = { title: sheetTitle };
      if (index !== undefined) properties.index = index;

      const response = await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        resource: {
          requests: [
            {
              addSheet: { properties },
            },
          ],
        },
      });

      const newSheetId = response.data.replies[0].addSheet.properties.sheetId;
      console.log(`✅ 새 시트 '${sheetTitle}' 생성 완료 (ID: ${newSheetId})`);
      return newSheetId;
    } catch (error) {
      console.error('❌ 시트 생성 실패:', error.message);
      throw error;
    }
  }

  /**
   * 시트 이름 변경
   */
  async renameSheet(spreadsheetId, sheetId, newTitle) {
    try {
      if (!this.sheets) {
        await this.authenticate();
      }

      await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        resource: {
          requests: [
            {
              updateSheetProperties: {
                properties: { sheetId, title: newTitle },
                fields: 'title',
              },
            },
          ],
        },
      });

      console.log(`✅ 시트 ID ${sheetId} → '${newTitle}' 이름 변경 완료`);
    } catch (error) {
      console.error('❌ 시트 이름 변경 실패:', error.message);
      throw error;
    }
  }

  /**
   * 시트 복제 (템플릿 탭 복사용)
   * @param {string} spreadsheetId - 스프레드시트 ID
   * @param {number} sourceSheetId - 복제할 원본 시트 ID
   * @param {string} newTitle - 새 시트 이름
   * @param {number} insertIndex - 삽입 위치 (0 = 맨 앞)
   * @returns {number} 새로 생성된 시트 ID
   */
  async duplicateSheet(spreadsheetId, sourceSheetId, newTitle, insertIndex = 0) {
    try {
      if (!this.sheets) {
        await this.authenticate();
      }

      const response = await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        resource: {
          requests: [
            {
              duplicateSheet: {
                sourceSheetId,
                insertSheetIndex: insertIndex,
                newSheetName: newTitle,
              },
            },
          ],
        },
      });

      const newSheetId = response.data.replies[0].duplicateSheet.properties.sheetId;
      console.log(`✅ 시트 복제 완료: '${newTitle}' (ID: ${newSheetId})`);
      return newSheetId;
    } catch (error) {
      console.error('❌ 시트 복제 실패:', error.message);
      throw error;
    }
  }

  /**
   * 시트 삭제
   * @param {string} spreadsheetId - 스프레드시트 ID
   * @param {number} sheetId - 삭제할 시트 ID
   */
  async deleteSheet(spreadsheetId, sheetId) {
    try {
      if (!this.sheets) {
        await this.authenticate();
      }

      await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        resource: {
          requests: [
            {
              deleteSheet: {
                sheetId: sheetId,
              },
            },
          ],
        },
      });

      console.log(`✅ 시트 ID ${sheetId} 삭제 완료`);
      return true;
    } catch (error) {
      console.error('❌ 시트 삭제 실패:', error.message);
      throw error;
    }
  }

  /**
   * 특정 범위의 데이터 삭제 (셀 내용만 지움)
   * @param {string} spreadsheetId - 스프레드시트 ID
   * @param {string} range - 삭제할 범위
   */
  async clearData(spreadsheetId, range) {
    try {
      if (!this.sheets) {
        await this.authenticate();
      }

      const response = await this.sheets.spreadsheets.values.clear({
        spreadsheetId,
        range,
      });

      console.log(`✅ ${range} 범위의 데이터가 삭제되었습니다.`);
      return response.data;
    } catch (error) {
      console.error('❌ 데이터 삭제 실패:', error.message);
      throw error;
    }
  }

  /**
   * 스프레드시트 메타데이터 가져오기
   * @param {string} spreadsheetId - 스프레드시트 ID
   */
  async getSpreadsheetInfo(spreadsheetId) {
    try {
      if (!this.sheets) {
        await this.authenticate();
      }

      const response = await this.sheets.spreadsheets.get({
        spreadsheetId,
      });

      const spreadsheet = response.data;
      console.log(`📊 스프레드시트: ${spreadsheet.properties.title}`);
      console.log(`📄 시트 목록:`);
      spreadsheet.sheets.forEach(sheet => {
        console.log(`  - ${sheet.properties.title} (ID: ${sheet.properties.sheetId})`);
      });

      return spreadsheet;
    } catch (error) {
      console.error('❌ 스프레드시트 정보 가져오기 실패:', error.message);
      throw error;
    }
  }
}

module.exports = GoogleSheetsAPI;
