// 실시간 방 (브라우저, 순수 WebSocket) — server/rooms-ws.js 와 짝, kit.js 필요
// cheongryong-arena 는 끊기면 "다시 들어와 주세요"였지만, 여기선 자동 재연결 + 같은 방 복귀까지 한다.
//
//   const net = KairuKit.wsRooms({
//     name: () => myName,
//     onMsg: { lobby: (m) => renderLobby(m.room), move: (m) => applyMove(m) },  // t 별 처리
//     onConn: (ok, retrying) => badge(ok),
//   });
//   net.create({ title: '한판', priv: false });  net.join('ABCD');  net.leave();
//   net.send({ t: 'move', x, y });               // 게임 메시지 (방 안에서만 처리됨)
//   net.ping → net.latency (ms)
(function () {
  const K = window.KairuKit;
  if (!K) throw new Error('kit.js 를 먼저 불러오세요');

  K.wsRooms = function ({ path = '/ws', name = () => '', onMsg = {}, onConn = () => {}, maxDelay = 8000 } = {}) {
    let clientId = K.store.get('clientId');
    if (!clientId) { clientId = K.randomId(); K.store.set('clientId', clientId); }
    let ws = null, tries = 0, closedByUser = false, retryTimer = null;
    const queue = [];
    const api = { room: null, you: clientId, latency: null };

    const wsUrl = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`;
    const raw = (m) => {
      const s = JSON.stringify(m);
      if (ws && ws.readyState === 1) ws.send(s);
      else if (queue.length < 50) queue.push(s);
    };

    function connect() {
      clearTimeout(retryTimer);
      try { ws = new WebSocket(wsUrl()); } catch { return retry(); }
      ws.onopen = () => {
        tries = 0;
        ws.send(JSON.stringify({ t: 'hello', clientId, name: name() }));
        while (queue.length) ws.send(queue.shift());
        onConn(true, false);
      };
      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.t === 'welcome') { api.you = m.you; api.room = m.room; }
        else if (m.t === 'joined') { api.room = m.room; api.you = m.you; }
        else if (m.t === 'lobby') api.room = m.room;
        else if (m.t === 'left' && !m.id) api.room = null;
        else if (m.t === 'pong' && m.c) api.latency = Math.round(performance.now() - m.c);
        else if (m.t === 'err') K.toast(m.msg);
        const fn = onMsg[m.t];
        if (fn) try { fn(m); } catch (e) { console.error(e); }
      };
      ws.onclose = (e) => {
        ws = null;
        if (closedByUser || e.code === 4000) return onConn(false, false); // 4000 = 다른 탭에서 접속
        onConn(false, true);
        retry();
      };
      ws.onerror = () => {};
    }
    function retry() {
      const delay = Math.min(maxDelay, 500 * 2 ** tries++) + Math.random() * 300;
      retryTimer = setTimeout(connect, delay);
    }
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && !ws && !closedByUser) { tries = 0; connect(); }
    });
    connect();

    return Object.assign(api, {
      send: raw,
      create: (opts = {}) => raw({ t: 'create', ...opts }),
      join: (code) => raw({ t: 'join', code }),
      leave: () => raw({ t: 'leave' }),
      list: () => raw({ t: 'list' }),
      rename: (n) => raw({ t: 'name', name: n }),
      ping: () => raw({ t: 'ping', c: performance.now() }),
      close: () => { closedByUser = true; ws?.close(); },
    });
  };
})();
