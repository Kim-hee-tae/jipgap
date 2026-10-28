// 실시간 방(Room) — socket.io 버전 (baduk-live 방식을 범용으로)
// 턴제·보드게임·채팅·로비가 있는 앱에 추천. 초당 수십 번 위치를 보내는 FPS 류는 rooms-ws.js.
//
//   const { Server } = require('socket.io');
//   const io = new Server(server, { pingInterval: 10000, pingTimeout: 10000 });
//   const rooms = createRooms(io, {
//     maxPlayers: 2,
//     initState: (room, opts) => ({ board: [] }),            // 방 만들 때 게임 상태
//     view: (room, cid) => ({ board: room.state.board }),     // 사람마다 보여줄 상태 (숨길 정보는 여기서 뺌)
//   });
//   rooms.on('game:move', ({ room, cid, broadcast, toast }, data) => { ...; broadcast(); });
//
// 기본 제공 이벤트 (클라이언트 → 서버)
//   hello {clientId, nickname}   ack → {clientId, nickname, roomId}   ← 재접속하면 원래 방으로 자동 복귀
//   lobby:list                   → lobby:rooms [..]
//   room:create {name, ...opts}  → room:state
//   room:join {roomId}           → room:state
//   room:leave                   → room:left
//   chat "텍스트"                → room:state (chat 포함)  — chatAllow 를 주면 그 목록의 문자열만 (예: 이모티콘 채팅)
//   nickname "이름"
// 서버 → 클라이언트: room:state, lobby:rooms, room:left, room:gone, toast
//
// 연결 끊김 규칙 (폰에서 앱 전환·화면 꺼짐 대비)
//   - 같은 clientId 로 다시 붙으면 방·자리 그대로 복귀
//   - seatMs 동안 안 돌아오면 자리 비움 (onDisconnectLong 으로 기권 처리 등 가능)
//   - 방에 연결된 사람이 아무도 없으면 emptyRoomMs 뒤 방 삭제
//
// 채팅 제한 (선택)
//   chatAllow: ['👍', '😂', ...]  → 목록과 정확히 같은 문자열만 받음, 나머지는 조용히 버림 (텍스트 금지 이모티콘 채팅)
//   chatGapMs: 700                → 한 사람이 이 간격 안에 또 보내면 버림 (도배 방지, 0 이면 제한 없음)
//   chatMax: 200                  → 자유 텍스트일 때 최대 글자 수
//   허용 목록은 hello 응답(ack.chatAllow)으로도 내려가서 브라우저가 버튼을 그릴 수 있다 (net.chatAllow)
const crypto = require('crypto');

