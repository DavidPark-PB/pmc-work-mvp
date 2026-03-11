import { google } from 'googleapis';
import { readFileSync } from 'fs';

const SPREADSHEET_ID = '1ArkhXbz8rRTQP2yO4FQKCJSYx-9Tj8c0opz0cHQXD8M';
const creds = JSON.parse(readFileSync('./config/credentials.json', 'utf8'));

const auth = new google.auth.JWT(
  creds.client_email,
  undefined,
  creds.private_key,
  ['https://www.googleapis.com/auth/spreadsheets.readonly']
);

const sheets = google.sheets({ version: 'v4', auth });

async function peek() {
  // 1. Get sheet names
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  console.log('=== Sheets ===');
  for (const s of meta.data.sheets || []) {
    console.log(`  - ${s.properties?.title} (${s.properties?.gridProperties?.rowCount} rows)`);
  }

  // 2. Read header + first 5 rows of main sheet
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: '시트1!A1:Z6',
  });
  console.log('\n=== Header + Sample (시트1) ===');
  for (const row of res.data.values || []) {
    console.log(row.join(' | '));
  }

  // 3. Total row count
  const allRows = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: '시트1!A:A',
  });
  console.log(`\n=== Total rows: ${(allRows.data.values || []).length} ===`);
}

peek().catch(console.error);
