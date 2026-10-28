// 웹 푸시 알림 (서버) — subway-app/push.js 기준, 앱 로직과 분리한 범용 버전
//
//   const { createPush } = require('./kit/server/push');
//   const push = createPush({ file: 'data/push.json' });
//   push.subscribe(subscription, { uid: 'abc' })   // 기기 등록 (meta 는 자유)
//   push.unsubscribe(endpoint)
//   await push.send(endpoint, { title, body, tag, url })
//   await push.sendWhere((dev) => dev.meta.uid === 'abc', payload)
//
// - VAPID 키는 .env 의 VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT
//   (deploy/deploy.sh 가 없을 때만 자동 생성 — 한번 정해지면 절대 바꾸지 말 것: 바꾸면 기존 구독이 모두 끊김)
// - web-push 미설치 또는 키 없음 → enabled=false, 나머지 앱은 정상 동작
// - 앱을 지웠거나 권한을 끈 기기(404/410)는 자동으로 목록에서 삭제
const { createStore } = require('./json-store');

let webpush = null;
try { webpush = require('web-push'); } catch { /* npm install 전이면 알림만 꺼짐 */ }

function cleanSubscription(s) {
  const ep = s && s.endpoint;
  if (typeof ep !== 'string' || !/^https:\/\//.test(ep) || ep.length > 1000) return null;
  const keys = s.keys || {};
  if (typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') return null;
  if (keys.p256dh.length > 200 || keys.auth.length > 100) return null;
  return { endpoint: ep, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

function createPush({
  file = 'data/push.json',
  publicKey = process.env.VAPID_PUBLIC_KEY,
  privateKey = process.env.VAPID_PRIVATE_KEY,
  subject = process.env.VAPID_SUBJECT || 'https://localhost',
  maxDevices = 5000,
  lib = webpush,          // 테스트할 때 가짜 web-push 를 넣을 수 있음
} = {}) {
  const enabled = Boolean(lib && publicKey && privateKey);
  if (enabled) lib.setVapidDetails(subject, publicKey, privateKey);
  const store = createStore(file, { devices: {} });
  const devices = () => store.data.devices;

  function subscribe(subscription, meta = {}) {
    const sub = cleanSubscription(subscription);
    if (!sub) throw new Error('알림 구독 정보가 올바르지 않아요');
    const prev = devices()[sub.endpoint];
    if (!prev && Object.keys(devices()).length >= maxDevices) throw new Error('등록된 기기가 너무 많아요');
    devices()[sub.endpoint] = {
      subscription: sub,
      meta: { ...(prev?.meta || {}), ...meta },
      createdAt: prev?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    store.save();
    return sub.endpoint;
  }

  function unsubscribe(endpoint) {
    if (!devices()[endpoint]) return false;
    delete devices()[endpoint];
    store.save();
    return true;
  }

  async function send(endpoint, payload, { ttl = 600, urgency = 'high' } = {}) {
    const dev = devices()[endpoint];
    if (!enabled || !dev) return false;
    try {
      await lib.sendNotification(dev.subscription, JSON.stringify(payload), { TTL: ttl, urgency });
      dev.lastSentAt = new Date().toISOString();
      store.save();
      return true;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) { // 앱 삭제·권한 해제된 기기
        delete devices()[endpoint];
        store.save();
      } else {
        console.error('[push] 발송 실패:', err.statusCode || '', err.body || err.message);
      }
      return false;
    }
  }

  async function sendWhere(filter, payload, opts) {
    const targets = Object.entries(devices()).filter(([, d]) => filter(d)).map(([ep]) => ep);
    const results = await Promise.all(targets.map((ep) => send(ep, payload, opts)));
    return results.filter(Boolean).length;
  }

  const find = (filter) => Object.values(devices()).filter(filter);

  // Express 에 기본 API 붙이기 (원하면 직접 라우트를 만들어도 됨)
  //   GET  {base}/key          → { enabled, publicKey }
  //   POST {base}/subscribe    { subscription, meta? }
  //   POST {base}/unsubscribe  { endpoint }
  //   POST {base}/test         { endpoint }
  function mount(app, base = '/api/push', { metaFrom } = {}) {
    app.get(`${base}/key`, (req, res) => res.json({ enabled, publicKey: enabled ? publicKey : null }));
    app.post(`${base}/subscribe`, (req, res) => {
      try {
        const meta = metaFrom ? metaFrom(req) : (req.body?.meta && typeof req.body.meta === 'object' ? req.body.meta : {});
        res.json({ ok: true, endpoint: subscribe(req.body?.subscription, meta) });
      } catch (e) { res.status(400).json({ error: e.message }); }
    });
    app.post(`${base}/unsubscribe`, (req, res) => res.json({ ok: unsubscribe(String(req.body?.endpoint || '')) }));
    app.post(`${base}/test`, async (req, res) => {
      const ep = String(req.body?.endpoint || '');
      if (!devices()[ep]) return res.status(400).json({ error: '먼저 알림을 켜 주세요' });
      const ok = await send(ep, { title: '🔔 테스트 알림', body: '알림이 잘 도착했어요.', url: '/' });
      ok ? res.json({ ok }) : res.status(500).json({ error: '발송에 실패했어요' });
    });
    return app;
  }

  if (!enabled) console.log('[push] 꺼짐: VAPID 키가 없거나 web-push 미설치 (deploy.sh 가 자동 설정)');
  return { enabled, publicKey: enabled ? publicKey : null, subscribe, unsubscribe, send, sendWhere, find, mount, count: () => Object.keys(devices()).length, store };
}

module.exports = { createPush, cleanSubscription };
