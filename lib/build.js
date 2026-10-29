// 집계 — 저장된 실거래 원본(raw) → 화면에 쓸 model.json
//
// 지역 단계: 전국(00) → 시도(11) → 시군구(11680) → 읍면동(11680:대치동)
// 평당가   : 거래금액 ÷ (전용면적 ÷ 3.3058) — 만원/평 (전용 기준), 3개월 묶어 중앙값
// 1년 상승률: 같은 단지·같은 평형대의 "최근 6개월 vs 1년 전 6개월" 중앙값 변화를
//            거래 수 가중 중앙값으로 묶음 → 비싼 단지 거래가 몰린 달에 출렁이지 않게
// 점수     : 각 지표의 지금 값이 그 지표의 과거 분포에서 몇 % 위치인지 → 1~10점
const path = require('path');
const { DATA, PYEONG, ymAdd, thisYm, median, weightedMedian, percentile, round, readJson, writeJson } = require('./util');
const { listMonths, readMonth } = require('./molit');
const REGIONS = require('./regions.json');

const MODEL_FILE = path.join(DATA, 'model.json');
const BUCKET = 5; // 평당가 히스토그램 칸 (만원)

// ── 평형대 (전용면적 기준, 공급 평형으로 흔히 부르는 이름) ──
const BANDS = ['20평대 이하', '20평대', '30평대', '40평대 이상'];
function bandOf(area) {
  if (area < 50) return '20평대 이하';   // 전용 ~49㎡ (공급 10평대)
  if (area < 70) return '20평대';        // 전용 59㎡ 근처
  if (area < 100) return '30평대';       // 전용 84㎡ 근처
  return '40평대 이상';
}

// ── 히스토그램 (큰 지역도 메모리 적게 중앙값 구하기) ──
class Hist {
  constructor() { this.m = new Map(); this.n = 0; }
  add(v) { const b = Math.round(v / BUCKET); this.m.set(b, (this.m.get(b) || 0) + 1); this.n++; }
  merge(o) { for (const [b, c] of o.m) this.m.set(b, (this.m.get(b) || 0) + c); this.n += o.n; return this; }
  median() {
    if (!this.n) return null;
    const keys = [...this.m.keys()].sort((a, b) => a - b);
    let acc = 0;
    for (const k of keys) { acc += this.m.get(k); if (acc >= this.n / 2) return k * BUCKET; }
    return keys[keys.length - 1] * BUCKET;
  }
}
const mergeHists = (list) => list.reduce((h, x) => (x ? h.merge(x) : h), new Hist());

// ── 지표 정의 ──
// better: 'high' 면 클수록 좋음(점수 높음), 'low' 면 작을수록 좋음
const INDICATORS = [
  { id: 'vol', cat: '수요', name: '매매 거래량', unit: '건/3개월', better: 'high', desc: '최근 3개월 아파트 매매 건수. 많을수록 사려는 사람이 많다는 뜻' },
  { id: 'jeonse', cat: '수요', name: '전세가율', unit: '%', better: 'high', desc: '매매가 대비 전세가 비율. 높을수록 매매로 갈아탈 수요가 커짐' },
  { id: 'mortgage', cat: '수요', name: '주택담보대출 금리', unit: '%', better: 'low', desc: '예금은행 신규 주담대 금리. 낮을수록 사기 쉬움' },
  { id: 'base', cat: '수요', name: '기준금리', unit: '%', better: 'low', desc: '한국은행 기준금리' },
  { id: 'unsold', cat: '공급', name: '미분양', unit: '호', better: 'low', desc: '팔리지 않은 새 아파트 수 (시도 단위). 적을수록 공급 부담이 작음' },
  { id: 'mom3', cat: '시황', name: '3개월 가격 흐름', unit: '%', better: 'high', desc: '평당가 최근 3개월 vs 그 전 3개월' },
  { id: 'yoy', cat: '시황', name: '1년 가격 변화', unit: '%', better: 'high', desc: '평당가 1년 전 대비' },
  { id: 'volMom', cat: '시황', name: '거래량 흐름', unit: '배', better: 'high', desc: '최근 3개월 거래량 ÷ 지난 1년 평균' },
];
const CATS = ['수요', '공급', '시황'];

