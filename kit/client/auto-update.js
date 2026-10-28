// 앱 자동 새로고침 (브라우저) — kit.js 다음에 로드, server/version.js 와 짝
// 앱이 1분마다, 그리고 다시 화면에 띄울 때마다(앱 전환·화면 켜기·인터넷 재연결) 서버에 새 버전이 있는지 확인한다.
// 새 버전이면 화면을 새로고침한다. → 배포하면 폰에 열어 둔 앱도 알아서 최신이 된다.
// 화면 버전은 index.html 의 <meta name="app-version" content="__APP_VERSION__"> (서버 sendIndex 가 채움) 기준.
// 같은 버전으로 자동 새로고침은 한 번만 한다 (무한 새로고침 방지 — 그 뒤엔 배너).
//
//   KairuKit.autoUpdate();                                   // 기본: 1분마다, 새 버전이면 바로 새로고침
//   KairuKit.autoUpdate({ canReload: () => !inGame });       // 대국·입력 중엔 미뤘다가 안전할 때 새로고침
//
// 옵션
//   interval   확인 주기 (기본 60000 = 1분)
//   url        버전 주소 (기본 '/api/version')
//   canReload  () => boolean. false 면 지금은 새로고침하지 않고 아래 배너를 띄운 뒤,
//              다음 확인 때나 화면에 다시 띄울 때 true 가 되면 그때 새로고침
//   banner     true(기본)면 미뤄질 때 "새 버전이 있어요 · 새로고침" 배너 표시
//   onUpdate   (oldVersion, newVersion) => void — 새로고침 직전에 호출 (저장할 것 저장)
(function () {
  const K = window.KairuKit;
  if (!K) throw new Error('kit.js 를 먼저 불러오세요');

  K.autoUpdate = function ({
    interval = 60 * 1000, url = '/api/version', canReload = () => true, banner = true, onUpdate = () => {},
  } = {}) {
    // 이 화면의 버전: index.html 에 심어 둔 값(<meta name="app-version">)이 우선 — baduk-live 방식.
    // 없으면 처음 물어본 서버 값을 기준으로 삼는다.
    const meta = (document.querySelector('meta[name="app-version"]') || {}).content || '';
    let current = meta && meta !== '__APP_VERSION__' ? meta : null;
    let pending = null;   // 미뤄 둔 새 버전
    let checking = false;
    let lastCheck = 0;
    let bannerEl = null;

    async function fetchVersion() {
      const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}_=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`version ${res.status}`);
      return (await res.json()).version || null;
    }

    function showBanner() {
      if (!banner || bannerEl) return;
      bannerEl = document.createElement('button');
      bannerEl.type = 'button';
      bannerEl.textContent = '새 버전이 있어요 · 눌러서 새로고침';
      bannerEl.style.cssText = 'position:fixed;left:50%;top:calc(10px + env(safe-area-inset-top));transform:translateX(-50%);'
        + 'z-index:99998;padding:8px 14px;border:0;border-radius:999px;background:#2563eb;color:#fff;'
        + 'font:600 13px/1.3 system-ui,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.25);cursor:pointer';
      bannerEl.onclick = () => reload(true);
      document.body.appendChild(bannerEl);
    }

    async function reload(force = false) {
      if (!pending) return;
      let ok = false;
      try { ok = force || canReload(); } catch { ok = false; }
      // 같은 버전으로 자동 새로고침은 한 번만 (새로고침했는데도 옛 화면이면 무한 반복 대신 배너)
      if (!force) {
        try { if (sessionStorage.getItem('kk_reloaded_for') === pending) ok = false; } catch { /* 무시 */ }
      }
      if (!ok) { showBanner(); return; }
      try { sessionStorage.setItem('kk_reloaded_for', pending); } catch { /* 무시 */ }
      try { onUpdate(current, pending); } catch (e) { console.error(e); }
      // 서비스 워커도 새 버전을 받게 한 뒤 새로고침
      try {
        const reg = await navigator.serviceWorker?.getRegistration();
        await Promise.race([reg?.update(), new Promise((r) => setTimeout(r, 1500))]);
      } catch { /* 무시 */ }
      location.reload();
    }

    async function check() {
      if (checking || document.visibilityState === 'hidden' || navigator.onLine === false) return;
      checking = true;
      lastCheck = Date.now();
      try {
        const v = await fetchVersion();
        if (!v) return;
        if (!current) { current = v; return; }
        if (v !== current) { pending = v; await reload(); }
      } catch { /* 서버 재시작 중이거나 오프라인 — 다음에 다시 */ } finally { checking = false; }
    }

    // 다시 화면에 띄울 때: 바로 확인 (너무 잦은 확인은 3초 간격으로 제한)
    const onShow = () => {
      if (document.visibilityState !== 'visible') return;
      if (pending) return reload();
      if (Date.now() - lastCheck > 3000) check();
    };
    document.addEventListener('visibilitychange', onShow);
    window.addEventListener('focus', onShow);
    window.addEventListener('online', onShow);
    window.addEventListener('pageshow', (e) => { if (e.persisted) onShow(); }); // 뒤로가기 캐시에서 복원

    const timer = setInterval(() => (pending ? reload() : check()), interval);
    check();

    return {
      check,
      get version() { return current; },
      get pending() { return pending; },
      stop() { clearInterval(timer); document.removeEventListener('visibilitychange', onShow); window.removeEventListener('focus', onShow); window.removeEventListener('online', onShow); },
    };
  };
})();
