// kairu-kit 브라우저 공통 유틸 — <script src="/kit/kit.js"></script>
// 모든 앱에서 쓰던 localStorage try/catch, 기기 ID, fetch 래퍼, 토스트를 한 곳에.
//
//   KairuKit.store.get('key', 기본값) / set(key, v) / json(key, 기본값) / setJson(key, obj) / del(key)
//   KairuKit.uid()                       기기별 랜덤 ID (로그인 없이 사용자 구분)
//   await KairuKit.api('/api/x', { method:'POST', body:{...} })   실패 시 서버의 error 메시지로 throw
//   KairuKit.toast('저장했어요')
//   KairuKit.esc(text)                   HTML 이스케이프
(function () {
  const PREFIX = (document.currentScript && document.currentScript.dataset.prefix) || '';
  const k = (key) => PREFIX + key;

  // 시크릿 모드·저장공간 차단 등에서 localStorage 가 throw 해도 앱이 죽지 않게
  const store = {
    get(key, def = null) { try { const v = localStorage.getItem(k(key)); return v === null ? def : v; } catch { return def; } },
    set(key, v) { try { localStorage.setItem(k(key), String(v)); return true; } catch { return false; } },
    json(key, def = null) { try { const v = localStorage.getItem(k(key)); return v === null ? def : JSON.parse(v); } catch { return def; } },
    setJson(key, v) { try { localStorage.setItem(k(key), JSON.stringify(v)); return true; } catch { return false; } },
    del(key) { try { localStorage.removeItem(k(key)); } catch { /* 무시 */ } },
  };

  function randomId() {
    return (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/[^a-zA-Z0-9-]/g, '');
  }
  let cachedUid = null;
  function uid() {
    if (cachedUid) return cachedUid;
    cachedUid = store.get('uid');
    if (!cachedUid) { cachedUid = randomId(); store.set('uid', cachedUid); }
    return cachedUid;
  }
  function setUid(v) { cachedUid = v; store.set('uid', v); } // 설정 코드로 다른 기기 ID 를 받아올 때

  async function api(path, { method = 'GET', body, headers = {}, timeout = 15000 } = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(path, {
        method, signal: ctrl.signal,
        headers: body !== undefined ? { 'Content-Type': 'application/json', ...headers } : headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `요청 실패 (${res.status})`);
      return data;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('서버 응답이 늦어요. 잠시 후 다시 시도해 주세요.');
      if (e instanceof TypeError) throw new Error('인터넷 연결을 확인해 주세요.');
      throw e;
    } finally { clearTimeout(t); }
  }

  let toastEl = null, toastTimer = null;
  function toast(msg, ms = 2500) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.setAttribute('role', 'status');
      toastEl.style.cssText = 'position:fixed;left:50%;bottom:calc(24px + env(safe-area-inset-bottom));transform:translateX(-50%);'
        + 'max-width:min(92vw,420px);padding:10px 16px;border-radius:12px;background:rgba(20,20,24,.92);color:#fff;'
        + 'font:14px/1.4 system-ui,sans-serif;z-index:99999;opacity:0;transition:opacity .2s;pointer-events:none;text-align:center';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.style.opacity = '0'; }, ms);
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  window.KairuKit = Object.assign(window.KairuKit || {}, { store, uid, setUid, randomId, api, toast, esc });
})();