function scoreOf(p, better) {
  if (p === null) return null;
  const q = better === 'low' ? 1 - p : p;
  return Math.min(10, Math.max(1, 1 + Math.floor(q * 10)));
}
function labelOf(score) {
  if (score === null || score === undefined) return '데이터 없음';
  if (score < 2.5) return '매우유의';
  if (score < 4.5) return '유의';
  if (score < 6.5) return '보통';
  if (score < 8.5) return '좋음';
  return '매우좋음';
}

// 기준월: 이번 달은 아직 신고가 덜 들어왔으니 빼고, 전국 거래량이 평소의 60% 이상인 마지막 달
function refMonth(months, nationCounts) {
  const cur = thisYm();
  for (let i = months.length - 1; i >= 0; i--) {
    if (months[i] >= cur) continue;
    const prev = nationCounts.slice(Math.max(0, i - 12), i).filter((v) => v > 0);
    if (!prev.length || nationCounts[i] >= 0.6 * median(prev)) return i;
  }
  return months.length - 1;
}

function build({ root = DATA, demo = false, log = console.log } = {}) {
  const t0 = Date.now();
  // 1) 쓸 달 범위
  const set = new Set();
  for (const s of REGIONS.sgg) for (const ym of listMonths('trade', s.code, root)) set.add(ym);
  const months = [...set].sort().filter((ym) => ym <= thisYm());
  if (!months.length) throw new Error('집계할 실거래 데이터가 없습니다');
  const M = months.length;
  const idx = new Map(months.map((m, i) => [m, i]));

  // 1-2) 기준월을 먼저 정한다 (전국 월별 거래 수만 가볍게 세기)
  const nationCount = new Array(M).fill(0);
  for (const s of REGIONS.sgg) for (const ym of listMonths('trade', s.code, root)) {
    const i = idx.get(ym);
    if (i !== undefined) nationCount[i] += readMonth('trade', s.code, ym, root).length;
  }
  const ref = refMonth(months, nationCount);
  const keepFrom = ref - 17; // 단지별 비교에 쓰는 가장 오래된 달

  // 2) 지역 뼈대
  const regions = {};
  const mk = (code, name, level, parent, full) => {
    regions[code] = {
      code, name, full: full || name, level, parent, children: [],
      sale: Array.from({ length: M }, () => null), rentJ: Array.from({ length: M }, () => null), n: new Array(M).fill(0),
    };
    if (parent && regions[parent]) regions[parent].children.push(code);
    return regions[code];
  };
  mk('00', '전국', 'nation', null);
  for (const s of REGIONS.sido) mk(s.code, s.name, 'sido', '00', s.full);
  for (const s of REGIONS.sgg) mk(s.code, s.name, 'sgg', s.sido, `${REGIONS.sido.find((x) => x.code === s.sido).name} ${s.name}`);

  const addTo = (reg, i, kind, v) => {
    const arr = kind === 'sale' ? reg.sale : reg.rentJ;
    (arr[i] = arr[i] || new Hist()).add(v);
    if (kind === 'sale') reg.n[i]++;
  };

  // 히스토그램 → 시계열로 바꾸고 히스토그램은 버린다 (메모리 절약)
  const finalize = (reg) => {
    const sale = months.map((_, i) => mergeHists([reg.sale[i - 2], reg.sale[i - 1], reg.sale[i]]));
    const rentJ = months.map((_, i) => mergeHists([reg.rentJ[i - 2], reg.rentJ[i - 1], reg.rentJ[i]]));
    const ppp = sale.map((h) => (h.n >= 3 ? h.median() : null));
    const jeonsePpp = rentJ.map((h) => (h.n >= 3 ? h.median() : null));
    const recentH = mergeHists(reg.sale.slice(Math.max(0, ref - 5), ref + 1));
    const pastH = mergeHists(reg.sale.slice(Math.max(0, ref - 17), Math.max(0, ref - 11)));
    reg.pre = {
      ppp,
      jeonse: ppp.map((v, i) => (v && jeonsePpp[i] ? round((jeonsePpp[i] / v) * 100, 1) : null)),
      pppNow: recentH.n >= 3 ? recentH.median() : null,
      pppPast: pastH.n >= 3 ? pastH.median() : null,
      trades6m: recentH.n,
    };
    reg.sale = null; reg.rentJ = null;
  };

  // 단지별 1년 상승률 (최근 6개월 vs 1년 전 6개월) — 시군구 하나씩 계산하고 버린다
  const aptStats = [];
  let nAptKeys = 0;
  const win = (a, from, to) => { const xs = []; for (let i = Math.max(0, from); i <= to; i++) { const f = a.m.get(i); if (f) for (let k = 0; k < f.length; k += 2) xs.push([f[k], f[k + 1]]); } return xs; };
  const flushApts = (apts) => {
    nAptKeys += apts.size;
    for (const a of apts.values()) {
      const rec = win(a, ref - 5, ref), past = win(a, ref - 17, ref - 12);
      if (rec.length < 2 || past.length < 2) continue;
      const pr = median(rec.map((x) => x[0])), pp = median(past.map((x) => x[0]));
      aptStats.push({
        key: a.key, sgg: a.sgg, dong: a.dong, name: a.name, umd: a.umd, band: a.band, built: a.built,
        area: round(median(a.areas), 1), ppp: round(pr), pppPast: round(pp),
        price: round(median(rec.map((x) => x[1]))), pricePast: round(median(past.map((x) => x[1]))),
        change: round((pr / pp - 1) * 100, 1), nRec: rec.length, nPast: past.length,
      });
    }
  };

  // 3) 시군구별로 읽으면서 집계 (한 번에 전국을 메모리에 올리지 않음)
  let tradeRows = 0;
  for (const s of REGIONS.sgg) {
    const apts = new Map(); // key -> 단지·평형대 거래 (이 시군구만)
    const sgg = regions[s.code], sido = regions[s.sido], nation = regions['00'];
    for (const kind of ['trade', 'rent']) {
      for (const ym of listMonths(kind, s.code, root)) {
        const i = idx.get(ym);
        if (i === undefined) continue;
        for (const r of readMonth(kind, s.code, ym, root)) {
          const [, umd, aptNm, aptSeq, area] = r;
          if (!area || area < 10) continue;
          const dongCode = `${s.code}:${umd || '기타'}`;
          const dong = regions[dongCode] || mk(dongCode, umd || '기타', 'dong', s.code, `${sgg.full} ${umd || '기타'}`);
          if (kind === 'trade') {
            const ppp = r[5] / (area / PYEONG);
            if (!Number.isFinite(ppp) || ppp <= 0) continue;
            tradeRows++;
            for (const reg of [dong, sgg, sido, nation]) addTo(reg, i, 'sale', ppp);
            const band = bandOf(area);
            const key = `${s.code}|${aptSeq || `${umd}/${aptNm}`}|${band}`;
            let a = apts.get(key);
            if (!a) {
              a = { key, sgg: s.code, dong: dongCode, name: aptNm, umd, band, built: r[7] || null, areas: [], m: new Map() };
              apts.set(key, a);
            }
            if (a.areas.length < 50) a.areas.push(area);
            if (i >= keepFrom) {
              let f = a.m.get(i);
              if (!f) { f = []; a.m.set(i, f); }
              f.push(ppp, r[5]); // [평당가, 금액, 평당가, 금액, ...] 평평하게
            }
          } else if (!r[6]) { // 월세 0 = 전세
            const ppp = r[5] / (area / PYEONG);
            if (!Number.isFinite(ppp) || ppp <= 0) continue;
            for (const reg of [dong, sgg, sido, nation]) addTo(reg, i, 'rent', ppp);
          }
        }
      }
    }
    // 이 시군구와 그 동네들은 다 읽었으니 정리
    flushApts(apts);
    for (const c of sgg.children) finalize(regions[c]);
    finalize(sgg);
  }
  for (const s of REGIONS.sido) finalize(regions[s.code]);
  finalize(regions['00']);
  log(`[build] 매매 ${tradeRows}건, ${M}개월 (${months[0]}~${months[M - 1]}), 기준월 ${months[ref]}`);
  log(`[build] 단지·평형대 ${nAptKeys}개 중 비교 가능 ${aptStats.length}개`);

  // 5) 지역별 시계열·상승률
  const parents = (code) => { const out = []; let c = regions[code]; while (c) { out.push(c.code); c = regions[c.parent]; } return out; };
  const byRegion = new Map(); // 지역 -> 단지 통계 목록
  for (const s of aptStats) for (const c of parents(s.dong)) { if (!byRegion.has(c)) byRegion.set(c, []); byRegion.get(c).push(s); }

  const rates = readJson(path.join(root, 'rates.json'), {}) || {};
  const unsold = readJson(path.join(root, 'unsold.json'), {}) || {};
  // 외부 통계(금리·미분양)는 발표가 1~2달 늦으므로 마지막 값을 최대 3개월 이어 쓴다
  const ext = (series) => {
    let last = null, age = 99;
    return months.map((ym) => {
      if (series && series[ym] !== undefined) { last = series[ym]; age = 0; return last; }
      age++;
      return age <= 3 ? last : null;
    });
  };
  // 그 달까지의 긴 기록 (점수 비교 기준)
  const longUpTo = (series, ym) => Object.keys(series || {}).filter((k) => k <= ym).map((k) => series[k]);

  const out = {};
  for (const reg of Object.values(regions)) {
    const { ppp, jeonse } = reg.pre;
    const list = byRegion.get(reg.code) || [];
    let change = null;
    if (list.length >= 3) change = round(weightedMedian(list.map((s) => [s.change, Math.min(s.nRec, s.nPast)])), 1);
    else if (ppp[ref] && ppp[ref - 12]) change = round((ppp[ref] / ppp[ref - 12] - 1) * 100, 1);
    const o = {
      code: reg.code, name: reg.name, full: reg.full, level: reg.level, parent: reg.parent, children: reg.children,
      ppp: ppp.map((v) => round(v)), jeonse, n: reg.n,
      change, nApts: list.length,
      pppNow: reg.pre.pppNow, pppPast: reg.pre.pppPast,
      trades6m: reg.pre.trades6m,
    };
    out[reg.code] = o;
    if (reg.level === 'dong') continue;

    // 지표 (전국·시도·시군구만 — 동은 거래가 적어 점수가 흔들림)
    const vol3 = reg.n.map((_, i) => (i >= 2 ? reg.n[i] + reg.n[i - 1] + reg.n[i - 2] : null));
    const unsoldCode = reg.level === 'sgg' ? reg.parent : reg.code;
    const series = {
      vol: vol3,
      jeonse,
      mortgage: ext(rates.주담대금리),
      base: ext(rates.기준금리),
      unsold: ext(unsold[unsoldCode]),
      mom3: ppp.map((v, i) => (v && ppp[i - 3] ? round((v / ppp[i - 3] - 1) * 100, 2) : null)),
      yoy: ppp.map((v, i) => (v && ppp[i - 12] ? round((v / ppp[i - 12] - 1) * 100, 2) : null)),
      volMom: vol3.map((v, i) => {
        if (v === null || i < 14) return null;
        const prev = vol3.slice(i - 12, i).filter((x) => x !== null);
        const avg = prev.reduce((s, x) => s + x, 0) / prev.length;
        return avg ? round(v / avg, 2) : null;
      }),
    };
    // 금리·미분양은 10년 기록 전체를 비교 기준으로 (실거래 기록보다 길다)
    const longSrc = { mortgage: rates.주담대금리, base: rates.기준금리, unsold: unsold[unsoldCode] };
    const scoreSeries = {};
    const indicators = [];
    for (const def of INDICATORS) {
      const vals = series[def.id];
      const sc = months.map((_, i) => {
        if (i > ref || vals[i] === null) return null;
        const hist = longSrc[def.id] ? longUpTo(longSrc[def.id], months[i]) : vals.slice(0, i + 1);
        if (def.id === 'vol' && reg.n.slice(0, i + 1).reduce((s, x) => s + x, 0) < 60) return null; // 거래가 너무 적은 곳
        return scoreOf(percentile(hist, vals[i]), def.better);
      });
      scoreSeries[def.id] = sc;
      const now = sc[ref], before = sc[ref - 3];
      if (vals[ref] === null || vals[ref] === undefined || now === null) continue;
      indicators.push({
        id: def.id, cat: def.cat, name: def.name, unit: def.unit, desc: def.desc, better: def.better,
        value: vals[ref], score: now, label: labelOf(now),
        trend: before === null || before === undefined ? '유지 중' : now - before >= 2 ? '좋아지는 중' : before - now >= 2 ? '나빠지는 중' : '유지 중',
        spark: vals.slice(0, ref + 1).map((v) => (v === null ? null : round(v, 2))),
      });
    }
    // 카테고리 점수 = 지표 점수 평균, 종합 = 카테고리 평균
    const catAt = (cat, i) => {
      const xs = INDICATORS.filter((d) => d.cat === cat).map((d) => scoreSeries[d.id][i]).filter((v) => v !== null);
      return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
    };
    const cats = {};
    for (const cat of CATS) {
      const v = catAt(cat, ref);
      cats[cat] = { score: round(v, 1), label: labelOf(v) };
    }
    const totalAt = (i) => { const xs = CATS.map((c) => catAt(c, i)).filter((v) => v !== null); return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null; };
    const total = totalAt(ref), totalBefore = totalAt(ref - 1);
    Object.assign(o, {
      cats, indicators,
      total: round(total, 1), totalLabel: labelOf(total),
      totalHistory: months.map((_, i) => (i <= ref ? round(totalAt(i), 1) : null)),
      totalChanged: total !== null && totalBefore !== null && Math.abs(total - totalBefore) >= 0.5,
      good: indicators.filter((x) => x.score >= 7).length, bad: indicators.filter((x) => x.score <= 4).length,
    });
  }

  // 6) 단지 순위 — 시군구는 전부(동 필터용), 전국·시도는 평형대별 상위 30
  const aptsBySgg = {};
  for (const s of aptStats) (aptsBySgg[s.sgg] = aptsBySgg[s.sgg] || []).push(s);
  for (const k of Object.keys(aptsBySgg)) aptsBySgg[k].sort((a, b) => b.change - a.change);
  const topApts = {};
  for (const code of ['00', ...REGIONS.sido.map((s) => s.code)]) {
    const list = (byRegion.get(code) || []).filter((s) => s.nRec >= 3);
    topApts[code] = {};
    for (const band of BANDS) topApts[code][band] = list.filter((s) => s.band === band).sort((a, b) => b.change - a.change).slice(0, 30);
  }

  const model = {
    builtAt: new Date().toISOString(), demo, months, ref, refYm: months[ref],
    bands: BANDS, indicatorsDef: INDICATORS.map(({ id, cat, name, unit, desc, better }) => ({ id, cat, name, unit, desc, better })),
    sources: { rates: Boolean(rates.주담대금리 || rates.기준금리), unsold: Boolean(unsold['00'] || unsold['11']) },
    regions: out, aptsBySgg, topApts,
  };
  log(`[build] 완료: 지역 ${Object.keys(out).length}곳, ${((Date.now() - t0) / 1000).toFixed(1)}초`);
  return model;
}

function buildAndSave(opts) {
  const model = build(opts);
  writeJson(MODEL_FILE, model);
  return model;
}

module.exports = { build, buildAndSave, MODEL_FILE, bandOf, BANDS, labelOf, Hist, ymAdd };
