import fs from 'node:fs';
import { google } from 'googleapis';
import { config } from './config.js';

let sheetsClient = null;

/**
 * Key Google lấy từ biến môi trường GOOGLE_CREDENTIALS_JSON (nội dung JSON, tiện cho Render/Railway...)
 * hoặc từ file GOOGLE_CREDENTIALS_FILE (mặc định ./credentials/service-account.json)
 */
function loadCredentials() {
  const raw = process.env.GOOGLE_CREDENTIALS_JSON;
  if (raw && raw.trim()) {
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error('GOOGLE_CREDENTIALS_JSON không phải JSON hợp lệ (dán nguyên nội dung file service-account.json)');
    }
  }
  if (!fs.existsSync(config.credentialsFile)) {
    throw new Error(`Không tìm thấy file credentials: ${config.credentialsFile} (hoặc đặt biến GOOGLE_CREDENTIALS_JSON)`);
  }
  return JSON.parse(fs.readFileSync(config.credentialsFile, 'utf8'));
}

export function getSheets() {
  if (sheetsClient) return sheetsClient;
  const auth = new google.auth.GoogleAuth({
    credentials: loadCredentials(),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

export function serviceAccountEmail() {
  try {
    return loadCredentials().client_email;
  } catch {
    return '(không đọc được)';
  }
}

/** Đổi chỉ số cột (bắt đầu từ 0) thành chữ: 0 -> A, 26 -> AA */
export function colLetter(index) {
  let s = '';
  let n = index + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Đọc sheet thành mảng object theo dòng tiêu đề. Mỗi object có _row = số dòng thật trong sheet */
export async function readTable(sheetName) {
  const res = await getSheets().spreadsheets.values.get({
    spreadsheetId: config.spreadsheetId,
    range: `${sheetName}!A1:ZZ`,
  });
  const rows = res.data.values || [];
  if (rows.length === 0) return { headers: [], items: [] };
  const headers = rows[0].map((h) => String(h).trim());
  const items = rows.slice(1).map((r, i) => {
    const obj = { _row: i + 2 };
    headers.forEach((h, c) => (obj[h] = r[c] !== undefined ? r[c] : ''));
    return obj;
  });
  return { headers, items };
}

export async function appendRows(sheetName, rows) {
  if (!rows.length) return;
  await getSheets().spreadsheets.values.append({
    spreadsheetId: config.spreadsheetId,
    range: `${sheetName}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });
}

export async function updateRow(sheetName, rowNumber, values) {
  await getSheets().spreadsheets.values.update({
    spreadsheetId: config.spreadsheetId,
    range: `${sheetName}!A${rowNumber}:${colLetter(values.length - 1)}${rowNumber}`,
    valueInputOption: 'RAW',
    requestBody: { values: [values] },
  });
}

export async function getSheetIdByName(sheetName) {
  const meta = await getSheets().spreadsheets.get({ spreadsheetId: config.spreadsheetId });
  const s = meta.data.sheets.find((x) => x.properties.title === sheetName);
  return s ? s.properties.sheetId : null;
}

export async function deleteRow(sheetName, rowNumber) {
  const sheetId = await getSheetIdByName(sheetName);
  if (sheetId === null) throw new Error(`Không có sheet ${sheetName}`);
  await getSheets().spreadsheets.batchUpdate({
    spreadsheetId: config.spreadsheetId,
    requestBody: {
      requests: [
        { deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: rowNumber - 1, endIndex: rowNumber } } },
      ],
    },
  });
}

/** Tạo tab nếu chưa có, ghi dòng tiêu đề, tô màu + cố định dòng 1 */
export async function ensureSheet(sheetName, columns) {
  const sheets = getSheets();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: config.spreadsheetId });
  let sheet = meta.data.sheets.find((s) => s.properties.title === sheetName);
  let created = false;
  if (!sheet) {
    const r = await sheets.spreadsheets.batchUpdate({
      spreadsheetId: config.spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: sheetName } } }] },
    });
    sheet = { properties: r.data.replies[0].addSheet.properties };
    created = true;
  }
  const sheetId = sheet.properties.sheetId;
  const lastCol = colLetter(columns.length - 1);

  const head = await sheets.spreadsheets.values.get({
    spreadsheetId: config.spreadsheetId,
    range: `${sheetName}!A1:${lastCol}1`,
  });
  const current = (head.data.values && head.data.values[0]) || [];
  const same = columns.every((c, i) => current[i] === c);
  if (!same) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.spreadsheetId,
      range: `${sheetName}!A1:${lastCol}1`,
      valueInputOption: 'RAW',
      requestBody: { values: [columns] },
    });
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: config.spreadsheetId,
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: columns.length },
            cell: {
              userEnteredFormat: {
                textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
                backgroundColor: { red: 0.2, green: 0.3, blue: 0.55 },
              },
            },
            fields: 'userEnteredFormat(textFormat,backgroundColor)',
          },
        },
        {
          updateSheetProperties: {
            properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
            fields: 'gridProperties.frozenRowCount',
          },
        },
      ],
    },
  });
  return { created, headerWritten: !same };
}

/** Ghi nhiều vùng một lần: [{ range: 'KEYS!L2:O2', values: [[...]] }] */
export async function batchUpdateValues(data) {
  if (!data.length) return;
  await getSheets().spreadsheets.values.batchUpdate({
    spreadsheetId: config.spreadsheetId,
    requestBody: { valueInputOption: 'RAW', data },
  });
}
