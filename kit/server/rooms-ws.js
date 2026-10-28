// 실시간 방(Room) — ws(순수 WebSocket) 버전 (cheongryong-arena 방식을 범용으로)
// 초당 수십 번 위치·입력을 주고받는 액션 게임용. 메시지가 가볍고 지연이 적다.
// 턴제·채팅 위주라면 rooms-socketio.js 가 더 편하다 (재연결·ack 가 내장).
//
//   const { createWsRooms } = require('./kit/server/rooms-ws');
//   const net = createWsRooms(server, { path: '/ws', maxPlayers: 8 });
//   net.on('move', (p, m) => { p.x = m.x; net.cast(p.room, { t: 'move', id: p.id, x: m.x }, p); });
//
// 메시지 형식: JSON { t: '종류', ...내용 }
// 기본 제공 (클라이언트 → 서버)
//   { t:'hello', clientId, name }        → { t:'welcome', you, room|null }   ← 재접속하면 원래 방 복귀
//   { t:'list' }                         → { t:'rooms', list }
//   { t:'create', title, priv, ...opts } → { t:'joined', you, room }
//   { t:'join', code }                   → { t:'joined', you, room } | { t:'err', msg }
//   { t:'leave' }                        → { t:'left' }
//   { t:'ping', c }                      → { t:'pong', c }   (지연 측정용)
// 서버 → 클라이언트 공통: { t:'lobby', room }, { t:'err', msg }
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const CODE_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function createWsRooms(server, {
  path = '/ws',
  maxPayload = 8 * 1024,
  maxRooms = 200,
  maxPlayers = 8,
  graceMs = 30 * 1000,           // 끊긴 뒤 이 시간 안에 다시 붙으면 방 그대로 복귀
  heartbeatMs = 15 * 1000,       // 죽은 연결(폰 앱 종료 등) 감지 주기
  initState = () => ({}),
  lobbyView = (room) => ({}),    // 로비 화면에 보낼 게임별 정보
  onJoin = () => {},             // (room, p)
  onLeave = () => {},            // (room, p)
  cleanName = (s) => String(s || '').replace(/[<>&"'`]/g, '').trim().slice(0, 10) || '무명',
} = {}) {
  // noServer + 직접 upgrade 라우팅: { server, path } 로 붙이면 ws 가 다른 경로(socket.io 등)의
  // WebSocket 연결을 400 으로 끊어 버려서, 한 서버에 socket.io 와 같이 쓸 수 없다.
  const wss = new WebSocketServer({ noServer: true, maxPayload });
  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try { pathname = new URL(req.url, 'http://x').pathname; } catch { /* 무시 */ }
    if (pathname !== path) return; // 다른 경로는 건드리지 않음 (socket.io 가 처리)
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  const players = new Map(); // clientId -> p { id, name, ws, room, offAt }
  const rooms = new Map();   // code -> { code, title, priv, host, players:Map, state }
  const handlers = new Map();

  const send = (p, m) => { if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(m)); };
  const cast = (room, m, except) => {
    const s = JSON.stringify(m);
    for (const p of room.players.values()) if (p !== except && p.ws && p.ws.readyState === 1) p.ws.send(s);
  };

  const view = (room) => ({
    code: room.code, title: room.title, priv: room.priv, host: room.host, max: maxPlayers,
    players: [...room.players.values()].map((p) => ({ id: p.id, name: p.name, online: Boolean(p.ws) })),
    ...lobbyView(room),
  });
  const pushLobby = (room) => { cast(room, { t: 'lobby', room: view(room) }); listChanged(); };

  let listTimer = null;
  const roomList = () => [...rooms.values()].filter((r) => !r.priv).map((r) => ({
    code: r.code, title: r.title, players: r.players.size, max: maxPlayers, ...lobbyView(r),
  }));
  function listChanged() {
    if (listTimer) return;
    listTimer = setTimeout(() => {
      listTimer = null;
      const msg = { t: 'rooms', list: roomList() };
      for (const p of players.values()) if (!p.room) send(p, msg);
    }, 200);
  }

  function newCode() {
    let c;
    do { c = Array.from(crypto.randomBytes(4), (b) => CODE_ALPHA[b % CODE_ALPHA.length]).join(''); } while (rooms.has(c));
    return c;
  }

  function joinRoom(p, room) {
    if (room.players.size >= maxPlayers && !room.players.has(p.id)) return send(p, { t: 'err', msg: '방이 꽉 찼어요.' });
    if (p.room && p.room !== room) leaveRoom(p);
    p.room = room;
    room.players.set(p.id, p);
    send(p, { t: 'joined', you: p.id, room: view(room) });
    onJoin(room, p);
    pushLobby(room);
  }

  function leaveRoom(p) {
    const room = p.room;
    if (!room) return;
    room.players.delete(p.id);
    p.room = null;
    send(p, { t: 'left' });
    cast(room, { t: 'left', id: p.id, name: p.name });
    onLeave(room, p);
    if (!room.players.size) { rooms.delete(room.code); listChanged(); return; }
    if (room.host === p.id) room.host = room.players.keys().next().value;
    pushLobby(room);
  }

  const builtin = {
    hello(p, m) {
      p.name = cleanName(m.name);
      send(p, { t: 'welcome', you: p.id, room: p.room ? view(p.room) : null });
      if (p.room) { cast(p.room, { t: 'back', id: p.id, name: p.name }, p); pushLobby(p.room); } else send(p, { t: 'rooms', list: roomList() });
    },
    name(p, m) { p.name = cleanName(m.name); if (p.room) pushLobby(p.room); },
    list(p) { send(p, { t: 'rooms', list: roomList() }); },
    create(p, m) {
      if (rooms.size >= maxRooms) return send(p, { t: 'err', msg: '방이 너무 많아요. 잠시 후 다시 시도하세요.' });
      const room = {
        code: newCode(), title: String(m.title || '').trim().slice(0, 20) || `${p.name}의 방`,
        priv: Boolean(m.priv), host: p.id, players: new Map(), createdAt: Date.now(),
      };
      room.state = initState(room, m) || {};
      rooms.set(room.code, room);
      joinRoom(p, room);
    },
    join(p, m) {
      const room = rooms.get(String(m.code || '').toUpperCase().trim());
      if (!room) return send(p, { t: 'err', msg: '없는 방 코드예요.' });
      joinRoom(p, room);
    },
    leave(p) { leaveRoom(p); },
    ping(p, m) { send(p, { t: 'pong', c: m.c }); },
  };

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    let p = null;
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (!m || typeof m.t !== 'string') return;
      if (!p) {
        if (m.t !== 'hello') return;
        const id = typeof m.clientId === 'string' && /^[\w-]{8,64}$/.test(m.clientId) ? m.clientId : crypto.randomUUID();
        p = players.get(id);
        if (p && p.ws && p.ws !== ws) { try { p.ws.close(4000, 'replaced'); } catch { /* 무시 */ } }
        if (!p) { p = { id, name: '', ws: null, room: null }; players.set(id, p); }
        p.ws = ws; p.offAt = null;
      }
      const fn = handlers.get(m.t) || builtin[m.t];
      if (!fn) return;
      if (handlers.has(m.t) && !p.room && !m.t.startsWith('lobby:')) {
        // 게임 이벤트는 방 안에서만 (로비용은 'lobby:' 로 시작하게)
        return;
      }
      try { fn(p, m, { send, cast, room: p.room }); } catch (e) { console.error('[ws]', m.t, e); }
    });
    ws.on('close', () => {
      if (!p || p.ws !== ws) return;
      p.ws = null; p.offAt = Date.now();
      if (p.room) { cast(p.room, { t: 'away', id: p.id, name: p.name }); pushLobby(p.room); }
    });
    ws.on('error', () => {});
  });

  // 하트비트 + 오래 끊긴 사람 정리
  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* 무시 */ }
    }
    const now = Date.now();
    for (const p of [...players.values()]) {
      if (p.ws || !p.offAt || now - p.offAt < graceMs) continue;
      leaveRoom(p);
      players.delete(p.id);
    }
  }, heartbeatMs);
  timer.unref();

  return {
    wss, players, rooms, send, cast, pushLobby, leaveRoom,
    // 게임 전용 메시지 등록: net.on('move', (p, m, { send, cast, room }) => {...})
    on(t, fn) { handlers.set(t, fn); return this; },
    each(fn) { for (const r of rooms.values()) fn(r); },   // 게임 루프(setInterval)에서 방마다 상태 보내기
    stats: () => ({ rooms: rooms.size, players: players.size, online: [...players.values()].filter((p) => p.ws).length }),
  };
}

module.exports = { createWsRooms };