function createRooms(io, {
  maxRooms = 200,
  maxPlayers = 2,
  allowSpectators = true,
  seatMs = 3 * 60 * 1000,
  emptyRoomMs = 3 * 60 * 1000,
  forgetClientMs = 30 * 60 * 1000,
  defaultNick = () => `손님${Math.floor(Math.random() * 900 + 100)}`,
  initState = () => ({}),
  view = (room) => room.state,
  canJoin = () => true,            // (room, cid) → true | '거절 사유'
  onJoin = () => {},               // (room, cid)
  onLeave = () => {},              // (room, cid, reason)
  onDisconnect = () => {},         // (room, cid)  — 막 끊겼을 때
  onReconnect = () => {},          // (room, cid)
  onDisconnectLong = null,         // (room, cid, offMs) → true 를 반환하면 기본 처리(자리 비움) 생략
  lobbyInfo = () => ({}),          // (room) → 로비 목록에 더 보여줄 정보
  chatAllow = null,                // 배열이면 이 문자열만 채팅 가능 (이모티콘 채팅). null 이면 자유 텍스트
  chatGapMs = 0,                   // 한 사람의 채팅 최소 간격 (ms)
  chatMax = 200,                   // 자유 텍스트 최대 글자 수
} = {}) {
  const chatAllowSet = Array.isArray(chatAllow) ? new Set(chatAllow.map(String)) : null;
  const clients = new Map(); // cid -> { id, nickname, sockets:Set, roomId, lastSeen }
  const rooms = new Map();   // roomId -> { id, name, hostId, players[], spectators[], chat[], state, createdAt }
  const handlers = new Map();

  const online = (cid) => (clients.get(cid)?.sockets.size || 0) > 0;
  const nick = (cid) => clients.get(cid)?.nickname || '?';
  const members = (room) => [...room.players, ...room.spectators];
  const anyOnline = (room) => members(room).some(online);

  function emitTo(cid, ev, data) {
    const c = clients.get(cid);
    if (c) for (const sid of c.sockets) io.to(sid).emit(ev, data);
  }

  function roomView(room, cid) {
    return {
      id: room.id, name: room.name, hostId: room.hostId, you: cid,
      players: room.players.map((p) => ({ id: p, nickname: nick(p), online: online(p) })),
      spectators: room.spectators.map((p) => ({ id: p, nickname: nick(p), online: online(p) })),
      chat: room.chat.slice(-50),
      state: view(room, cid),
    };
  }
  function broadcast(room) {
    if (!rooms.has(room.id)) return;
    for (const cid of members(room)) emitTo(cid, 'room:state', roomView(room, cid));
  }

  let lobbyTimer = null;
  const lobbyList = () => [...rooms.values()].map((r) => ({
    id: r.id, name: r.name, players: r.players.length, max: maxPlayers, spectators: r.spectators.length,
    host: nick(r.hostId), ...lobbyInfo(r),
  }));
  function broadcastLobby() {
    if (lobbyTimer) return;
    lobbyTimer = setTimeout(() => { lobbyTimer = null; io.to('lobby').emit('lobby:rooms', lobbyList()); }, 100);
  }

  function sysChat(room, text) {
    room.chat.push({ from: null, text, t: Date.now() });
    if (room.chat.length > 200) room.chat.shift();
  }

  function createRoom(name, hostId, opts = {}) {
    let id;
    do { id = crypto.randomBytes(3).toString('hex').toUpperCase(); } while (rooms.has(id));
    const room = {
      id, name: String(name || '').trim().slice(0, 20) || `${nick(hostId)}의 방`,
      hostId, players: [], spectators: [], chat: [], createdAt: Date.now(), allOfflineSince: null,
    };
    room.state = initState(room, opts) || {};
    rooms.set(id, room);
    return room;
  }

  function deleteRoom(room, reason) {
    for (const cid of members(room)) {
      const c = clients.get(cid);
      if (c && c.roomId === room.id) c.roomId = null;
    }
    io.to(room.id).emit('room:gone', { id: room.id, reason });
    io.in(room.id).socketsLeave(room.id);
    rooms.delete(room.id);
    broadcastLobby();
  }

  function joinRoom(cid, room) {
    const c = clients.get(cid);
    if (c.roomId && c.roomId !== room.id) leaveRoom(cid);
    if (!members(room).includes(cid)) {
      const ok = canJoin(room, cid);
      if (ok !== true) return typeof ok === 'string' ? ok : '들어갈 수 없는 방이에요';
      if (room.players.length < maxPlayers) room.players.push(cid);
      else if (allowSpectators) room.spectators.push(cid);
      else return '방이 꽉 찼어요';
      sysChat(room, `${nick(cid)}님이 들어왔습니다`);
      onJoin(room, cid);
    }
    c.roomId = room.id;
    for (const sid of c.sockets) { io.sockets.sockets.get(sid)?.join(room.id); io.sockets.sockets.get(sid)?.leave('lobby'); }
    broadcast(room);
    broadcastLobby();
    return true;
  }

  function leaveRoom(cid, reason = '') {
    const c = clients.get(cid);
    const room = c && rooms.get(c.roomId);
    if (!room) { if (c) c.roomId = null; return; }
    room.players = room.players.filter((x) => x !== cid);
    room.spectators = room.spectators.filter((x) => x !== cid);
    c.roomId = null;
    for (const sid of c.sockets) { io.sockets.sockets.get(sid)?.leave(room.id); io.sockets.sockets.get(sid)?.join('lobby'); }
    emitTo(cid, 'room:left', { id: room.id });
    onLeave(room, cid, reason);
    if (!room.players.length && !room.spectators.length) return deleteRoom(room, '빈 방');
    // 관전자가 있으면 빈 자리로 올림
    while (room.players.length < maxPlayers && room.spectators.length) room.players.push(room.spectators.shift());
    if (room.hostId === cid) room.hostId = room.players[0] || room.spectators[0];
    sysChat(room, reason || `${nick(cid)}님이 나갔습니다`);
    broadcast(room);
    broadcastLobby();
  }

  io.on('connection', (socket) => {
    socket.join('lobby');
    const ctx = () => {
      const cid = socket.data.cid;
      const client = clients.get(cid);
      const room = client && rooms.get(client.roomId);
      return {
        cid, client, room, socket,
        toast: (msg) => socket.emit('toast', msg),
        broadcast: () => room && broadcast(room),
        sysChat: (text) => room && sysChat(room, text),
      };
    };
    // 모든 핸들러: hello 전 요청 무시 + 에러가 서버를 죽이지 않게
    const on = (ev, fn) => socket.on(ev, (...args) => {
      if (!socket.data.cid && ev !== 'hello') return;
      const ack = typeof args[args.length - 1] === 'function' ? args.pop() : null;
      try {
        const r = fn(ctx(), args[0], ack);
        if (r && typeof r.catch === 'function') r.catch((e) => { console.error(ev, e); socket.emit('toast', '서버 오류가 발생했습니다'); });
      } catch (e) { console.error(ev, e); socket.emit('toast', '서버 오류가 발생했습니다'); }
    });

    on('hello', (_, { clientId, nickname } = {}, ack) => {
      const cid = typeof clientId === 'string' && /^[\w-]{8,64}$/.test(clientId) ? clientId : crypto.randomUUID();
      socket.data.cid = cid;
      let client = clients.get(cid);
      if (!client) { client = { id: cid, nickname: '', sockets: new Set(), roomId: null }; clients.set(cid, client); }
      client.nickname = String(nickname || '').trim().slice(0, 12) || client.nickname || defaultNick();
      const wasOffline = client.sockets.size === 0;
      client.sockets.add(socket.id);
      const room = client.roomId && rooms.get(client.roomId);
      if (room) {
        socket.join(room.id); socket.leave('lobby');
        room.allOfflineSince = null;
        if (wasOffline) { sysChat(room, `${client.nickname}님이 다시 연결되었습니다`); onReconnect(room, cid); }
        broadcast(room);
        broadcastLobby();
      } else client.roomId = null;
      ack?.({ clientId: cid, nickname: client.nickname, roomId: room ? room.id : null, chatAllow: chatAllowSet ? [...chatAllowSet] : null });
      socket.emit('lobby:rooms', lobbyList());
    });

    on('nickname', ({ client, room }, name) => {
      const n = String(name || '').trim().slice(0, 12);
      if (!n) return;
      client.nickname = n;
      if (room) broadcast(room);
      broadcastLobby();
    });
    on('lobby:list', () => socket.emit('lobby:rooms', lobbyList()));
    on('room:create', ({ cid, toast }, { name, ...opts } = {}, ack) => {
      if (rooms.size >= maxRooms) return toast('방이 너무 많습니다. 잠시 후 다시 시도하세요');
      const room = createRoom(name, cid, opts);
      sysChat(room, `「${room.name}」 방이 만들어졌습니다`);
      joinRoom(cid, room);
      ack?.({ roomId: room.id });
    });
    on('room:join', ({ cid, toast }, { roomId } = {}, ack) => {
      const room = rooms.get(String(roomId || '').toUpperCase());
      if (!room) { toast('없는 방이에요'); return ack?.({ error: 'not found' }); }
      const r = joinRoom(cid, room);
      if (r !== true) toast(r);
      ack?.(r === true ? { roomId: room.id } : { error: r });
    });
    on('room:leave', ({ cid }) => leaveRoom(cid));
    on('chat', ({ cid, client, room }, text) => {
      if (!room || typeof text !== 'string') return;
      let t;
      if (chatAllowSet) { if (!chatAllowSet.has(text)) return; t = text; }
      else { t = text.trim().slice(0, chatMax); if (!t) return; }
      const now = Date.now();
      if (chatGapMs && now - (client.lastChatAt || 0) < chatGapMs) return;
      client.lastChatAt = now;
      room.chat.push({ from: nick(cid), cid, text: t, t: Date.now() });
      if (room.chat.length > 200) room.chat.shift();
      broadcast(room);
    });

    for (const [ev, fn] of handlers) on(ev, fn);

    socket.on('disconnect', () => {
      const cid = socket.data.cid;
      const client = cid && clients.get(cid);
      if (!client) return;
      client.sockets.delete(socket.id);
      if (client.sockets.size) return;
      client.lastSeen = Date.now();
      const room = rooms.get(client.roomId);
      if (!room) return;
      sysChat(room, `${client.nickname}님의 연결이 끊겼습니다`);
      onDisconnect(room, cid);
      if (!anyOnline(room)) room.allOfflineSince = Date.now();
      broadcast(room);
      broadcastLobby();
    });
  });

  // 끊긴 사람·빈 방 정리
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const room of [...rooms.values()]) {
      if (anyOnline(room)) { room.allOfflineSince = null; continue; }
      room.allOfflineSince ??= now;
      if (now - room.allOfflineSince > emptyRoomMs) deleteRoom(room, '모두 연결 끊김');
    }
    for (const client of [...clients.values()]) {
      if (client.sockets.size) continue;
      const off = now - (client.lastSeen || now);
      const room = rooms.get(client.roomId);
      if (room) {
        if (off > seatMs && !(onDisconnectLong && onDisconnectLong(room, client.id, off))) {
          leaveRoom(client.id, `${client.nickname}님이 연결이 끊긴 지 오래되어 자리를 비웠습니다`);
        }
      } else {
        client.roomId = null;
        if (off > forgetClientMs) clients.delete(client.id);
      }
    }
  }, 5000);
  sweeper.unref();

  return {
    io, clients, rooms,
    // 게임 전용 이벤트 등록 — 서버 시작 전에(접속이 오기 전에) 호출
    on(ev, fn) { handlers.set(ev, fn); return this; },
    broadcast, broadcastLobby, sysChat, emitTo, online, nick, members,
    leaveRoom, deleteRoom,
    get: (id) => rooms.get(id),
    stats: () => ({ rooms: rooms.size, clients: clients.size, online: [...clients.values()].filter((c) => c.sockets.size).length }),
  };
}

module.exports = { createRooms };
