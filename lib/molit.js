// 국토교통부 아파트 실거래가 (매매·전월세) 수집 — 공공데이터포털 API
//   매매  : RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade
//   전월세: RTMSDataSvcAptRent/getRTMSDataSvcAptRent
// 같은 인증키(MOLIT_KEY)로 두 API 모두 활용신청해야 한다.
//
// 시군구(LAWD_CD 5자리) × 계약월 단위로 data/raw/<kind>/<시군구>/<YYYYMM>.json 에 저장해 두고
// 이미 받은 달은 다시 받지 않는다 (최근 RECENT_REFRESH 개월만 매번 다시 받음 — 실거래 신고는 30일 안에 들어옴).
const fs = require('fs');
const path = require('path');
const { DATA, ymAdd, thisYm, kstDate, readJson, writeJson, sleep } = require('./util');
const REGIONS = require('./regions.json');

const ENDPOINT = {
  trade: 'https://apis.data.go.kr/1613000/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade',
  rent: 'https://apis.data.go.kr/1613000/RTMSDataSvcAptRent/getRTMSDataSvcAptRent',
};
const RECENT_REFRESH = 3;        // 최근 3개월은 매번 새로 받기
const ROWS = 1000;               // 한 페이지 최대 건수
const USAGE_FILE = path.join(DATA, 'molit-usage.json');

function serviceKey() {
  let k = (process.env.MOLIT_KEY || '').trim();
  // 포털의 "인코딩" 키를 붙여넣어도 되게 한 번 풀어 둔다 (URLSearchParams 가 다시 인코딩함)
  if (/%[0-9A-F]{2}/i.test(k)) { try { k = decodeURIComponent(k); } catch { /* 그대로 */ } }
  return k;
}
const rawFile = (kind, lawd, ym, root = DATA) => path.join(root, 'raw', kind, lawd, `${ym}.json`);

const num = (v) => {
  if (v === undefined || v === null) return null;
  const n = Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
};
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());

// API 한 건 → 저장용 짧은 배열
//   trade: [일, 법정동, 단지명, 단지ID, 전용㎡, 거래금액(만원), 층, 건축년도, 지번]  (지번은 2026-10-30 이후 받은 달부터)
//   rent : [일, 법정동, 단지명, 단지ID, 전용㎡, 보증금(만원), 월세(만원), 건축년도]
function compact(kind, it) {
  if (kind === 'trade') {
    if (str(it.cdealType) === 'O') return null; // 해제된 거래는 뺀다
    const price = num(it.dealAmount), area = num(it.excluUseAr);
    if (!price || !area) return null;
    return [num(it.dealDay), str(it.umdNm), str(it.aptNm), str(it.aptSeq), area, price, num(it.floor), num(it.buildYear), str(it.jibun)];
  }
  const dep = num(it.deposit), area = num(it.excluUseAr);
  if (dep === null || !area) return null;
  return [num(it.dealDay), str(it.umdNm), str(it.aptNm), str(it.aptSeq), area, dep, num(it.monthlyRent) || 0, num(it.buildYear)];
}

class ApiError extends Error {
  constructor(msg, code, fatal) { super(msg); this.code = code; this.fatal = fatal; }
}

async function callApi(kind, lawd, ym, page) {
  const url = new URL(ENDPOINT[kind]);
  url.searchParams.set('serviceKey', serviceKey());
  url.searchParams.set('LAWD_CD', lawd);
  url.searchParams.set('DEAL_YMD', ym);
  url.searchParams.set('pageNo', String(page));
  url.searchParams.set('numOfRows', String(ROWS));
  url.searchParams.set('_type', 'json');

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  let text;
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    text = await res.text();
    if (!res.ok && !text) throw new ApiError(`HTTP ${res.status}`, String(res.status), false);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(e.name === 'AbortError' ? '응답 시간 초과' : e.message, 'NET', false);
  } finally { clearTimeout(t); }

  // 인증키 오류·호출 한도 초과는 JSON 요청에도 XML 로 올 때가 있다
  if (text.trim().startsWith('<')) {
    const code = (text.match(/<(?:returnReasonCode|resultCode)>([^<]+)</) || [])[1] || 'XML';
    const msg = (text.match(/<(?:returnAuthMsg|resultMsg)>([^<]+)</) || [])[1] || text.slice(0, 120);
    throw new ApiError(`${msg} (${code})`, code, ['20', '22', '30', '31', '32', '33'].includes(code) || /SERVICE_KEY|LIMITED/i.test(msg));
  }
  let data;
  try { data = JSON.parse(text); } catch { throw new ApiError(`응답 해석 실패: ${text.slice(0, 120)}`, 'PARSE', false); }
  const header = data?.response?.header || {};
  if (header.resultCode !== '00' && header.resultCode !== '000') {
    const code = String(header.resultCode || '?');
    throw new ApiError(`${header.resultMsg || 'API 오류'} (${code})`, code, ['20', '22', '30', '31', '32', '33'].includes(code));
  }
  const body = data.response.body || {};
  let items = body.items?.item || [];
  if (!Array.isArray(items)) items = items ? [items] : [];
  return { items, total: Number(body.totalCount) || 0 };
}

