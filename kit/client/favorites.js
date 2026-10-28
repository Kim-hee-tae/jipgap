// 즐겨찾기 (브라우저) — kit.js 다음에 로드
// 두 가지 모드를 같은 사용법으로:
//   local  : 이 브라우저에만 저장 (subway-app 방식, 서버 필요 없음)
//   server : 서버 저장 (ddareungi-alert 방식, server/favorites.js 와 짝) — 기기 바꿔도 설정 코드로 이어 쓰기
//
//   const favs = KairuKit.favorites({ mode: 'server', onChange: render });
//   await favs.load();
//   favs.has(id)  favs.get(id)  favs.list()       // list 는 추가한 순서
//   await favs.toggle(id, { name: '염창역' })      // 있으면 빼고, 없으면 추가 → true/false
//   await favs.put(id, { notify: true })          // 추가 또는 일부 수정
//   await favs.remove(id)
//   await favs.reorder([id3, id1, id2])
//   (server 모드) await favs.issueCode() → '8자리'   await favs.useCode('ABCD2345')
(function () {
  const K = window.KairuKit;
  if (!K) throw new Error('kit.js 를 먼저 불러오세요');

  K.favorites = function ({ mode = 'local', key = 'favorites', base = '/api', max = 30, onChange = () => {} } = {}) {
    let items = new Map(); // id -> { id, order, ...data }
    const emit = () => { try { onChange(list()); } catch (e) { console.error(e); } };
    const list = () => [...items.values()].sort((a, b) => a.order - b.order);
    const nextOrder = () => Math.max(0, ...[...items.values()].map((f) => f.order || 0)) + 1;
    const saveLocal = () => K.store.setJson(key, list());
    const url = (id = '') => `${base}/users/${encodeURIComponent(K.uid())}/favorites${id ? `/${encodeURIComponent(id)}` : ''}`;

    async function load() {
      if (mode === 'local') {
        const arr = K.store.json(key, []);
        items = new Map((Array.isArray(arr) ? arr : []).filter((f) => f && f.id).map((f, i) => [f.id, { order: i + 1, ...f }]));
      } else {
        const data = await K.api(url());
        items = new Map(data.favorites.map((f) => [f.id, f]));
      }
      emit();
      return list();
    }

    async function put(id, data = {}) {
      id = String(id);
      if (!items.has(id) && items.size >= max) throw new Error(`즐겨찾기는 최대 ${max}개까지 가능해요.`);
      if (mode === 'local') {
        const prev = items.get(id);
        items.set(id, { ...(prev || {}), ...data, id, order: prev?.order ?? nextOrder() });
        saveLocal();
      } else {
        const { favorite } = await K.api(url(id), { method: 'PUT', body: data });
        items.set(id, favorite);
      }
      emit();
      return items.get(id);
    }

    async function remove(id) {
      id = String(id);
      if (!items.has(id)) return false;
      const prev = items.get(id);
      items.delete(id); emit(); // 화면 먼저 반영
      try {
        if (mode === 'local') saveLocal();
        else await K.api(url(id), { method: 'DELETE' });
      } catch (e) { items.set(id, prev); emit(); throw e; }
      return true;
    }

    async function toggle(id, data = {}) {
      if (items.has(String(id))) { await remove(id); return false; }
      await put(id, data); return true;
    }

    async function reorder(ids) {
      ids.forEach((id, i) => { const f = items.get(String(id)); if (f) f.order = i + 1; });
      let n = ids.length;
      for (const f of list()) if (!ids.includes(f.id)) f.order = ++n;
      if (mode === 'local') saveLocal();
      else await K.api(`${url()}/order`, { method: 'POST', body: { ids } });
      emit();
    }

    async function issueCode() {
      if (mode !== 'server') throw new Error('server 모드에서만 쓸 수 있어요');
      return (await K.api(`${base}/users/${encodeURIComponent(K.uid())}/code`, { method: 'POST' })).code;
    }
    async function useCode(code) {
      if (mode !== 'server') throw new Error('server 모드에서만 쓸 수 있어요');
      const { uid } = await K.api(`${base}/code/${encodeURIComponent(code)}`, { method: 'POST' });
      K.setUid(uid);
      return load();
    }

    return {
      load, put, remove, toggle, reorder, issueCode, useCode, list,
      has: (id) => items.has(String(id)),
      get: (id) => items.get(String(id)),
      get size() { return items.size; },
    };
  };
})();
