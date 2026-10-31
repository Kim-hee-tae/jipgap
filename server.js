// 집값 점수판 — 실거래가로 보는 지역별 상승률·수요/공급/시황 점수
// kairu-kit: 자동 새로고침(version), JSON 저장(json-store), 서비스 워커
const path = require('path');
const http = require('http');
const fs = require('fs');
const { fork } = require('child_process');
const express = require('express');
const { mountVersion, sendIndex } = require('./kit/server/version');
const { createStore } = require('./kit/server/json-store');
const { DATA, PYEONG, readJson, kstDate, median } = require('./lib/util');
const { MODEL_FILE, BUILD_VER, bandOf } = require('./lib/build');
const molit = require('./lib/molit');
const { DEMO_ROOT } = require('./lib/demo');
const geo = require('./lib/geo');

const PORT = Number(process.env.PORT) || 3020;
const HOST = process.env.HOST || '0.0.0.0';
const UPDATE_HOUR = Number(process.env.UPDATE_HOUR ?? 6); // 매일 06시(한국 시간) 이후 첫 확인 때 갱신

// ── 데이터 (model.json 을 메모리에) ──
let model = null;
let searchList = [];
function loadModel() {
  const m = readJson(MODEL_FILE);
  if (!m || !m.regions) return false;
  model = m;
  searchList = Object.values(m.regions)
    .filter((r) => r.level !== 'dong' || r.trades6m >= 3)
    .map((r) => ({ code: r.code, name: r.name, full: r.full, level: r.level }));
  console.log(`[model] ${m.demo ? '데모' : '실데이터'} · 기준월 ${m.refYm} · 지역 ${searchList.length}곳`);
  return true;
}
loadModel();

// ── 하루 한 번 갱신 (자식 프로세스: 서버 메모리와 분리) ──
const state = createStore(path.join(DATA, 'state.json'), { lastRunDate: null, lastRun: null });
let updating = null;
let rebuiltSinceBoot = false; // 계산 방식이 바뀐 배포 뒤 한 번만 다시 집계
let triedSinceBoot = false; // 재시작(배포) 직후엔 1시간 기다리지 않고 바로 다시 시도
function runUpdate(reason, args = []) {
  if (updating) return false;
  const startedAt = new Date().toISOString();
  const logTail = [];
  updating = fork(path.join(__dirname, 'scripts/update.js'), args, { silent: true, execArgv: ['--max-old-space-size=450'] });
  const keep = (d) => { for (const l of String(d).split('\n').filter(Boolean)) { console.log(l); logTail.push(l); if (logTail.length > 30) logTail.shift(); } };
  updating.stdout.on('data', keep);
  updating.stderr.on('data', keep);
  console.log(`[update] 시작 (${reason})`);
  updating.on('exit', (code) => {
    updating = null;
    state.data.lastRun = { startedAt, endedAt: new Date().toISOString(), ok: code === 0, reason, realTried: Boolean((process.env.MOLIT_KEY || '').trim()), log: logTail };
    state.save();
    if (code === 0) loadModel();
  });
  if (!args.includes('--build')) state.data.lastRunDate = kstDate(); // 다시 집계만 할 땐 매일 수집 일정에 영향 없음
  state.save();
  return true;
}
function maybeUpdate() {
  const kstHour = (new Date().getUTCHours() + 9) % 24;
  if (!model) return runUpdate('처음 실행 — 데이터 없음');
  // 키를 넣었는데 아직 데모 화면이면 기다리지 않고 바로 수집 (키가 아직 활성화 전이면 1시간마다 다시 시도)
  if (model.demo && (process.env.MOLIT_KEY || '').trim()) {
    const last = state.data.lastRun ? Date.parse(state.data.lastRun.startedAt) : 0;
    if (!triedSinceBoot || !state.data.lastRun || !state.data.lastRun.realTried || Date.now() - last > 60 * 60 * 1000) {
      triedSinceBoot = true;
      return runUpdate('인증키 확인 — 실데이터로 전환');
    }
    return false;
  }
  if (!model.demo && model.buildVer !== BUILD_VER && !rebuiltSinceBoot) {
    rebuiltSinceBoot = true;
    return runUpdate('계산 방식 변경 — 받아 둔 데이터로 다시 집계', ['--build']);
  }
  if (state.data.lastRunDate !== kstDate() && kstHour >= UPDATE_HOUR) return runUpdate('매일 갱신');
  return false;
}
setTimeout(maybeUpdate, 2000);
setInterval(maybeUpdate, 10 * 60 * 1000);

