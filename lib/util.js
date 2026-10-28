// 공통 유틸 — 월(YYYYMM) 계산, 통계, 파일 입출력
const fs = require('fs');
const path = require('path');

const DATA = path.resolve(process.env.DATA_DIR || 'data');
const PYEONG = 3.305785; // 1평 = 3.305785㎡

// ── 월 계산 (YYYYMM 문자열) ──
function ymAdd(ym, n) {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(4, 6)) - 1 + n;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12 + 1;
  return `${yy}${String(mm).padStart(2, '0')}`;
}
function ymRange(from, to) {
  const out = [];
  for (let ym = from; ym <= to; ym = ymAdd(ym, 1)) out.push(ym);
  return out;
}
// 한국 시간 기준 이번 달
function thisYm(d = new Date()) {
  const k = new Date(d.getTime() + 9 * 3600 * 1000);
  return `${k.getUTCFullYear()}${String(k.getUTCMonth() + 1).padStart(2, '0')}`;
}
function kstDate(d = new Date()) {
  const k = new Date(d.getTime() + 9 * 3600 * 1000);
  return k.toISOString().slice(0, 10);
}

// ── 통계 ──
function median(arr) {
  if (!arr || !arr.length) return null;
  const a = Float64Array.from(arr).sort();
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
// 가중 중앙값: pairs = [[값, 가중치], ...]
function weightedMedian(pairs) {
  if (!pairs.length) return null;
  const a = pairs.slice().sort((x, y) => x[0] - y[0]);
  const total = a.reduce((s, p) => s + p[1], 0);
  let acc = 0;
  for (const [v, w] of a) { acc += w; if (acc >= total / 2) return v; }
  return a[a.length - 1][0];
}
// 현재 값이 과거 분포에서 몇 % 위치인지 (0~1)
function percentile(history, value) {
  const xs = history.filter((v) => v !== null && v !== undefined && Number.isFinite(v));
  if (xs.length < 6 || value === null || value === undefined) return null;
  let below = 0, same = 0;
  for (const v of xs) { if (v < value) below++; else if (v === value) same++; }
  return (below + same / 2) / xs.length;
}
const round = (v, d = 0) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

// ── 파일 ──
function readJson(file, def = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { DATA, PYEONG, ymAdd, ymRange, thisYm, kstDate, median, weightedMedian, percentile, round, readJson, writeJson, sleep };
