// 단지 위치 찾기 — 티맵(SK open API) 주소·장소 검색 → 위도/경도
//   1) 지번이 있으면 Full Text Geocoding (서울특별시 양천구 목동 911)
//   2) 없거나 실패하면 장소(POI) 검색 (양천구 목동 건영)
// 결과는 data/geo.json 에 저장해 두고 다시 묻지 않는다 (못 찾은 단지는 7일 뒤 다시 시도).
// 키: .env 의 TMAP_APP_KEY
const path = require('path');
const { createStore } = require('../kit/server/json-store');
const { DATA } = require('./util');
const REGIONS = require('./regions.json');

const API = 'https://apis.openapi.sk.com/tmap';
const RETRY_MS = 24 * 3600 * 1000; // 못 찾은 단지는 하루 뒤 다시 시도
let lastError = null;              // 마지막 티맵 오류 (화면·상태 확인용)

let store = null;
function db() {
  if (store) return store;
  store = createStore(path.join(DATA, 'geo.json'), { items: {} });
  // 서버가 다시 켜지면 '못 찾음' 기록은 지우고 다시 찾는다 (키·설정을 고친 뒤 바로 반영되게)
  for (const [k, v] of Object.entries(store.data.items)) if (!v.lat) delete store.data.items[k];
  return store;
}
const appKey = () => (process.env.TMAP_APP_KEY || '').trim();
const sidoOf = (sgg) => REGIONS.sido.find((s) => s.code === sgg.slice(0, 2));
const sggOf = (sgg) => REGIONS.sgg.find((s) => s.code === sgg);
const num = (v) => { const n = Number(v); return Number.isFinite(n) && n !== 0 ? n : null; };

async function tmap(pathname, params) {
  const url = new URL(API + pathname);
  for (const [k, v] of Object.entries({ version: 1, format: 'json', ...params })) url.searchParams.set(k, String(v));
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { headers: { appKey: appKey(), Accept: 'application/json' }, signal: ctrl.signal });
    if (res.status === 204) return null; // 검색 결과 없음
    const text = await res.text();
    if (!res.ok) { const e = new Error(`티맵 ${res.status}: ${text.slice(0, 150)}`); e.status = res.status; throw e; }
    return text ? JSON.parse(text) : null;
  } finally { clearTimeout(t); }
}

// Full Text Geocoding 응답 → { lat, lon }
function parseAddrGeo(data) {
  const c = data?.coordinateInfo?.coordinate;
  const x = Array.isArray(c) ? c[0] : c;
  if (!x) return null;
  const lat = num(x.lat) ?? num(x.newLat), lon = num(x.lon) ?? num(x.newLon);
  return lat && lon ? { lat, lon } : null;
}

// POI 검색 응답 → 같은 동네 결과 우선
function parsePoi(data, umd) {
  let pois = data?.searchPoiInfo?.pois?.poi;
  if (!pois) return null;
  if (!Array.isArray(pois)) pois = [pois];
  const ok = pois.filter((p) => (num(p.noorLat) && num(p.noorLon)) || (num(p.frontLat) && num(p.frontLon)));
  if (!ok.length) return null;
  const best = ok.find((p) => umd && `${p.lowerAddrName || ''} ${p.name || ''}`.includes(umd)) || ok[0];
  return { lat: num(best.noorLat) ?? num(best.frontLat), lon: num(best.noorLon) ?? num(best.frontLon), poiName: best.name };
}

function regionName(sgg) {
  const sd = sidoOf(sgg), sg = sggOf(sgg);
  return sd && sg ? `${sd.full} ${sg.name}` : '';
}

// apt = { sgg, id, umd, name, jibun }
async function geocode(apt) {
  const key = `${apt.sgg}|${apt.id}`;
  const st = db();
  const hit = st.data.items[key];
  if (hit && hit.lat && !(hit.source === 'poi' && apt.jibun && !hit.triedJibun)) return hit;
  if (hit && !hit.lat && Date.now() - hit.at < RETRY_MS && !(apt.jibun && !hit.triedJibun)) return null;
  if (!appKey()) return null;

  let out = null;
  try {
    if (apt.jibun) {
      const g = parseAddrGeo(await tmap('/geo/fullAddrGeo', { coordType: 'WGS84GEO', fullAddr: `${regionName(apt.sgg)} ${apt.umd} ${apt.jibun}` }));
      if (g) out = { ...g, source: 'addr' };
    }
    if (!out) {
      const sggShort = (sggOf(apt.sgg)?.name || '').split(' ').pop();
      const g = parsePoi(await tmap('/pois', {
        searchKeyword: `${sggShort} ${apt.umd} ${apt.name}`.trim(), searchType: 'all', count: 5,
        reqCoordType: 'WGS84GEO', resCoordType: 'WGS84GEO',
      }), apt.umd);
      if (g) out = { ...g, source: 'poi' };
    }
  } catch (e) {
    console.error('[geo]', e.message);
    lastError = { at: new Date().toISOString(), status: e.status || null, message: e.message };
    if (hit && hit.lat) return hit;
    const err = new Error(explain(e)); err.geoError = true; throw err; // 키 오류·네트워크 오류는 저장하지 않음 (다음에 다시)
  }
  lastError = null;
  st.data.items[key] = out ? { ...out, at: Date.now(), triedJibun: Boolean(apt.jibun) } : { at: Date.now(), triedJibun: Boolean(apt.jibun) };
  st.save();
  return out ? st.data.items[key] : null;
}

// 티맵 오류를 사람이 알아볼 말로
function explain(e) {
  if (e.status === 401 || e.status === 403) return `티맵 키가 거절됐어요 (${e.status}). SK open API 내 앱에 TMAP 상품이 사용 신청돼 있는지 확인해 주세요.`;
  if (e.status === 429) return '티맵 하루 호출 한도를 넘었어요. 내일 다시 찾아요.';
  if (e.status) return `티맵 오류 (${e.status})`;
  return `티맵에 연결하지 못했어요 (${e.message})`;
}

// 데모 데이터용 가짜 위치 (시도 중심 근처) — 실제 위치 아님
const SIDO_CENTER = {
  11: [37.5665, 126.978], 26: [35.1796, 129.0756], 27: [35.8714, 128.6014], 28: [37.4563, 126.7052], 29: [35.1595, 126.8526],
  30: [36.3504, 127.3845], 31: [35.5384, 129.3114], 36: [36.48, 127.289], 41: [37.2752, 127.0095], 51: [37.8813, 127.7298],
  43: [36.6424, 127.489], 44: [36.6588, 126.6728], 52: [35.8242, 127.148], 46: [34.8161, 126.4629], 47: [36.576, 128.5056],
  48: [35.2383, 128.6925], 50: [33.4996, 126.5312],
};
function demoGeo(sgg, id) {
  let h = 2166136261;
  for (const c of `${sgg}${id}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  const c = SIDO_CENTER[sgg.slice(0, 2)] || SIDO_CENTER[11];
  const dx = (((h >>> 0) % 1000) / 1000 - 0.5) * 0.12, dy = ((((h >>> 10) >>> 0) % 1000) / 1000 - 0.5) * 0.12;
  return { lat: c[0] + dy, lon: c[1] + dx, source: 'demo' };
}

module.exports = { lastError: () => lastError, explain, geocode, demoGeo, parseAddrGeo, parsePoi, regionName, enabled: () => Boolean(appKey()), appKey };
