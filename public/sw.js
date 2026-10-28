// kairu-kit 서비스 워커 — public/sw.js 로 복사해서 위쪽 설정만 바꿔 쓰기
// 따릉이·지하철(푸시용)과 바둑·청룡(오프라인용) 두 종류를 하나로 합침. 필요 없는 기능은 false.
//
//   PUSH    : 푸시 받으면 알림 표시, 알림 누르면 앱 열기(이미 열려 있으면 그 창으로)
//   OFFLINE : 홈 화면 앱 설치 + 오프라인 때 마지막 화면. 항상 네트워크 먼저 → 배포하면 바로 새 버전.
// ─────────────── 설정 ───────────────
const APP_TITLE = '집값 점수판';                 // 알림 제목 기본값
const PUSH = false;
const OFFLINE = true;
const CACHE = 'jipgap-v1';                    // 캐시 구조를 바꿀 때만 숫자 올리기
const SHELL = ['/', '/style.css', '/app.js', '/manifest.json', '/icon.svg'];   // 처음 설치할 때 미리 저장할 파일
const NO_CACHE = ['/api/', '/socket.io', '/ws', '/health'];  // 실시간·API 는 절대 캐시 안 함
const PIN_CACHE = [];                      // 버전 고정 CDN (예: three.js) — 저장본 우선
// ────────────────────────────────────

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    if (OFFLINE) {
      const c = await caches.open(CACHE);
      await c.addAll(SHELL).catch(() => {});
      for (const u of PIN_CACHE) await c.add(new Request(u, { mode: 'no-cors' })).catch(() => {});
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

if (OFFLINE) {
  self.addEventListener('fetch', (e) => {
    const req = e.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    if (PIN_CACHE.includes(req.url)) {
      e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return res;
      })));
      return;
    }
    if (url.origin !== self.location.origin || NO_CACHE.some((p) => url.pathname.startsWith(p))) return;
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req.mode === 'navigate' ? '/' : req, copy)).catch(() => {});
        }
        return res;
      } catch (err) {
        const hit = await caches.match(req.mode === 'navigate' ? '/' : req);
        if (hit) return hit;
        throw err;
      }
    })());
  });
}

if (PUSH) {
  // 서버(server/push.js)에서 보내는 payload: { title, body, tag, url, icon }
  self.addEventListener('push', (event) => {
    let data = {};
    try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data && event.data.text() }; }
    event.waitUntil(self.registration.showNotification(data.title || APP_TITLE, {
      body: data.body || '',
      icon: data.icon || '/icon.svg',
      badge: '/icon.svg',
      tag: data.tag,            // 같은 tag 알림은 하나로 합쳐짐
      renotify: Boolean(data.tag),
      data: { url: data.url || '/' },
    }));
  });

  self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const url = (event.notification.data && event.notification.data.url) || '/';
    event.waitUntil((async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of all) {
        if ('focus' in c) { await c.navigate(url).catch(() => {}); return c.focus(); }
      }
      return self.clients.openWindow(url);
    })());
  });
}
