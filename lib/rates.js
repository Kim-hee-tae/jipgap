// 금리(한국은행 ECOS) · 미분양(KOSIS) 수집
//
// ECOS  : ecos.bok.or.kr 에서 인증키 발급 → ECOS_KEY
//         ECOS_SERIES 로 받을 통계를 바꿀 수 있다. 형식 "이름:통계코드:항목코드,..."
//         기본값: 기준금리(722Y001/0101000), 주담대 금리 — 예금은행 신규취급액 주택담보대출(121Y006/BECBLA0302)
// KOSIS : kosis.kr 에서 「미분양주택현황」 표를 열고 OpenAPI URL 생성(시도별·월별, JSON) → KOSIS_UNSOLD_URL 에 통째로
//         (URL 안에 인증키가 들어 있다). 시점 범위는 넉넉하게(최근 5년 등) 잡아 두면 된다.
const path = require('path');
const { DATA, ymAdd, thisYm, readJson, writeJson } = require('./util');
const REGIONS = require('./regions.json');

const RATES_FILE = path.join(DATA, 'rates.json');
const UNSOLD_FILE = path.join(DATA, 'unsold.json');

const DEFAULT_SERIES = '기준금리:722Y001:0101000,주담대금리:121Y006:BECBLA0302';

async function getJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    try { return JSON.parse(text); } catch { throw new Error(`JSON 아님: ${text.slice(0, 120)}`); }
  } finally { clearTimeout(t); }
}

// → { 기준금리: { '202401': 3.5, ... }, 주담대금리: {...} }
async function fetchRates({ log = console.log } = {}) {
  const key = (process.env.ECOS_KEY || '').trim();
  if (!key) return null;
  const to = thisYm();
  const from = ymAdd(to, -12 * 10); // 10년치 — 점수의 비교 기준
  const out = readJson(RATES_FILE, {}) || {};
  for (const spec of (process.env.ECOS_SERIES || DEFAULT_SERIES).split(',')) {
    const [name, stat, item] = spec.split(':').map((s) => s.trim());
    if (!name || !stat) continue;
    const url = `https://ecos.bok.or.kr/api/StatisticSearch/${encodeURIComponent(key)}/json/kr/1/1000/${stat}/M/${from}/${to}/${item || ''}`;
    try {
      const data = await getJson(url);
      const rows = data?.StatisticSearch?.row;
      if (!Array.isArray(rows)) throw new Error(data?.RESULT?.MESSAGE || '데이터 없음');
      out[name] = {};
      for (const r of rows) { const v = Number(r.DATA_VALUE); if (Number.isFinite(v)) out[name][r.TIME] = v; }
      log(`[ecos] ${name}: ${rows.length}개월`);
    } catch (e) { log(`[ecos] ${name} 실패: ${e.message}`); }
  }
  writeJson(RATES_FILE, out);
  return out;
}

// KOSIS 응답 한 줄에서 지역 이름 찾기 (C1_NM / C2_NM ... 중 시도 이름인 것)
const SIDO_BY_NAME = new Map();
for (const s of REGIONS.sido) { SIDO_BY_NAME.set(s.name, s.code); SIDO_BY_NAME.set(s.full, s.code); }
for (const [a, b] of [['강원도', '51'], ['전라북도', '52'], ['제주도', '50'], ['세종시', '36']]) SIDO_BY_NAME.set(a, b);
function regionOf(row) {
  for (const k of ['C1_NM', 'C2_NM', 'C3_NM', 'C1_NM_ENG']) {
    const v = String(row[k] || '').trim();
    if (!v) continue;
    if (['계', '전국', '합계', '총계'].includes(v)) return '00';
    if (SIDO_BY_NAME.has(v)) return SIDO_BY_NAME.get(v);
  }
  return null;
}

// → { '00': { '202401': 62489 }, '11': {...}, ... }  (단위: 호)
async function fetchUnsold({ log = console.log } = {}) {
  const url = (process.env.KOSIS_UNSOLD_URL || '').trim();
  if (!url) return null;
  try {
    const rows = await getJson(url);
    if (!Array.isArray(rows)) throw new Error(rows?.errMsg || 'KOSIS 응답이 배열이 아님');
    const out = {};
    for (const r of rows) {
      const code = regionOf(r);
      const v = Number(String(r.DT).replace(/,/g, ''));
      const ym = String(r.PRD_DE || '').slice(0, 6);
      if (!code || !Number.isFinite(v) || !/^\d{6}$/.test(ym)) continue;
      (out[code] = out[code] || {})[ym] = (out[code][ym] || 0) + v; // 항목이 여러 개(규모별 등)면 합친다
    }
    if (!Object.keys(out).length) throw new Error('시도 이름을 찾지 못했어요 — 표를 시도별로 받았는지 확인');
    writeJson(UNSOLD_FILE, out);
    log(`[kosis] 미분양: ${Object.keys(out).length}개 지역`);
    return out;
  } catch (e) {
    log(`[kosis] 미분양 실패: ${e.message}`);
    return readJson(UNSOLD_FILE, null);
  }
}

module.exports = { fetchRates, fetchUnsold, RATES_FILE, UNSOLD_FILE, regionOf };
