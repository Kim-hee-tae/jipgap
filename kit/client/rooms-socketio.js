// 실시간 방 (브라우저, socket.io) — server/rooms-socketio.js 와 짝
// 필요: <script src="/socket.io/socket.io.js"></script>, kit.js
//
//   const net = KairuKit.rooms({
//     nickname: () => KairuKit.store.get('nick', ''),
//     onState: (room) => render(room),        // 방 상태 (players, chat, state ...)
//     onLobby: (list) => renderLobby(list),
//     onConn:  (ok, retrying) => showBadge(ok), // 연결 표시
//     onLeft:  () => showLobby(),
//   });
//   net.create('내 방', { 규칙: '...' });  net.join('A1B2C3');  net.leave();  net.chat('안녕');
//   net.emit('game:move', { i: 42 });      // 게임 전용 이벤트
//   net.on('game:over', (data) => ...);
//   net.chatAllow                          // 서버가 chatAllow 를 주면 허용 목록 배열 (이모티콘 버튼 그리기), 아니면 null
//
// - 기기별 clientId 를 localStorage 에 저장 → 새로고침·앱 전환 후 자동으로 같은 방 복귀
// - URL 해시(#방코드)로 바로 입장 가능 (초대 링크)
(function () {
  const K = window.KairuKit;
  if (!K) throw new Error('kit.js 를 먼저 불러오세요');

  K.rooms = function ({
    nickname = () => '', onState = () => {}, onLobby = () => {}, onConn = () => {}, onLeft = () => {}, onGone = null,
    useHash = true, url = undefined,
  } = {}) {
    if (typeof io !== 'function') throw new Error('/socket.io/socket.io.js 를 먼저 불러오세요');
    let clientId = K.store.get('clientId');
    if (!clientId) { clientId = K.randomId(); K.store.set('clientId', clientId); }

    const socket = io(url, { transports: ['websocket', 'polling'] });
    let room = null;
    let chatAllow = null;
    const hashRoom = () => (useHash ? decodeURIComponent(location.hash.slice(1)).toUpperCase().trim() : '');
    const setHash = (id) => { if (useHash && location.hash.slice(1) !== (id || '')) history.replaceState(null, '', id ? `#${id}` : location.pathname + location.search); };

    socket.on('connect', () => {
      onConn(true, false);
      socket.emit('hello', { clientId, nickname: nickname() }, (res) => {
        if (res.clientId !== clientId) { clientId = res.clientId; K.store.set('clientId', clientId); }
        chatAllow = Array.isArray(res.chatAllow) ? res.chatAllow : null;
        const target = hashRoom();
        if (!res.roomId && target) socket.emit('room:join', { roomId: target });
      });
    });
    socket.on('disconnect', () => onConn(false, false));
    socket.io.on('reconnect_attempt', () => onConn(false, true));
    socket.on('toast', (m) => K.toast(m));
    socket.on('lobby:rooms', (list) => onLobby(list));
    socket.on('room:state', (s) => { room = s; setHash(s.id); onState(s); });
    socket.on('room:left', () => { room = null; setHash(''); onLeft(); });
    socket.on('room:gone', ({ id, reason } = {}) => {
      if (room && room.id !== id) return;
      room = null; setHash('');
      if (onGone) onGone(reason); else { K.toast(`방이 닫혔어요${reason ? ` (${reason})` : ''}`); onLeft(); }
    });
    // 해시가 바뀌면(초대 링크 붙여넣기) 그 방으로
    if (useHash) window.addEventListener('hashchange', () => { const t = hashRoom(); if (t && (!room || room.id !== t)) socket.emit('room:join', { roomId: t }); });
    // 폰에서 앱으로 돌아왔는데 끊겨 있으면 바로 재연결
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !socket.connected) socket.connect(); });

    return {
      socket,
      get room() { return room; },
      get you() { return clientId; },
      get chatAllow() { return chatAllow; },
      create: (name, opts = {}) => socket.emit('room:create', { name, ...opts }),
      join: (roomId) => socket.emit('room:join', { roomId }),
      leave: () => socket.emit('room:leave'),
      chat: (text) => socket.emit('chat', text),
      setNickname: (n) => socket.emit('nickname', n),
      refreshLobby: () => socket.emit('lobby:list'),
      emit: (...a) => socket.emit(...a),
      on: (ev, fn) => socket.on(ev, fn),
      inviteLink: () => (room ? `${location.origin}${location.pathname}#${room.id}` : null),
    };
  };
})();