// ── 앱 ──
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));
app.use('/kit', express.static(path.join(__dirname, 'kit/client')));
const version = mountVersion(app);
app.get(['/', '/index.html'], (req, res) => sendIndex(res, path.join(__dirname, 'public/index.html'), version));
// 티맵 지도 SDK 로더 — 키는 서버 .env 에만 두고 여기서 붙인다 (SDK 가 document.write 를 써서 head 에서 동기로 불러야 함)
app.get('/tmap-loader.js', (req, res) => {
  res.set('Cache-Control', 'no-cache').type('application/javascript');
  const k = geo.appKey();
  if (!k) return res.send('window.TMAP_OFF = true;');
  res.send(`document.write(${JSON.stringify(`<script src="https://apis.openapi.sk.com/tmap/jsv2?version=1&appKey=${encodeURIComponent(k)}"></scr`)} + 'ipt>');`);
});
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/status', (req, res) => res.json({
  ok: true, ready: Boolean(model), demo: model ? model.demo : null, refYm: model?.refYm || null,
  builtAt: model?.builtAt || null, updating: Boolean(updating), tmap: { key: geo.enabled(), lastError: geo.lastError() }, lastRun: state.data.lastRun && { ...state.data.lastRun, log: undefined },
}));

const need = (res) => { if (!model) { res.status(503).json({ error: '데이터를 준비하고 있어요. 1~2분 뒤 다시 열어 주세요.', preparing: true }); return false; } return true; };

app.get('/api/regions', (req, res) => {
  if (!need(res)) return;
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ regions: searchList });
});

// 하위 지역 요약 (트리맵·순위용)
const childSummary = (c) => ({ code: c.code, name: c.name, level: c.level, change: c.change, pppNow: c.pppNow, pppPast: c.pppPast, trades6m: c.trades6m, nApts: c.nApts });

function aptsFor(r, band) {
  if (r.level === 'nation' || r.level === 'sido') return model.topApts[r.code]?.[band] || [];
  const sgg = r.level === 'sgg' ? r.code : r.parent;
  return (model.aptsBySgg[sgg] || []).filter((a) => a.band === band && (r.level === 'sgg' || a.dong === r.code)).slice(0, 30);
}

app.get('/api/region/:code', (req, res) => {
  if (!need(res)) return;
  const r = model.regions[req.params.code];
  if (!r) return res.status(404).json({ error: '없는 지역이에요' });
  const band = model.bands.includes(req.query.band) ? req.query.band : '30평대';
  const parents = [];
  for (let p = model.regions[r.parent]; p; p = model.regions[p.parent]) parents.unshift({ code: p.code, name: p.name, level: p.level });
  const children = r.children.map((c) => model.regions[c]).filter((c) => c && c.change !== null && c.trades6m >= 3).map(childSummary).sort((a, b) => b.change - a.change);
  // 동은 점수가 없으니 시군구 점수를 보여 준다
  const scoreSrc = r.level === 'dong' ? model.regions[r.parent] : r;
  res.set('Cache-Control', 'public, max-age=120');
  res.json({
    meta: { demo: model.demo, collecting: Boolean(model.demo && (process.env.MOLIT_KEY || '').trim()), months: model.months, ref: model.ref, refYm: model.refYm, builtAt: model.builtAt, bands: model.bands, sources: model.sources },
    region: { ...r, children: undefined }, parents, children,
    scores: scoreSrc && { from: scoreSrc.code, name: scoreSrc.name, cats: scoreSrc.cats, indicators: scoreSrc.indicators, total: scoreSrc.total, totalLabel: scoreSrc.totalLabel, totalHistory: scoreSrc.totalHistory, totalChanged: scoreSrc.totalChanged, good: scoreSrc.good, bad: scoreSrc.bad },
    band, apts: aptsFor(r, band),
  });
});

