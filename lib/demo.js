// 데모 데이터 — 인증키가 없을 때 화면과 계산을 확인하려고 만드는 가짜 실거래 데이터
// 실제 API 와 똑같은 저장 형식(data/demo/raw/...)으로 만들어서 집계 코드는 실데이터와 같은 길을 탄다.
// 단지 이름은 "OO동 데모 1단지"처럼 실제 단지와 헷갈리지 않게 짓는다.
const fs = require('fs');
const path = require('path');
const { DATA, ymAdd, thisYm, writeJson } = require('./util');
const REGIONS = require('./regions.json');
const DONGS = require('./demo-dongs.json');

const DEMO_ROOT = path.join(DATA, 'demo');

// 시드 고정 난수 (매번 같은 데모)
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 1e9) / 1e9; };
}
const hash = (str) => { let h = 2166136261; for (const c of str) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
function poisson(r, lambda) { let L = Math.exp(-lambda), k = 0, p = 1; do { k++; p *= r(); } while (p > L); return k - 1; }

// 지역별 평당가(만원, 전용 3.3㎡ 기준) 대략값
const BASE_SIDO = { 11: 4200, 41: 2300, 28: 1900, 26: 1700, 27: 1500, 29: 1300, 30: 1450, 31: 1400, 36: 1750, 51: 1000, 43: 1000, 44: 1050, 52: 950, 46: 900, 47: 900, 48: 1050, 50: 1500 };
const BASE_SGG = { 11680: 9000, 11650: 8200, 11710: 6800, 11170: 6900, 11200: 5600, 11440: 5200, 11590: 4900, 11740: 4800, 11560: 4600, 11470: 4700, 41135: 5200, 41290: 7000, 41465: 3600, 41450: 3500, 41597: 3100 };

function generate({ months = 36, log = console.log } = {}) {
  const latest = thisYm();
  const yms = []; for (let i = months - 1; i >= 0; i--) yms.push(ymAdd(latest, -i));
  // 전국 공통 경기 흐름: 하락 → 바닥 → 회복
  // 전국 공통 경기 흐름: 1년 반 하락·바닥 → 최근 회복
  const bottom = months * 0.55;
  const cycle = yms.map((_, i) => 1 - 0.06 * Math.sin(Math.PI * Math.min(i / bottom, 1) / 2) + Math.max(0, i - bottom) * 0.0045);
  const volCycle = yms.map((_, i) => 0.55 + 0.9 * (i / months) ** 1.6);
  fs.rmSync(path.join(DEMO_ROOT, 'raw'), { recursive: true, force: true });
  let total = 0;

  for (const s of REGIONS.sgg) {
    const r = rng(hash(s.code));
    const base = (BASE_SGG[s.code] || BASE_SIDO[s.sido] * (0.75 + r() * 0.5));
    const drift = (r() - 0.45) * 0.006 + (s.sido === '11' ? 0.004 : 0); // 지역별 월 추세
    const dongs = DONGS[s.code] && DONGS[s.code].length ? DONGS[s.code] : ['중앙동'];
    const nApt = 8 + Math.floor(r() * 13);
    const apts = Array.from({ length: nApt }, (_, i) => ({
      dong: dongs[i % dongs.length],
      name: `데모 ${i + 1}단지`,
      id: `D${s.code}-${i + 1}`,
      built: 1990 + Math.floor(r() * 35),
      prem: 0.75 + r() * 0.6,
      beta: 0.6 + r() * 0.9,
      areas: [59 + r() * 2, 84 + r() * 1.5, ...(r() > 0.5 ? [114 + r() * 20] : [])],
      jeonse: 0.45 + r() * 0.25,
      liq: 0.8 + r() * 2.5,
    }));
    for (const [i, ym] of yms.entries()) {
      const trade = [], rent = [];
      for (const a of apts) {
        const lvl = base * a.prem * (1 + (cycle[i] - 1) * a.beta) * (1 + drift * i * a.beta) * (1 - Math.max(0, 2026 - a.built - 20) * 0.004);
        const nT = poisson(r, a.liq * volCycle[i]);
        for (let k = 0; k < nT; k++) {
          const area = a.areas[Math.floor(r() * a.areas.length)];
          const ppp = lvl * (0.93 + r() * 0.14);
          const day = 1 + Math.floor(r() * 28);
          // 등기: 계약 1~2달 뒤 (최근 두 달은 아직 안 된 거래가 많음), 직거래 약 8%
          const rg = i < yms.length - 2 || r() < 0.3 ? ymAdd(ym, 1 + Math.floor(r() * 2)) : null;
          const rgst = rg && r() < 0.95 ? `${rg.slice(2, 4)}.${rg.slice(4)}.${String(1 + Math.floor(r() * 28)).padStart(2, '0')}` : '';
          trade.push([day, a.dong, a.name, a.id, Math.round(area * 100) / 100, Math.round(ppp * area / 3.305785), 1 + Math.floor(r() * 25), a.built, '', r() < 0.08 ? '직' : '중', rgst]);
        }
        const nR = poisson(r, a.liq * 1.6);
        for (let k = 0; k < nR; k++) {
          const area = a.areas[Math.floor(r() * a.areas.length)];
          const dep = lvl * a.jeonse * (0.92 + r() * 0.16) * area / 3.305785;
          const monthly = r() < 0.4 ? Math.round(30 + r() * 150) : 0;
          rent.push([1 + Math.floor(r() * 28), a.dong, a.name, a.id, Math.round(area * 100) / 100, Math.round(monthly ? dep * 0.3 : dep), monthly, a.built]);
        }
      }
      total += trade.length;
      writeJson(path.join(DEMO_ROOT, 'raw', 'trade', s.code, `${ym}.json`), { fetchedAt: new Date().toISOString(), demo: true, rows: trade });
      writeJson(path.join(DEMO_ROOT, 'raw', 'rent', s.code, `${ym}.json`), { fetchedAt: new Date().toISOString(), demo: true, rows: rent });
    }
  }

  // 금리·미분양 (10년치 흐름)
  const long = []; for (let i = 119; i >= 0; i--) long.push(ymAdd(latest, -i));
  const rates = { 기준금리: {}, 주담대금리: {} };
  long.forEach((ym, i) => {
    const b = i < 60 ? 1.25 - i * 0.012 : Math.min(3.5, 0.5 + (i - 60) * 0.12) - Math.max(0, i - 100) * 0.06;
    rates.기준금리[ym] = Math.round(Math.max(0.5, b) * 4) / 4;
    rates.주담대금리[ym] = Math.round((rates.기준금리[ym] + 1.4 + Math.sin(i / 7) * 0.15) * 100) / 100;
  });
  writeJson(path.join(DEMO_ROOT, 'rates.json'), rates);
  const unsold = { '00': {} };
  for (const sd of REGIONS.sido) {
    const r = rng(hash(`u${sd.code}`));
    const base = (BASE_SIDO[sd.code] < 1500 ? 4000 : 1500) * (0.5 + r());
    unsold[sd.code] = {};
    long.forEach((ym, i) => {
      const v = Math.round(base * (0.9 + 0.5 * Math.sin(i / 16 + r() * 3) - (i > 95 ? (i - 95) * 0.015 : 0)) * (0.95 + r() * 0.1));
      unsold[sd.code][ym] = Math.max(20, v);
      unsold['00'][ym] = (unsold['00'][ym] || 0) + unsold[sd.code][ym];
    });
  }
  writeJson(path.join(DEMO_ROOT, 'unsold.json'), unsold);
  log(`[demo] 데모 데이터 생성: 시군구 ${REGIONS.sgg.length}곳 × ${months}개월, 매매 ${total}건`);
}

module.exports = { generate, DEMO_ROOT };
