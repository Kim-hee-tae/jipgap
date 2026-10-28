// 즐겨찾기 (서버 저장) — ddareungi-alert 방식을 범용으로
// 로그인 없이 기기별 uid(브라우저 localStorage 에 저장된 랜덤 ID)로 사람을 구분한다.
// 다른 기기에서 같은 즐겨찾기를 쓰려면 "설정 코드"(8자리)로 uid 를 옮겨 받는다.
//
//   const { createFavorites } = require('./kit/server/favorites');
//   const favs = createFavorites({
//     file: 'data/favorites.json',
//     max: 30,
//     clean: (id, input, prev) => ({ notify: Boolean(input.notify) }),  // 저장할 필드만 골라서 반환, 잘못되면 throw
//   });
//   favs.mount(app);   // Express 라우트 등록
//
// API
//   GET    /api/users/:uid/favorites            → { favorites: [{ id, order, ...data }] }
//   PUT    /api/users/:uid/favorites/:id  body  → 추가/수정 (부분 수정 가능)
//   DELETE /api/users/:uid/favorites/:id        → 삭제
//   POST   /api/users/:uid/favorites/order { ids:[...] } → 순서 변경
//   POST   /api/users/:uid/code                 → 설정 코드 발급 { code }
//   POST   /api/code/:code                      → 코드로 uid 받기 { uid }
const crypto = require('crypto');
const { createStore } = require('./json-store');

const UID_RE = /^[a-zA-Z0-9-]{8,64}$/;
const ID_RE = /^[\w.:|-]{1,80}$/;
const CODE_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function createFavorites({ file = 'data/favorites.json', max = 30, maxUsers = 50000, clean = (id, input) => input || {} } = {}) {
  const store = createStore(file, { users: {}, codes: {} });
  const users = () => store.data.users;

  const validUid = (uid) => typeof uid === 'string' && UID_RE.test(uid);
  const validId = (id) => typeof id === 'string' && ID_RE.test(id);

  function user(uid, create = false) {
    if (!validUid(uid)) return null;
    let u = users()[uid];
    if (!u && create) {
      if (Object.keys(users()).length >= maxUsers) throw new Error('사용자가 너무 많아요');
      u = users()[uid] = { favorites: {}, createdAt: new Date().toISOString() };
    }
    return u || null;
  }

  function list(uid) {
    const u = user(uid);
    if (!u) return [];
    return Object.entries(u.favorites)
      .sort((a, b) => a[1].order - b[1].order)
      .map(([id, f]) => ({ id, ...f }));
  }

  function put(uid, id, input = {}) {
    if (!validId(id)) throw new Error('잘못된 즐겨찾기 ID');
    const u = user(uid, true);
    if (!u) throw new Error('잘못된 사용자 ID');
    const prev = u.favorites[id];
    if (!prev && Object.keys(u.favorites).length >= max) throw new Error(`즐겨찾기는 최대 ${max}개까지 가능해요.`);
    const { order, ...rest } = prev || {};
    const data = clean(id, input, rest);
    let ord = prev?.order;
    if (!Number.isFinite(ord)) ord = Math.max(0, ...Object.values(u.favorites).map((f) => f.order || 0)) + 1;
    u.favorites[id] = { ...rest, ...data, order: ord, updatedAt: new Date().toISOString() };
    store.save();
    return { id, ...u.favorites[id] };
  }

  function remove(uid, id) {
    const u = user(uid);
    if (!u || !u.favorites[id]) return false;
    delete u.favorites[id];
    store.save();
    return true;
  }

  function reorder(uid, ids) {
    const u = user(uid);
    if (!u || !Array.isArray(ids)) return false;
    let n = 0;
    const seen = new Set();
    for (const id of ids) if (u.favorites[id] && !seen.has(id)) { seen.add(id); u.favorites[id].order = ++n; }
    // 목록에 빠진 항목은 기존 순서대로 뒤에 붙인다
    const rest = Object.entries(u.favorites).filter(([id]) => !seen.has(id)).sort((a, b) => a[1].order - b[1].order);
    for (const [, f] of rest) f.order = ++n;
    store.save();
    return true;
  }

  // 설정 코드: 다른 기기에서 같은 즐겨찾기 쓰기
  function issueCode(uid) {
    const u = user(uid, true);
    if (u.code && store.data.codes[u.code] === uid) return u.code;
    let code;
    do { code = Array.from(crypto.randomBytes(8), (b) => CODE_ALPHA[b % CODE_ALPHA.length]).join(''); } while (store.data.codes[code]);
    u.code = code;
    store.data.codes[code] = uid;
    store.save();
    return code;
  }
  const uidFromCode = (code) => store.data.codes[String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '')] || null;

  function mount(app, base = '/api') {
    const fail = (res, e, status = 400) => res.status(status).json({ error: e.message || String(e) });
    app.get(`${base}/users/:uid/favorites`, (req, res) => {
      if (!validUid(req.params.uid)) return fail(res, new Error('잘못된 사용자 ID'));
      res.json({ favorites: list(req.params.uid), hasCode: Boolean(user(req.params.uid)?.code) });
    });
    app.put(`${base}/users/:uid/favorites/:id`, (req, res) => {
      try { res.json({ ok: true, favorite: put(req.params.uid, req.params.id, req.body || {}) }); } catch (e) { fail(res, e); }
    });
    app.delete(`${base}/users/:uid/favorites/:id`, (req, res) => res.json({ ok: remove(req.params.uid, req.params.id) }));
    app.post(`${base}/users/:uid/favorites/order`, (req, res) => res.json({ ok: reorder(req.params.uid, req.body?.ids) }));
    app.post(`${base}/users/:uid/code`, (req, res) => {
      if (!validUid(req.params.uid)) return fail(res, new Error('잘못된 사용자 ID'));
      try { res.json({ code: issueCode(req.params.uid) }); } catch (e) { fail(res, e); }
    });
    app.post(`${base}/code/:code`, (req, res) => {
      const uid = uidFromCode(req.params.code);
      uid ? res.json({ uid }) : fail(res, new Error('코드를 찾을 수 없어요'), 404);
    });
    return app;
  }

  return { list, put, remove, reorder, issueCode, uidFromCode, validUid, mount, store };
}

module.exports = { createFavorites };
