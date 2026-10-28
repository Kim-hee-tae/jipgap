// 웹 푸시 (브라우저) — kit.js 다음에 로드, server/push.js 의 mount() 와 짝
//
//   const push = KairuKit.push({ meta: () => ({ uid: KairuKit.uid() }) });
//   const st = await push.status();   // { state, text } — 배너 문구에 그대로 쓰면 됨
//      state: 'unsupported' | 'ios-install' | 'server-off' | 'denied' | 'off' | 'on'
//   await push.enable()    // 권한 요청 → 구독 → 서버 등록 (이미 켜져 있으면 서버 정보만 갱신)
//   await push.disable()   // 이 기기만 끔
//   await push.test()      // 테스트 알림
//   await push.endpoint()  // 이 기기 구독 주소 (없으면 null)
//
// 주의: 서비스 워커(sw/sw-push.js 또는 sw-all.js)가 /sw.js 로 등록돼 있어야 한다. register() 를 먼저 부르거나
//       KairuKit.registerSW('/sw.js') 를 쓰면 된다.
(function () {
  const K = window.KairuKit;
  if (!K) throw new Error('kit.js 를 먼저 불러오세요');

  const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;

  function urlB64ToUint8Array(b64) {
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }

  K.registerSW = function (path = '/sw.js') {
    if ('serviceWorker' in navigator) return navigator.serviceWorker.register(path).catch((e) => { console.warn('SW 등록 실패', e); });
    return Promise.resolve(null);
  };

  K.push = function ({ base = '/api/push', meta = () => ({}) } = {}) {
    let keyInfo = null;
    const getKey = async () => (keyInfo ||= await K.api(`${base}/key`));

    async function reg() {
      // ready 가 영원히 안 끝나는 경우(SW 미등록) 대비 3초 제한
      return Promise.race([navigator.serviceWorker.ready, new Promise((_, rej) => setTimeout(() => rej(new Error('서비스 워커가 등록되지 않았어요')), 3000))]);
    }
    async function current() {
      if (!supported()) return null;
      try { return await (await reg()).pushManager.getSubscription(); } catch { return null; }
    }

    async function status() {
      if (!supported()) {
        if (isIOS() && !standalone()) return { state: 'ios-install', text: 'iPhone은 공유 → "홈 화면에 추가" 후 앱으로 열어야 알림을 받을 수 있어요.' };
        return { state: 'unsupported', text: '이 브라우저는 알림을 지원하지 않아요. 크롬에서 열어 주세요.' };
      }
      let info;
      try { info = await getKey(); } catch { info = { enabled: false }; }
      if (!info.enabled) return { state: 'server-off', text: '서버에 알림 설정이 아직 안 돼 있어요.' };
      if (Notification.permission === 'denied') return { state: 'denied', text: '🔕 알림이 차단돼 있어요. 주소창 왼쪽 아이콘 → 권한 → 알림 허용 후 다시 켜 주세요.' };
      const sub = await current();
      if (sub && Notification.permission === 'granted') return { state: 'on', text: '🔔 알림이 켜져 있어요.' };
      return { state: 'off', text: '🔕 알림이 꺼져 있어요.' };
    }

    async function enable() {
      if (!supported()) throw new Error((await status()).text);
      const info = await getKey();
      if (!info.enabled) throw new Error('서버 알림 설정이 아직 안 됐어요');
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') throw new Error('알림 권한이 꺼져 있어요. 브라우저 설정에서 이 사이트의 알림을 허용해 주세요.');
      const r = await reg();
      let sub = await r.pushManager.getSubscription();
      if (!sub) sub = await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(info.publicKey) });
      await K.api(`${base}/subscribe`, { method: 'POST', body: { subscription: sub.toJSON(), meta: meta() } });
      return sub.endpoint;
    }

    async function disable() {
      const sub = await current();
      if (!sub) return false;
      const ep = sub.endpoint;
      await sub.unsubscribe().catch(() => {});
      await K.api(`${base}/unsubscribe`, { method: 'POST', body: { endpoint: ep } }).catch(() => {});
      return true;
    }

    async function test() {
      const sub = await current();
      if (!sub) throw new Error('먼저 알림을 켜 주세요');
      return K.api(`${base}/test`, { method: 'POST', body: { endpoint: sub.endpoint } });
    }

    return { status, enable, disable, test, endpoint: async () => (await current())?.endpoint || null, supported };
  };
})();
