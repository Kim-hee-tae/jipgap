// 앱 버전 알려주기 (서버) — client/auto-update.js 와 짝  (baduk-live 방식 + 1분 확인)
// 브라우저가 1분마다·화면 복귀 때 GET /api/version 을 물어보고, 자기 화면 버전과 다르면 새로고침한다.
//
//   const { mountVersion, sendIndex } = require('./kit/server/version');
//   const version = mountVersion(app);                  // GET /api/version → { version }
//   app.get('/', (req, res) => sendIndex(res, 'public/index.html', version));   // 화면에 버전 심기
//   // index.html <head> 에:  <meta name="app-version" content="__APP_VERSION__">
//
// 버전 값 = 화면 파일(public/ 등) 내용의 해시
//   → 화면이 실제로 바뀐 배포에서만 새로고침된다. README·서버 코드만 바뀐 커밋으로는 새로고침 안 함.
//   APP_VERSION 환경변수가 있으면 그 값을 쓴다.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SKIP = new Set(['node_modules', '.git', 'data']);

// dirs/files 안의 모든 파일 경로+내용으로 sha1 → 12자리
function hashFiles(paths, base = process.cwd()) {
  const h = crypto.createHash('sha1');
  const files = [];
  const walk = (p) => {
    let st;
    try { st = fs.statSync(p); } catch { return; }
    if (st.isDirectory()) {
      for (const f of fs.readdirSync(p)) if (!SKIP.has(f)) walk(path.join(p, f));
    } else files.push(p);
  };
  for (const p of paths) walk(path.resolve(base, p));
  if (!files.length) return null;
  for (const f of files.sort()) { h.update(path.relative(base, f)); h.update(fs.readFileSync(f)); }
  return h.digest('hex').slice(0, 12);
}

// dirs: 화면에 쓰이는 폴더·파일 (브라우저로 가는 lib 파일이 있으면 추가. 예: ['public', 'kit/client', 'lib/go.js'])
function appVersion({ dirs = ['public', 'kit/client'], base = process.cwd() } = {}) {
  return process.env.APP_VERSION || hashFiles(dirs, base) || `t${Date.now().toString(36)}`;
}

function mountVersion(app, { path: route = '/api/version', dirs, base, version } = {}) {
  // version 에 함수를 넘기면 요청마다 호출 (재시작 없이 버전을 바꾸고 싶을 때·테스트용)
  const fixed = typeof version === 'function' ? null : (version || appVersion({ dirs, base }));
  app.get(route, (req, res) => {
    res.set('Cache-Control', 'no-store'); // 브라우저·서비스 워커·프록시가 저장해 두지 않게
    res.json({ version: fixed ?? String(version()) });
  });
  return fixed;
}

// index.html 의 __APP_VERSION__ 을 실제 버전으로 바꿔서 보낸다.
// 화면이 "자기가 몇 버전인지" 알고 있어야, 오프라인 캐시로 옛 화면이 열렸을 때도 정확히 알아챈다.
const htmlCache = new Map();
function sendIndex(res, file, version) {
  const key = `${path.resolve(file)}|${version}`;
  let html = htmlCache.get(key);
  if (!html) {
    html = fs.readFileSync(file, 'utf8').replaceAll('__APP_VERSION__', String(version));
    htmlCache.set(key, html);
  }
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(html);
}

module.exports = { mountVersion, appVersion, hashFiles, sendIndex };
