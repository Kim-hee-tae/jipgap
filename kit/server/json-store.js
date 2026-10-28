// JSON 파일 저장소 — DB 없이 data/*.json 하나로 저장
// (따릉이 db.json, 지하철 devices.json, 바둑 state.json 에서 쓰던 방식을 하나로)
//
//   const store = createStore('data/app.json', { users: {} });
//   store.data.users[uid] = {...};
//   store.save();        // 0.5초 모아서 저장 (자주 불러도 괜찮음)
//   store.saveNow();     // 즉시 저장 (종료 직전 등)
//
// - 임시 파일에 쓰고 rename → 저장 중 서버가 죽어도 파일이 깨지지 않음
// - 파일이 깨져 있으면 .broken-<시각> 으로 옮겨 두고 기본값으로 시작
// - 프로세스 종료(SIGTERM/SIGINT, 자동 배포 재시작) 때 밀린 저장을 마저 함
const fs = require('fs');
const path = require('path');

const stores = new Set();

function createStore(file, defaults = {}, { delayMs = 500, pretty = true } = {}) {
  const abs = path.resolve(file);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      const broken = `${abs}.broken-${Date.now()}`;
      try { fs.renameSync(abs, broken); } catch { /* 무시 */ }
      console.error(`[store] ${path.basename(abs)} 읽기 실패 → ${path.basename(broken)} 로 옮기고 새로 시작:`, err.message);
    }
    data = structuredClone(defaults);
  }
  // 새로 추가된 기본 키 채우기 (예전 파일 호환)
  for (const [k, v] of Object.entries(defaults)) if (!(k in data)) data[k] = structuredClone(v);

  let timer = null;
  const store = {
    file: abs,
    get data() { return data; },
    set data(v) { data = v; },
    save() {
      if (timer) return;
      timer = setTimeout(() => { timer = null; store.saveNow(); }, delayMs);
    },
    saveNow() {
      if (timer) { clearTimeout(timer); timer = null; }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const tmp = `${abs}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, pretty ? 1 : 0));
      fs.renameSync(tmp, abs);
    },
    get pending() { return Boolean(timer); },
  };
  stores.add(store);
  return store;
}

function flushAll() {
  for (const s of stores) if (s.pending) { try { s.saveNow(); } catch (e) { console.error('[store] 저장 실패', e.message); } }
}
let hooked = false;
function hookExit() {
  if (hooked) return;
  hooked = true;
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.once(sig, () => { flushAll(); process.exit(0); });
  }
  process.once('beforeExit', flushAll);
}
hookExit();

module.exports = { createStore, flushAll };
