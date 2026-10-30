// 간단 점검: 데모 데이터로 집계 → 서버 API 확인
//   npm test
const assert = require('assert');
const path = require('path');
process.chdir(path.join(__dirname, '..'));
process.env.DATA_DIR = path.join('data', 'test');
const { generate, DEMO_ROOT } = require('../lib/demo');
const { buildAndSave } = require('../lib/build');
const { compact } = require('../lib/molit');

(async () => {
  // API 응답 변환
  assert.deepStrictEqual(compact('trade', { dealDay: '3', umdNm: ' 대치동', aptNm: '테스트', aptSeq: '1', excluUseAr: '84.97', dealAmount: '250,000', floor: '7', buildYear: '2015' }), [3, '대치동', '테스트', '1', 84.97, 250000, 7, 2015, '']);
  assert.strictEqual(compact('trade', { dealAmount: '1,000', excluUseAr: '59', cdealType: 'O' }), null, '해제 거래는 빠져야 함');
  assert.strictEqual(compact('rent', { deposit: '50,000', monthlyRent: '0', excluUseAr: '84' })[6], 0);

  // 티맵 응답 해석
  const geo = require('../lib/geo');
  assert.deepStrictEqual(geo.parseAddrGeo({ coordinateInfo: { coordinate: [{ lat: '37.5284', lon: '126.8751' }] } }), { lat: 37.5284, lon: 126.8751 });
  assert.deepStrictEqual(geo.parseAddrGeo({ coordinateInfo: { coordinate: [{ lat: '', lon: '', newLat: '37.5', newLon: '126.8' }] } }), { lat: 37.5, lon: 126.8 });
  const poi = geo.parsePoi({ searchPoiInfo: { pois: { poi: [
    { name: '건영아파트', lowerAddrName: '신정동', noorLat: '37.51', noorLon: '126.85' },
    { name: '목동건영아파트', lowerAddrName: '목동', noorLat: '37.53', noorLon: '126.87' },
  ] } } }, '목동');
  assert.strictEqual(poi.lat, 37.53, '같은 동네 결과 우선');
  assert.strictEqual(geo.parsePoi(null, '목동'), null);
  assert.strictEqual(geo.regionName('11470'), '서울특별시 양천구');

  generate({ months: 30, log: () => {} });
  const m = buildAndSave({ root: DEMO_ROOT, demo: true, log: () => {} });
  for (const code of ['00', '11', '11680']) {
    const r = m.regions[code];
    assert(r && r.pppNow > 0, `${code} 평당가`);
    assert(r.change !== null, `${code} 상승률`);
    assert(r.total >= 1 && r.total <= 10, `${code} 점수 ${r.total}`);
    assert(r.indicators.length >= 5, `${code} 지표 수`);
  }
  assert(m.topApts['11']['30평대'].length > 0, '서울 30평대 순위');

  process.env.PORT = '3098';
  const { server } = require('../server');
  await new Promise((r) => setTimeout(r, 300));
  const get = async (p) => { const res = await fetch(`http://127.0.0.1:3098${p}`); return { status: res.status, body: await res.json() }; };
  assert.strictEqual((await get('/api/status')).status, 200);
  const r = await get('/api/region/11?band=20평대');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.band, '20평대');
  assert(r.body.children.length > 10, '서울 시군구 목록');
  assert.strictEqual((await get('/api/region/없는곳')).status, 404);
  // 단지 상세: 순위의 첫 단지로
  const a0 = r.body.apts[0] || (await get('/api/region/11470?band=30평대')).body.apts[0];
  const id = a0.key.split('|').slice(1, -1).join('|');
  const d = await get(`/api/apt?sgg=${a0.sgg}&id=${encodeURIComponent(id)}`);
  assert.strictEqual(d.status, 200);
  assert(d.body.trades.length > 0 && d.body.geo && d.body.geo.lat, '단지 거래·위치');
  assert(d.body.trades.every((t, i, arr) => i === 0 || arr[i - 1].ym >= t.ym), '최신순');
  assert.strictEqual((await get('/api/apt?sgg=11470&id=없는단지')).status, 404);
  assert.strictEqual((await get('/api/apt?sgg=abc&id=x')).status, 400);
  const loader = await fetch('http://127.0.0.1:3098/tmap-loader.js').then((x) => x.text());
  assert(loader.includes('TMAP_OFF'), '키 없으면 티맵 끔');
  console.log('✅ 모든 점검 통과');
  server.close();
  require('fs').rmSync(path.join('data', 'test'), { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
