// Tạo tab API và LOG trong Google Sheet, ghi tiêu đề, thêm vài dòng mẫu.
// Chạy: npm run init-sheet
import { config, API_COLUMNS, LOG_COLUMNS } from '../src/config.js';
import { ensureSheet, readTable, appendRows, serviceAccountEmail } from '../src/sheets.js';

const SAMPLES = [
  {
    id: 'mock-1', name: 'Mock test 1', type: 'mock', weight: 1, enabled: 'TRUE',
    note: 'Provider giả để test, không cần key. Tắt (FALSE) khi dùng thật.',
  },
  {
    id: 'mock-2', name: 'Mock test 2', type: 'mock', weight: 2, enabled: 'TRUE',
    note: 'Trọng số 2 = được chọn gấp đôi mock-1 khi strategy=weighted',
  },
  {
    id: 'openai-1', name: 'OpenAI GPT', type: 'openai', api_key: 'DIEN_KEY_VAO_DAY', model: 'gpt-4o-mini',
    weight: 1, enabled: 'FALSE', note: 'Điền key rồi đổi enabled = TRUE. Dùng được cho mọi API tương thích OpenAI (Groq, DeepSeek, OpenRouter...) bằng cách đổi url',
  },
  {
    id: 'gemini-1', name: 'Google Gemini', type: 'gemini', api_key: 'DIEN_KEY_VAO_DAY', model: 'gemini-3.8-flash',
    weight: 1, enabled: 'FALSE', note: 'Lấy key tại aistudio.google.com',
  },
  {
    id: 'claude-1', name: 'Anthropic Claude', type: 'claude', api_key: 'DIEN_KEY_VAO_DAY', model: 'claude-haiku-5-5',
    weight: 1, enabled: 'FALSE', note: 'Lấy key tại console.anthropic.com',
  },
  {
    id: 'groq-1', name: 'Groq (OpenAI-compatible)', type: 'openai', url: 'https://api.groq.com/openai/v1/chat/completions',
    api_key: 'DIEN_KEY_VAO_DAY', model: 'llama-3.3-70b-versatile', weight: 1, enabled: 'FALSE',
    note: 'Ví dụ API tương thích OpenAI: chỉ cần đổi url + model',
  },
  {
    id: 'generic-1', name: 'API tùy ý (ví dụ)', type: 'generic', url: 'https://example.com/api/ask?key={{api_key}}',
    method: 'POST', api_key: 'DIEN_KEY_VAO_DAY', headers: '{"Authorization":"Bearer {{api_key}}"}',
    body_template: '{"question":"{{prompt}}","lang":"vi"}', response_path: 'data.answer', weight: 1, enabled: 'FALSE',
    note: 'API bất kỳ: {{prompt}} {{system}} {{model}} {{api_key}} sẽ được thay. response_path = vị trí lấy text trong JSON trả về',
  },
];

async function main() {
  console.log(`Spreadsheet: ${config.spreadsheetId}`);
  console.log(`Service account: ${serviceAccountEmail()}`);

  const a = await ensureSheet(config.sheetApiName, API_COLUMNS);
  console.log(`Tab "${config.sheetApiName}": ${a.created ? 'đã tạo mới' : 'đã có'}${a.headerWritten ? ', đã ghi tiêu đề' : ''}`);
  const l = await ensureSheet(config.sheetLogName, LOG_COLUMNS);
  console.log(`Tab "${config.sheetLogName}": ${l.created ? 'đã tạo mới' : 'đã có'}${l.headerWritten ? ', đã ghi tiêu đề' : ''}`);

  const { items } = await readTable(config.sheetApiName);
  if (items.filter((i) => i.id).length === 0) {
    await appendRows(config.sheetApiName, SAMPLES.map((s) => API_COLUMNS.map((c) => (s[c] === undefined ? '' : String(s[c])))));
    console.log(`Đã thêm ${SAMPLES.length} dòng mẫu vào tab "${config.sheetApiName}"`);
  } else {
    console.log(`Tab "${config.sheetApiName}" đã có ${items.length} dòng, không thêm mẫu`);
  }
  console.log('Xong!');
}

main().catch((err) => {
  console.error('Lỗi:', err.message);
  if (/permission|403|not have permission/i.test(err.message)) {
    console.error(`\n=> Hãy mở Google Sheet, bấm "Chia sẻ" và thêm email sau với quyền Người chỉnh sửa:\n   ${serviceAccountEmail()}\n`);
  }
  if (/has not been used|disabled/i.test(err.message)) {
    console.error('\n=> Bật "Google Sheets API" cho project tại: https://console.cloud.google.com/apis/library/sheets.googleapis.com\n');
  }
  process.exit(1);
});
