#!/usr/bin/env node
// 데이터 갱신: 수집 → 집계 → data/model.json
//   node scripts/update.js            키가 있으면 실데이터, 없으면 데모
//   node scripts/update.js --demo     데모 데이터로 강제
//   node scripts/update.js --build    수집 없이 저장된 원본으로 집계만
// 서버가 하루 한 번 자식 프로세스로 실행한다 (서버 메모리와 분리).
const path = require('path');
const fs = require('fs');
process.chdir(path.join(__dirname, '..'));
try { require('fs').readFileSync('.env', 'utf8').split(/\r?\n/).forEach((l) => { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; }); } catch { /* .env 없음 */ }

const { DATA } = require('../lib/util');
const molit = require('../lib/molit');
const { fetchRates, fetchUnsold } = require('../lib/rates');
const { generate, DEMO_ROOT } = require('../lib/demo');
const { buildAndSave } = require('../lib/build');

const args = new Set(process.argv.slice(2));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

(async () => {
  const months = Number(process.env.BACKFILL_MONTHS) || 36;
  const demo = args.has('--demo') || !molit.serviceKey();
  if (demo) {
    log('[update] 인증키(MOLIT_KEY)가 없어 데모 데이터로 만듭니다');
    if (!fs.existsSync(path.join(DEMO_ROOT, 'raw')) || args.has('--demo')) generate({ months, log });
    buildAndSave({ root: DEMO_ROOT, demo: true, log });
    return;
  }
  if (!args.has('--build')) {
    await fetchRates({ log });
    await fetchUnsold({ log });
    try {
      await molit.fetchAll({ months, limit: Number(process.env.MOLIT_DAILY_LIMIT) || 9000, log });
    } catch (e) { log(e.message); } // 한도 초과·키 오류여도 받아 둔 만큼은 집계
  }
  buildAndSave({ root: DATA, demo: false, log });
})().catch((e) => { console.error('[update] 실패:', e.stack || e.message); process.exit(1); });
