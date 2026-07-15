import { readFile, writeFile } from 'node:fs/promises';
import { pbkdf2Sync, createDecipheriv, createCipheriv, randomBytes } from 'node:crypto';

const dashboardFile = process.env.DASHBOARD_FILE || '03-token-usage.html';
const password = process.env.DASHBOARD_PASSWORD;
const apiKey = process.env.OPENROUTER_API_KEY;
const fixturePath = process.env.OPENROUTER_FIXTURE;
const rankingsUrl = process.env.OPENROUTER_RANKINGS_URL || 'https://openrouter.ai/api/v1/datasets/rankings-daily';

if (!password) throw new Error('DASHBOARD_PASSWORD is required');
if (!apiKey && !fixturePath) throw new Error('OPENROUTER_API_KEY is required');

function b64(value) {
  return Buffer.from(value, 'base64');
}

function decryptPage(wrapper) {
  const salt = b64(wrapper.match(/var SALT="([^"]+)"/)[1]);
  const iv = b64(wrapper.match(/IV="([^"]+)"/)[1]);
  const encrypted = b64(wrapper.match(/CT="([^"]+)"/)[1]);
  const ciphertext = encrypted.subarray(0, -16);
  const tag = encrypted.subarray(-16);
  const key = pbkdf2Sync(password, salt, 150000, 32, 'sha256');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function encryptPage(plaintext) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = pbkdf2Sync(password, salt, 150000, 32, 'sha256');
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>DecadeX</title></head><body>
<script>
var SALT="${salt.toString('base64')}",IV="${iv.toString('base64')}",CT="${encrypted.toString('base64')}";
function b64d(s){return Uint8Array.from(atob(s),function(c){return c.charCodeAt(0);});}
function goLogin(err){var n=location.pathname.split("/").pop()||"index.html";location.replace("login.html?next="+encodeURIComponent(n)+(err?"&e=1":""));}
(async function(){
  var pw=null; try{pw=sessionStorage.getItem("dx_pw");}catch(e){}
  if(!pw){ goLogin(false); return; }
  try{
    var base=await crypto.subtle.importKey("raw",new TextEncoder().encode(pw),"PBKDF2",false,["deriveKey"]);
    var key=await crypto.subtle.deriveKey({name:"PBKDF2",salt:b64d(SALT),iterations:150000,hash:"SHA-256"},base,{name:"AES-GCM",length:256},false,["decrypt"]);
    var pt=await crypto.subtle.decrypt({name:"AES-GCM",iv:b64d(IV)},key,b64d(CT));
    var html=new TextDecoder().decode(pt);
    document.open();document.write(html);document.close();
  }catch(e){
    try{sessionStorage.removeItem("dx_pw");sessionStorage.removeItem("dx_auth");}catch(_){}
    goLogin(true);
  }
})();
</script>
</body></html>`;
}

function extractDashboardData(source) {
  const marker = 'window.TOKEN_DASHBOARD_DATA = ';
  const start = source.indexOf(marker);
  if (start < 0) throw new Error('Dashboard data marker not found');
  const jsonStart = start + marker.length;
  const jsonEnd = source.indexOf(';\n\n</script>', jsonStart);
  if (jsonEnd < 0) throw new Error('Dashboard data end marker not found');
  return {
    data: JSON.parse(source.slice(jsonStart, jsonEnd)),
    jsonStart,
    jsonEnd,
  };
}

async function fetchRankings() {
  if (fixturePath) return JSON.parse(await readFile(fixturePath, 'utf8'));

  const firstDate = '2025-01-01';
  const lastDate = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const payloads = [];
  let chunkStart = firstDate;

  while (chunkStart <= lastDate) {
    const chunkEndDate = new Date(`${chunkStart}T00:00:00Z`);
    chunkEndDate.setUTCDate(chunkEndDate.getUTCDate() + 365);
    const chunkEnd = [chunkEndDate.toISOString().slice(0, 10), lastDate].sort()[0];
    const url = new URL(rankingsUrl);
    url.searchParams.set('start_date', chunkStart);
    url.searchParams.set('end_date', chunkEnd);
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
    });
    if (!response.ok) {
      throw new Error(`OpenRouter request failed for ${chunkStart} through ${chunkEnd}: ${response.status} ${await response.text()}`);
    }
    payloads.push(await response.json());

    const nextStartDate = new Date(`${chunkEnd}T00:00:00Z`);
    nextStartDate.setUTCDate(nextStartDate.getUTCDate() + 1);
    chunkStart = nextStartDate.toISOString().slice(0, 10);
  }

  return {
    data: payloads.flatMap(payload => payload.data || []),
    meta: {
      ...payloads.at(-1)?.meta,
      as_of: payloads.at(-1)?.meta?.as_of,
      start_date: payloads[0]?.meta?.start_date || firstDate,
      end_date: payloads.at(-1)?.meta?.end_date || lastDate,
    },
  };
}

function defaultCompany(prefix) {
  return {
    name: prefix,
    shortName: prefix,
    category: '未校准',
    region: 'Unknown',
    coveragePct: 1,
    coverageLowPct: 0.3,
    coverageHighPct: 3,
    confidence: '很低',
    confidenceScore: 10,
    basis: '数据中存在该 OpenRouter 前缀，但尚未人工校准。',
    sourceType: '默认 prior',
    defaultIncluded: false,
  };
}

function rebuildData(previous, payload) {
  if (!Array.isArray(payload.data) || !payload.data.length) {
    throw new Error('OpenRouter returned no ranking rows');
  }

  const apiRows = payload.data.filter(row =>
    row && row.date && row.model_permaslug && row.total_tokens != null,
  );
  const dates = [...new Set(apiRows.map(row => row.date))].sort();
  const models = [...new Set(apiRows.map(row => row.model_permaslug))].sort();
  const dateIndex = new Map(dates.map((date, index) => [date, index]));
  const modelIndex = new Map(models.map((model, index) => [model, index]));
  const rows = apiRows.map(row => [
    dateIndex.get(row.date),
    modelIndex.get(row.model_permaslug),
    Number(row.total_tokens),
  ]);

  for (const model of models) {
    const prefix = model.includes('/') ? model.split('/')[0] : model;
    if (!previous.companies[prefix]) previous.companies[prefix] = defaultCompany(prefix);
  }

  return {
    meta: {
      ...previous.meta,
      generatedAtUtc: payload.meta?.as_of || new Date().toISOString(),
      sourceCsv: 'https://openrouter.ai/api/v1/datasets/rankings-daily',
      startDate: payload.meta?.start_date || dates[0],
      endDate: payload.meta?.end_date || dates.at(-1),
      rowCount: rows.length,
      modelCount: models.length,
      dateCount: dates.length,
    },
    dates,
    models,
    rows,
    companies: previous.companies,
    calibrations: previous.calibrations,
  };
}

function updateVisibleMetadata(source, data, payload) {
  const prefixCount = new Set(data.models.map(model => model.includes('/') ? model.split('/')[0] : model)).size;
  const asOf = payload.meta?.as_of || data.meta.generatedAtUtc;
  source = source.replace(
    /<span><b>数据窗口<\/b> [^<]+<\/span>/,
    `<span><b>数据窗口</b> ${data.meta.startDate} → ${data.meta.endDate}</span>`,
  );
  source = source.replace(
    /<span><b>数据点<\/b> [^<]+<\/span>/,
    `<span><b>数据点</b> ${data.meta.rowCount.toLocaleString('en-US')}</span>`,
  );
  source = source.replace(
    /<span><b>模型<\/b> [^<]+<\/span>/,
    `<span><b>模型</b> ${data.meta.modelCount}</span>`,
  );
  source = source.replace(
    /OpenRouter <code>rankings-daily<\/code> dataset API（<code>[^<]+<\/code> → <code>[^<]+<\/code>，[^）]+）。/,
    `OpenRouter <code>rankings-daily</code> dataset API（<code>${data.meta.startDate}</code> → <code>${data.meta.endDate}</code>，${data.meta.rowCount.toLocaleString('en-US')} 行，${prefixCount} 个 model permaslug 前缀）。`,
  );
  source = source.replace(
    /(?:Source: OpenRouter \(openrouter\.ai\/rankings\), as of [^。]+。)?聚合按前缀映射到公司。校准与覆盖率假设见/,
    `Source: OpenRouter (openrouter.ai/rankings), as of ${asOf}。聚合按前缀映射到公司。校准与覆盖率假设见`,
  );
  source = source.replace(
    "数据未加载，请确认 references/openrouter/openrouter_token_dashboard_data.js 存在。",
    '数据未加载，请稍后重试。',
  );
  return source;
}

const wrapper = await readFile(dashboardFile, 'utf8');
let source = decryptPage(wrapper);
const extracted = extractDashboardData(source);
const payload = await fetchRankings();
const updatedData = rebuildData(extracted.data, payload);
source = source.slice(0, extracted.jsonStart) + JSON.stringify(updatedData) + source.slice(extracted.jsonEnd);
source = updateVisibleMetadata(source, updatedData, payload);
await writeFile(dashboardFile, encryptPage(source));

console.log(`Updated ${dashboardFile}: ${updatedData.meta.startDate} through ${updatedData.meta.endDate}, ${updatedData.rows.length} rows.`);