// ── 단지 상세 (지도 + 실거래 내역) ──
const sggCache = new Map(); // 시군구 실거래 원본 (최근 12곳)
function sggRows(sgg) {
  const ck = `${sgg}|${model.builtAt}`;
  if (sggCache.has(ck)) return sggCache.get(ck);
  const root = model.demo ? DEMO_ROOT : DATA;
  const rows = [];
  for (const ym of molit.listMonths('trade', sgg, root)) for (const r of molit.readMonth('trade', sgg, ym, root)) rows.push([ym, ...r]);
  sggCache.set(ck, rows);
  if (sggCache.size > 12) sggCache.delete(sggCache.keys().next().value);
  return rows;
}
// rows: [월, 일, 법정동, 단지명, 단지ID, 전용㎡, 금액, 층, 건축년도, 지번, 거래구분, 등기일자]
app.get('/api/apt', async (req, res) => {
  if (!need(res)) return;
  const sgg = String(req.query.sgg || ''), id = String(req.query.id || '').slice(0, 120);
  if (!/^\d{5}$/.test(sgg) || !id || !model.regions[sgg]) return res.status(400).json({ error: '잘못된 요청이에요' });
  const match = id.includes('/') && !/^\d/.test(id) ? (r) => `${r[2]}/${r[3]}` === id : (r) => r[4] === id;
  const rows = sggRows(sgg).filter(match);
  if (!rows.length) return res.status(404).json({ error: '이 단지의 거래를 찾지 못했어요' });
  const calc = calcSteps(rows); // 정렬 전 (파일 순서) — 집계와 같은 순서로 계산
  rows.sort((a, b) => b[0].localeCompare(a[0]) || (b[1] || 0) - (a[1] || 0));
  const top = rows[0];
  const jibun = (rows.find((r) => r[9]) || [])[9] || '';
  const apt = { sgg, id, name: top[3], umd: top[2], built: top[8] || null, jibun, address: `${geo.regionName(sgg)} ${top[2]}${jibun ? ` ${jibun}` : ''}` };
  let pos = null, geoError = null;
  try { pos = model.demo ? geo.demoGeo(sgg, id) : await geo.geocode(apt); } catch (e) { geoError = e.geoError ? e.message : '위치 검색 중 오류가 났어요'; }
  res.set('Cache-Control', 'private, max-age=300');
  res.json({
    demo: model.demo, apt, geo: pos, geoError, mapKey: geo.enabled(),
    trades: rows.slice(0, 600).map((r) => ({ ym: r[0], day: r[1], area: r[5], price: r[6], floor: r[7], band: bandOf(r[5]), direct: r[10] === '직', rgst: r[11] || null, known: Boolean(r[10]) })),
    total: rows.length, calc,
  });
});

// 순위의 1년 상승률을 집계(lib/build.js)와 똑같이 다시 계산해 과정까지 돌려준다
//   기간: 최근 6개월(기준월 포함) / 1년 전 6개월, 각 기간 계약일 순 마지막 3건의 가운데 값
//   상승률은 평당가 가운데 값끼리, 금액 차이는 금액 가운데 값끼리
const LAST_N = 3;
function calcSteps(rows) {
  const { months, ref } = model;
  const idx = new Map(months.map((m, i) => [m, i]));
  const range = (from, to) => (to < 0 ? null : { from: months[Math.max(0, from)], to: months[to], lo: Math.max(0, from), hi: to });
  const recentR = range(ref - 5, ref), pastR = range(ref - 17, ref - 12);
  const out = {};
  for (const band of model.bands) {
    const list = [];
    for (const r of rows) {
      const area = r[5], i = idx.get(r[0]);
      if (!area || area < 10 || i === undefined || bandOf(area) !== band) continue;
      const ppp = r[6] / (area / PYEONG);
      if (!Number.isFinite(ppp) || ppp <= 0) continue;
      list.push({ i, ym: r[0], day: r[1] || 0, area, price: r[6], floor: r[7], ppp, direct: r[10] === '직', rgst: r[11] || null });
    }
    if (!list.length) continue;
    list.sort((a, b) => a.i - b.i || a.day - b.day); // 안정 정렬 → 집계와 같은 순서
    const part = (R) => {
      if (!R) return null;
      const all = list.filter((t) => t.i >= R.lo && t.i <= R.hi);
      const used = all.slice(-LAST_N);
      return {
        from: R.from, to: R.to, n: all.length,
        used: used.map(({ i, ...t }) => ({ ...t, ppp: Math.round(t.ppp) })),
        price: used.length ? Math.round(median(used.map((t) => t.price))) : null,
        ppp: used.length ? Math.round(median(used.map((t) => t.ppp))) : null,
        pppRaw: used.length ? median(used.map((t) => t.ppp)) : null,
      };
    };
    const recent = part(recentR), past = part(pastR);
    const ok = recent && past && recent.n >= 2 && past.n >= 2;
    out[band] = {
      refYm: months[ref], recent, past,
      change: ok ? Math.round((recent.pppRaw / past.pppRaw - 1) * 1000) / 10 : null,
      diff: ok ? recent.price - past.price : null,
      inNationalRank: ok && recent.n >= 3 && past.n >= 3,
    };
  }
  for (const c of Object.values(out)) for (const p of [c.recent, c.past]) if (p) delete p.pppRaw;
  return out;
}

app.use('/api', (req, res) => res.status(404).json({ error: '없는 주소예요' }));

const server = http.createServer(app);
server.listen(PORT, HOST, () => console.log(`집값 점수판 → http://localhost:${PORT}`));
module.exports = { app, server };