// 시군구 한 곳 × 한 달 (여러 페이지) → 저장. 호출 횟수를 돌려준다.
async function fetchMonth(kind, lawd, ym) {
  const rows = [];
  let page = 1, calls = 0, total = 0;
  for (;;) {
    const r = await callApi(kind, lawd, ym, page);
    calls++;
    total = r.total;
    for (const it of r.items) { const c = compact(kind, it); if (c) rows.push(c); }
    if (page * ROWS >= total || !r.items.length) break;
    page++;
  }
  writeJson(rawFile(kind, lawd, ym), { fetchedAt: new Date().toISOString(), total, rows });
  return calls;
}

// 오늘 쓴 호출 수 (공공데이터포털 개발계정 일일 한도 관리)
function usage() {
  const u = readJson(USAGE_FILE, {});
  return u.date === kstDate() ? u : { date: kstDate(), trade: 0, rent: 0 };
}
function addUsage(kind, n) {
  const u = usage();
  u[kind] = (u[kind] || 0) + n;
  writeJson(USAGE_FILE, u);
}

// 받아야 할 (시군구, 월) 목록 — 최근 달 먼저, 그다음 오래된 달 채우기
function plan(kind, months) {
  const latest = ymAdd(thisYm(), 0);
  const jobs = [];
  for (let i = 0; i < months; i++) {
    const ym = ymAdd(latest, -i);
    for (const s of REGIONS.sgg) {
      const f = rawFile(kind, s.code, ym);
      if (i < RECENT_REFRESH) {
        // 최근 달: 오늘 이미 받았으면 건너뜀
        const got = readJson(f);
        if (got && kstDate(new Date(got.fetchedAt)) === kstDate()) continue;
        jobs.push({ kind, lawd: s.code, ym });
      } else if (!fs.existsSync(f)) jobs.push({ kind, lawd: s.code, ym });
    }
  }
  return jobs;
}

// 전체 수집. limit = 하루 API별 최대 호출 수
async function fetchAll({ kinds = ['trade', 'rent'], months = 36, limit = 9000, log = console.log } = {}) {
  if (!serviceKey()) throw new Error('MOLIT_KEY 가 없습니다');
  const summary = {};
  for (const kind of kinds) {
    const jobs = plan(kind, months);
    let done = 0, failed = 0;
    log(`[molit] ${kind}: 받을 것 ${jobs.length}건 (오늘 이미 ${usage()[kind]}회 호출)`);
    for (const j of jobs) {
      if (usage()[kind] >= limit) { log(`[molit] ${kind}: 오늘 호출 한도 ${limit}회 도달 — 나머지는 내일 이어서`); break; }
      try {
        addUsage(kind, await fetchMonth(kind, j.lawd, j.ym));
        done++;
      } catch (e) {
        failed++;
        addUsage(kind, 1);
        if (e.fatal) throw new Error(`[molit] ${kind} 중단: ${e.message}`);
        log(`[molit] ${kind} ${j.lawd} ${j.ym} 실패: ${e.message}`);
        if (failed > 50 && failed > done) { log('[molit] 실패가 너무 많아 중단'); break; }
        await sleep(1000);
      }
      await sleep(60); // 서버에 무리 주지 않게
    }
    summary[kind] = { planned: jobs.length, done, failed };
    log(`[molit] ${kind}: ${done}건 완료, ${failed}건 실패`);
  }
  return summary;
}

// 저장된 원본 읽기 (집계용)
function listMonths(kind, lawd, root = DATA) {
  const dir = path.join(root, 'raw', kind, lawd);
  try { return fs.readdirSync(dir).filter((f) => /^\d{6}\.json$/.test(f)).map((f) => f.slice(0, 6)).sort(); } catch { return []; }
}
function readMonth(kind, lawd, ym, root = DATA) {
  return readJson(rawFile(kind, lawd, ym, root), null)?.rows || [];
}

module.exports = { fetchAll, fetchMonth, listMonths, readMonth, rawFile, serviceKey, usage, compact, callApi };
