// 집값 점수판 — 화면
(function () {
  const K = window.KairuKit;
  const $ = (s, el = document) => el.querySelector(s);
  const esc = K.esc;

  K.registerSW && K.registerSW('/sw.js');
  K.autoUpdate();
  const favs = K.favorites({ mode: 'local', key: 'favRegions', max: 12, onChange: renderFavs });

  const S = { code: '00', band: K.store.get('band', '30평대'), data: null, regions: [], showAll: {} };
  const LEVEL_NAME = { nation: '전국', sido: '시도', sgg: '시군구', dong: '읍면동' };
  const CHILD_NAME = { nation: '시도', sido: '시군구', sgg: '동네' };
  const charts = [];

  // ── 숫자 표시 ──
  // 만원 → "4억 4,000" / "10억" / "9,500만" (네이버 부동산 표기)
  const fmtEok = (v) => {
    if (v === null || v === undefined || !Number.isFinite(v)) return '-';
    const n = Math.round(Math.abs(v)), sign = v < 0 ? '-' : '';
    const eok = Math.floor(n / 10000), man = n % 10000;
    if (!eok) return `${sign}${man.toLocaleString()}만`;
    return `${sign}${eok}억${man ? ` ${man.toLocaleString()}` : ''}`;
  };
  // 등기·직거래 표시
  const tradeBadges = (t) => (t ? `${t.rgst ? `<span class="badge reg" title="등기일 ${esc(t.rgst)}">등기</span>` : ''}${t.direct ? '<span class="badge direct" title="중개사 없이 직접 거래">직거래</span>' : ''}` : '');
  const fmtPpp = (v) => {
    if (v === null || v === undefined) return '-';
    if (v >= 10000) return `${(v / 10000).toFixed(2).replace(/0$/, '').replace(/\.0$/, '')}억`;
    if (v >= 1000) return `${(v / 1000).toFixed(1).replace(/\.0$/, '')}천`;
    return `${Math.round(v)}만`;
  };
  const fmtPct = (v, d = 1) => (v === null || v === undefined ? '-' : `${v > 0 ? '+' : ''}${v.toFixed(d)}%`);
  const dir = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
  const ymLabel = (ym) => `${ym.slice(0, 4)}.${ym.slice(4)}`;
  const scoreClass = (s) => (s === null || s === undefined ? 'c0' : s < 2.5 ? 'c1' : s < 4.5 ? 'c2' : s < 6.5 ? 'c3' : s < 8.5 ? 'c4' : 'c5');
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const scoreColor = (s) => css(`--s${scoreClass(s).slice(1) || 3}`) || '#e0a92b';
  const PHRASE = { 매우유의: '매우 유의해야 해요', 유의: '유의해야 해요', 보통: '보통이에요', 좋음: '좋아요', 매우좋음: '매우 좋아요', '데이터 없음': '판단할 데이터가 부족해요' };
  const fmtValue = (ind) => {
    const v = ind.value;
    if (ind.unit === '%') return `${ind.id === 'mom3' || ind.id === 'yoy' ? (v > 0 ? '+' : '') : ''}${Number(v).toFixed(ind.id === 'jeonse' ? 1 : 2)}%`;
    if (ind.unit === '배') return `${Number(v).toFixed(2)}배`;
    return `${Math.round(v).toLocaleString()}${ind.unit === '호' ? '호' : '건'}`;
  };

  // ── 라우팅: #/r/<지역코드> ──
  function codeFromHash() {
    const m = location.hash.match(/^#\/r\/([^?]+)/);
    return m ? decodeURIComponent(m[1]) : '00';
  }
  function go(code) {
    if (code === S.code && S.data) return;
    location.hash = `#/r/${encodeURIComponent(code)}`;
  }
  window.addEventListener('hashchange', () => load(codeFromHash()));

  // ── 탭 ──
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
    const d = S.data, lv = b.dataset.tab;
    if (lv === 'nation') return go('00');
    const r = d && d.region, parents = d ? d.parents : [];
    const sido = r && r.level === 'sido' ? r.code : (parents.find((p) => p.level === 'sido') || {}).code;
    const sgg = r && r.level === 'sgg' ? r.code : (parents.find((p) => p.level === 'sgg') || {}).code;
    const favOf = (lvl) => favs.list().map((f) => f.id).find((id) => (S.regions.find((x) => x.code === id) || {}).level === lvl);
    if (lv === 'sido') return go(sido || favOf('sido') || '11');
    if (lv === 'sgg') return go(sgg || favOf('sgg') || (r && r.level === 'sido' && d.children[0] ? d.children[0].code : '11680'));
  }));

  // ── 검색 ──
  const q = $('#q'), sug = $('#suggest');
  let sugItems = [], sugIdx = 0;
  const norm = (s) => s.replace(/\s+/g, '').toLowerCase();
  q.addEventListener('input', () => {
    const t = norm(q.value);
    if (!t) { sug.hidden = true; return; }
    const order = { sido: 0, sgg: 1, dong: 2, nation: 3 };
    sugItems = S.regions.filter((r) => norm(r.full).includes(t) || norm(r.name).startsWith(t))
      .sort((a, b) => (norm(a.name).startsWith(t) ? 0 : 1) - (norm(b.name).startsWith(t) ? 0 : 1) || order[a.level] - order[b.level])
      .slice(0, 10);
    sugIdx = 0;
    drawSug();
  });
  function drawSug() {
    sug.innerHTML = sugItems.length
      ? sugItems.map((r, i) => `<li role="option" data-code="${esc(r.code)}" aria-selected="${i === sugIdx}"><span>${esc(r.full)}</span><span class="lv">${LEVEL_NAME[r.level]}</span></li>`).join('')
      : '<li class="lv">찾는 지역이 없어요</li>';
    sug.hidden = false;
  }
  q.addEventListener('keydown', (e) => {
    if (sug.hidden || !sugItems.length) return;
    if (e.key === 'ArrowDown') { sugIdx = (sugIdx + 1) % sugItems.length; drawSug(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sugIdx = (sugIdx - 1 + sugItems.length) % sugItems.length; drawSug(); e.preventDefault(); }
    else if (e.key === 'Enter') { pick(sugItems[sugIdx].code); e.preventDefault(); }
    else if (e.key === 'Escape') sug.hidden = true;
  });
  sug.addEventListener('mousedown', (e) => { const li = e.target.closest('li[data-code]'); if (li) { e.preventDefault(); pick(li.dataset.code); } });
  q.addEventListener('blur', () => setTimeout(() => { sug.hidden = true; }, 120));
  function pick(code) { sug.hidden = true; q.value = ''; q.blur(); go(code); }

  // ── 관심 지역 ──
  $('#star').addEventListener('click', async () => {
    const r = S.data && S.data.region;
    if (!r) return;
    try {
      const on = await favs.toggle(r.code, { name: r.full });
      K.toast(on ? '관심 지역에 담았어요' : '관심 지역에서 뺐어요');
      renderStar();
    } catch (e) { K.toast(e.message); }
  });
  function renderStar() {
    const on = S.data && favs.has(S.data.region.code);
    $('#star').textContent = on ? '★' : '☆';
    $('#star').setAttribute('aria-pressed', String(Boolean(on)));
  }
  function renderFavs(list) {
    $('#favs').innerHTML = (list || favs.list()).map((f) => `<button class="chip" data-code="${esc(f.id)}">${esc(f.name || f.id)}</button>`).join('');
  }
  $('#favs').addEventListener('click', (e) => { const b = e.target.closest('[data-code]'); if (b) go(b.dataset.code); });
  $('#back').addEventListener('click', () => { const p = S.data && S.data.parents; if (p && p.length) go(p[p.length - 1].code); });

  // ── 불러오기 ──
  let loadSeq = 0;
  async function load(code) {
    const seq = ++loadSeq;
    S.code = code;
    try {
      const d = await K.api(`/api/region/${encodeURIComponent(code)}?band=${encodeURIComponent(S.band)}`);
      if (seq !== loadSeq) return;
      S.data = d; S.showAll = {};
      render();
      window.scrollTo({ top: 0 });
    } catch (e) {
      if (seq !== loadSeq) return;
      $('#main').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
      if (/준비/.test(e.message)) setTimeout(() => load(code), 20000);
    }
  }
  async function loadApts(band) {
    S.band = band; K.store.set('band', band);
    const d = await K.api(`/api/region/${encodeURIComponent(S.code)}?band=${encodeURIComponent(band)}`);
    S.data.apts = d.apts; S.data.band = d.band; S.showAll.apts = false;
    $('#aptCard').outerHTML = aptCard();
  }

  // ── 그리기 ──
  function render() {
    const d = S.data, r = d.region;
    document.title = `${r.full} · 집값 점수판`;
    $('#demoBar').hidden = !d.meta.demo;
    $('#demoBar').textContent = d.meta.collecting
      ? '실거래가를 받아 오는 중이에요 — 끝나면 실제 시세로 바뀌어요. 지금 보이는 건 데모 데이터예요.'
      : '데모 데이터예요 — 실제 시세가 아니에요. 공공데이터 인증키를 넣으면 실거래가로 바뀌어요.';
    const tab = r.level === 'dong' ? 'sgg' : r.level;
    document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    $('#back').hidden = !d.parents.length;
    $('#crumbs').innerHTML = [...d.parents, { code: r.code, name: r.name }]
      .map((p, i, a) => (i === a.length - 1 ? `<span>${esc(p.name)}</span>` : `<a href="#/r/${esc(p.code)}">${esc(p.name)}</a><span class="sep">›</span>`)).join('');
    renderStar();
    $('#footInfo').textContent = `기준월 ${ymLabel(d.meta.refYm)} · 집계 ${new Date(d.meta.builtAt).toLocaleString('ko-KR')}${d.meta.demo ? ' · 데모 데이터' : ''}`;

    charts.splice(0).forEach((c) => c.dispose());
    $('#main').innerHTML = `
      <div class="col">${summaryCard()}</div>
      <div class="col">${childCard()}${aptCard()}</div>
      <div class="col">${indicatorCard()}</div>`;
    drawSummaryCharts();
    drawChildTreemap();
    drawSparks();
  }

  // 1) 환경 요약
  function summaryCard() {
    const d = S.data, r = d.region, sc = d.scores;
    if (!sc || sc.total === null || sc.total === undefined) {
      return `<section class="card"><p class="eyebrow">${esc(r.full)}</p><h2>점수를 매길 만큼<br>거래가 쌓이지 않았어요</h2><p class="desc">거래가 많은 상위 지역을 확인해 보세요.</p>${priceBlock()}</section>`;
    }
    const prev = sc.totalHistory[d.meta.ref - 1];
    const change = prev !== null && prev !== undefined ? sc.total - prev : 0;
    const sub = sc.totalChanged ? `지난달보다 점수가 ${Math.abs(change).toFixed(1)}점 ${change > 0 ? '올랐어요' : '내렸어요'}.` : '지표에 큰 변화가 없어요.';
    const fromNote = sc.from !== r.code ? `<p class="note">동네 단위는 거래가 적어 ${esc(sc.name)} 점수를 보여드려요.</p>` : '';
    return `<section class="card">
      <h2>${esc(r.level === 'dong' ? sc.name : r.name)} 매매 환경이<br>투자 관점 <span class="${scoreClass(sc.total)}">${PHRASE[sc.totalLabel]}</span></h2>
      <p class="desc">${sub}</p>
      <div class="counts"><div><small>좋은 지표</small><b class="c4">${sc.good}</b> <small style="display:inline">/ ${sc.indicators.length}개</small></div>
        <div><small>유의할 지표</small><b class="c1">${sc.bad}</b> <small style="display:inline">/ ${sc.indicators.length}개</small></div></div>
      <div id="catMap" class="treemap-box" role="img" aria-label="수요 공급 시황 점수"></div>
      ${fromNote}
      ${priceBlock()}
    </section>`;
  }
  function priceBlock() {
    const d = S.data, r = d.region, sc = d.scores;
    const upto = r.ppp.slice(0, d.meta.ref + 1).filter((v) => v !== null);
    const totals = sc ? sc.totalHistory.filter((v) => v !== null) : [];
    return `<div id="priceChart" class="chart small" role="img" aria-label="평당가와 투자점수 추이"></div>
      <div class="stats">
        <div><small>${esc(r.name)} 평당가</small><b>${fmtPpp(r.pppNow)}원</b><span>최저 ${fmtPpp(Math.min(...upto))} / 최고 ${fmtPpp(Math.max(...upto))}</span></div>
        ${totals.length ? `<div><small>투자점수</small><b><span class="${scoreClass(sc.total)}">${sc.totalLabel} ${sc.total}</span>/10</b><span>최저 ${Math.min(...totals)} / 최고 ${Math.max(...totals)}</span></div>` : `<div><small>최근 6개월 거래</small><b>${r.trades6m.toLocaleString()}건</b></div>`}
      </div>`;
  }
  function drawSummaryCharts() {
    const d = S.data, r = d.region, sc = d.scores;
    const el = $('#catMap');
    if (el && sc) {
      const cats = ['수요', '공급', '시황'].map((c) => ({ c, s: sc.cats[c], n: sc.indicators.filter((i) => i.cat === c).length })).filter((x) => x.n && x.s.score !== null);
      const ch = echarts.init(el);
      ch.setOption({
        tooltip: { show: false },
        series: [{
          type: 'treemap', roam: false, nodeClick: false, breadcrumb: { show: false }, width: '100%', height: '100%', top: 0, left: 0,
          itemStyle: { borderColor: css('--panel'), borderWidth: 3, gapWidth: 3 },
          label: { show: true, color: '#fff', fontFamily: 'Pretendard Variable, sans-serif', formatter: (p) => `{a|${p.data.c}}\n{b|${p.data.s.score}점(${p.data.s.label})}`,
            rich: { a: { fontSize: 26, fontWeight: 800, color: '#fff', lineHeight: 36 }, b: { fontSize: 17, fontWeight: 700, color: '#fff', lineHeight: 24 } } },
          data: cats.map((x) => ({ name: x.c, value: x.n + 2, c: x.c, s: x.s, itemStyle: { color: scoreColor(x.s.score) } })),
        }],
      });
      charts.push(ch);
    }
    const pc = $('#priceChart');
    if (pc) {
      const ref = d.meta.ref;
      const months = d.meta.months.slice(0, ref + 1).map(ymLabel);
      const ch = echarts.init(pc);
      const series = [{ name: '평당가', type: 'line', smooth: true, showSymbol: false, data: r.ppp.slice(0, ref + 1), lineStyle: { width: 2.5, color: '#5b7cf0' }, itemStyle: { color: '#5b7cf0' }, connectNulls: true }];
      if (sc) series.push({ name: '투자점수', type: 'line', yAxisIndex: 1, smooth: true, showSymbol: false, data: sc.totalHistory.slice(0, ref + 1), lineStyle: { width: 2.5, color: '#31a26a' }, itemStyle: { color: '#31a26a' }, connectNulls: true });
      ch.setOption({
        grid: { left: 8, right: 8, top: 28, bottom: 24, containLabel: false },
        legend: { top: 0, left: 0, icon: 'roundRect', itemWidth: 12, itemHeight: 4, textStyle: { color: css('--sub'), fontSize: 12 } },
        tooltip: { trigger: 'axis', valueFormatter: (v) => v, formatter: (ps) => `${ps[0].axisValue}<br>${ps.map((p) => `${p.marker}${p.seriesName} ${p.value === null || p.value === undefined ? '-' : p.seriesName === '평당가' ? `${fmtPpp(p.value)}원` : `${p.value}점`}`).join('<br>')}` },
        xAxis: { type: 'category', data: months, boundaryGap: false, axisTick: { show: false }, axisLine: { lineStyle: { color: css('--line') } },
          axisLabel: { color: css('--faint'), fontSize: 11, interval: Math.max(0, Math.floor(months.length / 3) - 1), showMaxLabel: true } },
        yAxis: [{ type: 'value', scale: true, show: false }, { type: 'value', min: 0, max: 10, show: false }],
        series,
      });
      charts.push(ch);
    }
  }

  // 2) 가장 많이 오른 하위 지역
  function childCard() {
    const d = S.data, r = d.region;
    if (r.level === 'dong') return '';
    const kids = d.children;
    const label = CHILD_NAME[r.level];
    if (!kids.length) return `<section class="card"><p class="eyebrow">실거래가 1년 변화</p><h2>${esc(r.name)}에서<br>가장 많이 오른 ${label}는?</h2><p class="empty-card">비교할 만큼 거래가 있는 ${label}가 없어요.</p></section>`;
    const n = S.showAll.kids ? kids.length : Math.min(8, kids.length);
    return `<section class="card">
      <p class="eyebrow">실거래가 1년 변화</p>
      <h2>${esc(r.name)}에서 지난 1년<br>가장 많이 오른 ${label}${label === '동네' ? '는' : '는'}?</h2>
      <div id="kidMap" class="treemap-box" role="img" aria-label="하위 지역 상승률"></div>
      <ol class="rank">${kids.slice(0, n).map((k, i) => `
        <li class="link" data-code="${esc(k.code)}">
          ${medal(i)}
          <div><div class="nm">${esc(k.name)}</div><div class="meta">최근 6개월 거래 ${k.trades6m.toLocaleString()}건</div></div>
          <div class="right"><div class="flow">평당 ${fmtPpp(k.pppPast)} → <span class="tag">지금</span>${fmtPpp(k.pppNow)}</div>
            <div class="pct ${dir(k.change)}">${fmtPct(k.change)} ${k.change >= 0 ? '상승' : '하락'}</div></div>
        </li>`).join('')}</ol>
      ${kids.length > n ? `<button class="more" data-more="kids">${kids.length - n}곳 더 보기</button>` : ''}
      <p class="note">같은 단지·같은 평형대의 최근 6개월과 1년 전 6개월 실거래 중앙값을 비교했어요.</p>
    </section>`;
  }
  function medal(i) { return `<span class="medal ${i < 3 ? `m${i + 1}` : ''}">${i + 1}</span>`; }
  function drawChildTreemap() {
    const el = $('#kidMap');
    if (!el) return;
    const top = S.data.children.slice(0, 6);
    const max = Math.max(...S.data.children.map((k) => Math.abs(k.change)), 1);
    const ch = echarts.init(el);
    ch.setOption({
      series: [{
        type: 'treemap', roam: false, nodeClick: false, breadcrumb: { show: false }, width: '100%', height: '100%', top: 0, left: 0,
        itemStyle: { borderColor: '#2b2f3a', borderWidth: 4, gapWidth: 4 },
        label: { show: true, color: '#fff', formatter: (p) => `{a|${p.name}}\n{b|${fmtPct(p.data.change)}}`,
          rich: { a: { fontSize: 17, fontWeight: 600, color: '#fff', lineHeight: 26 }, b: { fontSize: 21, fontWeight: 700, color: '#fff', lineHeight: 28 } } },
        data: top.map((k) => {
          const t = Math.min(1, Math.abs(k.change) / max);
          const color = k.change >= 0 ? `rgb(${Math.round(150 + 60 * t)},${Math.round(70 - 20 * t)},${Math.round(70 - 20 * t)})` : `rgb(${Math.round(60 - 20 * t)},${Math.round(100 + 10 * t)},${Math.round(190 + 40 * t)})`;
          return { name: k.name, value: Math.max(1, k.trades6m), change: k.change, code: k.code, itemStyle: { color } };
        }),
      }],
    });
    ch.on('click', (p) => p.data && p.data.code && go(p.data.code));
    charts.push(ch);
  }

  // 3) 가장 많이 오른 아파트
  function aptCard() {
    const d = S.data, r = d.region, list = d.apts || [];
    const n = S.showAll.apts ? list.length : Math.min(10, list.length);
    const now = new Date().getFullYear();
    const sel = `<select class="sel" id="bandSel" aria-label="평형대">${d.meta.bands.map((b) => `<option ${b === d.band ? 'selected' : ''}>${b}</option>`).join('')}</select>`;
    return `<section class="card" id="aptCard">
      <p class="eyebrow">실거래가 1년 변화</p>
      <h2>${esc(r.name)}에서 지난 1년<br>가장 많이 오른 ${sel} 아파트는?</h2>
      ${list.length ? `<ol class="rank">${list.slice(0, n).map((a, i) => `
        <li data-sgg="${esc(a.sgg)}" data-apt="${esc(aptIdOf(a))}" tabindex="0" title="지도와 실거래 내역 보기">
          ${medal(i)}
          <div><div class="nm">${r.level === 'nation' || r.level === 'sido' ? `<span class="tag">${esc(regionName(a.sgg))}</span>` : ''}${esc(a.umd)} ${esc(a.name)}</div>
            <div class="meta">전용 ${a.area}㎡${a.built ? ` · ${now - a.built + 1}년차` : ''} · 거래 1년 전 ${a.nPast}건 · 최근 ${a.nRec}건</div>
            ${a.last ? `<div class="meta">최근 실거래 <b class="last">${fmtEok(a.last.price)}</b> (${a.last.ym.slice(2, 4)}.${a.last.ym.slice(4)}${a.last.day ? `.${String(a.last.day).padStart(2, '0')}` : ''}${a.last.floor !== null && a.last.floor !== undefined ? ` · ${a.last.floor}층` : ''}) ${tradeBadges(a.last)}</div>` : ''}</div>
          <div class="right"><div class="flow">${fmtEok(a.pricePast)} → ${fmtEok(a.price)}</div>
            <div class="pct ${dir(a.change)}">${fmtPct(a.change, 0)} (${fmtEok(Math.abs(a.price - a.pricePast))}) ${a.change >= 0 ? '상승' : '하락'}</div></div>
        </li>`).join('')}</ol>
        ${list.length > n ? `<button class="more" data-more="apts">${list.length - n}곳 더 보기</button>` : ''}`
        : `<p class="empty-card">이 평형대는 1년 전과 비교할 거래가 부족해요. 다른 평형대를 골라 보세요.</p>`}
      <p class="note">금액은 각 기간(최근 6개월 / 1년 전 6개월) 마지막 거래 3건의 중앙값이에요. 층·향에 따라 실제 시세와 다를 수 있어요.</p>
    </section>`;
  }
  const aptIdOf = (a) => a.key.split('|').slice(1, -1).join('|'); // 시군구|단지ID|평형대 → 단지ID
  function regionName(code) { const r = S.regions.find((x) => x.code === code); return r ? r.full.replace(/^\S+\s/, '') : code; }

  // 4) 지표 모아보기
  function indicatorCard() {
    const sc = S.data.scores;
    if (!sc || !sc.indicators.length) return '';
    const groups = ['수요', '공급', '시황'];
    const missing = [];
    if (!S.data.meta.sources.rates) missing.push('금리(ECOS 인증키)');
    if (!S.data.meta.sources.unsold) missing.push('미분양(KOSIS URL)');
    return `<section class="card">
      <p class="eyebrow">영향을 주는 지표를 모아봤어요</p>
      <h2>지표로 자세히 알아보세요</h2>
      <div class="trio">${groups.map((g) => `<div><small>${g} 종합</small><b class="${scoreClass(sc.cats[g].score)}">${sc.cats[g].score === null ? '-' : `${sc.cats[g].score}점(${sc.cats[g].label})`}</b></div>`).join('')}</div>
      ${groups.map((g) => {
        const list = sc.indicators.filter((i) => i.cat === g);
        if (!list.length) return '';
        return `<h3>${g}지표</h3><ul class="ind">${list.map((i) => `
          <li data-ind="${i.id}">
            <svg class="spark" viewBox="0 0 96 40" preserveAspectRatio="none" data-spark="${i.id}" aria-hidden="true"></svg>
            <div><div class="nm">${esc(i.name)}</div><div class="lbl"><span class="${scoreClass(i.score)}">${i.label}(${i.score}점)</span> <span class="meta">· ${i.trend}</span></div></div>
            <div class="val">${fmtValue(i)}</div>
            <div class="detail" hidden>${esc(i.desc)}. 지금 값이 과거 기록에서 ${i.better === 'low' ? '낮을수록' : '높을수록'} 점수가 높아요.</div>
          </li>`).join('')}</ul>`;
      }).join('')}
      ${missing.length ? `<p class="note">아직 연결 안 된 지표: ${missing.join(', ')}</p>` : ''}
    </section>`;
  }
  function drawSparks() {
    const sc = S.data.scores;
    if (!sc) return;
    for (const svg of document.querySelectorAll('[data-spark]')) {
      const ind = sc.indicators.find((i) => i.id === svg.dataset.spark);
      const vals = ind.spark;
      const xs = vals.map((v, i) => [i, v]).filter((p) => p[1] !== null);
      if (xs.length < 2) continue;
      const min = Math.min(...xs.map((p) => p[1])), max = Math.max(...xs.map((p) => p[1]));
      const sx = (i) => (i / (vals.length - 1)) * 94 + 1, sy = (v) => 37 - ((v - min) / (max - min || 1)) * 34;
      const pts = xs.map(([i, v]) => `${sx(i).toFixed(1)},${sy(v).toFixed(1)}`).join(' ');
      svg.innerHTML = `<polyline points="${pts}" fill="none" stroke="${scoreColor(ind.score)}" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>`;
    }
  }

  // ── 단지 상세: 지도 + 실거래 내역 ──
  // 지도는 티맵(서버에 TMAP_APP_KEY 가 있으면 /tmap-loader.js 가 SDK 를 붙임), 없으면 Leaflet + OpenStreetMap
  const MapView = (() => {
    let kind = null, map = null, marker = null, leafletLoading = null;
    const LEAFLET = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/';
    function loadLeaflet() {
      if (window.L) return Promise.resolve();
      if (leafletLoading) return leafletLoading;
      leafletLoading = new Promise((ok, fail) => {
        const css = document.createElement('link');
        css.rel = 'stylesheet'; css.href = `${LEAFLET}leaflet.min.css`;
        document.head.appendChild(css);
        const sc = document.createElement('script');
        sc.src = `${LEAFLET}leaflet.min.js`;
        sc.onload = ok;
        sc.onerror = () => { leafletLoading = null; fail(new Error('지도를 불러오지 못했어요')); };
        document.head.appendChild(sc);
      });
      return leafletLoading;
    }
    async function show(el, lat, lon, title) {
      if (window.Tmapv2 && !window.TMAP_OFF) {
        const pos = new Tmapv2.LatLng(lat, lon);
        if (kind !== 'tmap') {
          el.innerHTML = '';
          map = new Tmapv2.Map(el.id, { center: pos, width: '100%', height: `${el.clientHeight || 280}px`, zoom: 16 });
          kind = 'tmap';
        } else {
          if (typeof map.resize === 'function') map.resize(el.clientWidth, el.clientHeight || 280);
          map.setCenter(pos); map.setZoom(16);
        }
        if (marker) marker.setMap(null);
        marker = new Tmapv2.Marker({ position: pos, map, title });
        return 'tmap';
      }
      await loadLeaflet();
      if (kind !== 'leaflet') {
        map = L.map(el, { zoomControl: true });
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
        kind = 'leaflet';
      }
      map.setView([lat, lon], 16);
      setTimeout(() => map.invalidateSize(), 60);
      if (marker) marker.remove();
      marker = L.circleMarker([lat, lon], { radius: 9, color: '#fff', weight: 3, fillColor: '#e03131', fillOpacity: 1 })
        .addTo(map).bindTooltip(esc(title), { permanent: true, direction: 'top', offset: [0, -10] });
      return 'leaflet';
    }
    return { show };
  })();

  const A = { open: false, data: null, band: '전체', showAll: false, chart: null };
  function mapMsg(text) { const m = $('#aptMapMsg'); m.textContent = text; m.hidden = !text; }
  async function openApt(sgg, id, band) {
    $('#aptSheet').hidden = false;
    document.body.style.overflow = 'hidden';
    if (!A.open) { history.pushState({ aptSheet: 1 }, ''); A.open = true; }
    $('#aptTitle').textContent = '불러오는 중…';
    $('#aptAddr').textContent = '';
    $('#aptInfo').innerHTML = '';
    mapMsg('');
    try {
      const d = await K.api(`/api/apt?sgg=${encodeURIComponent(sgg)}&id=${encodeURIComponent(id)}`);
      if (!A.open) return;
      A.data = d; A.showAll = false;
      A.band = d.trades.some((t) => t.band === band) ? band : '전체';
      renderApt();
      if (!d.geo) mapMsg(d.mapKey ? '이 단지의 위치를 찾지 못했어요.' : '서버에 티맵 키(TMAP_APP_KEY)를 넣으면 지도에 위치가 표시돼요.');
      else await MapView.show($('#aptMap'), d.geo.lat, d.geo.lon, `${d.apt.name}`).catch((e) => mapMsg(e.message));
    } catch (e) {
      $('#aptTitle').textContent = '단지 정보';
      $('#aptInfo').innerHTML = `<p class="empty-card">${esc(e.message)}</p>`;
    }
  }
  function closeApt(fromPop) {
    if (!A.open) return;
    A.open = false;
    $('#aptSheet').hidden = true;
    document.body.style.overflow = '';
    if (A.chart) { A.chart.dispose(); A.chart = null; }
    if (!fromPop) history.back();
  }
  window.addEventListener('popstate', () => { if (A.open) closeApt(true); }); // 폰 뒤로 가기 = 닫기
  $('#aptClose').addEventListener('click', () => closeApt());
  $('#aptSheet').addEventListener('click', (e) => { if (e.target.id === 'aptSheet') closeApt(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && A.open) closeApt(); });

  const ymd = (t) => `${t.ym.slice(2, 4)}.${t.ym.slice(4)}${t.day ? `.${String(t.day).padStart(2, '0')}` : ''}`;
  function renderApt() {
    const d = A.data, a = d.apt, year = new Date().getFullYear();
    $('#aptTitle').textContent = `${a.umd} ${a.name}`;
    $('#aptAddr').textContent = [a.address, a.built ? `${a.built}년 준공 · ${year - a.built + 1}년차` : '', d.demo ? '데모 위치 (실제 위치 아님)' : '']
      .filter(Boolean).join(' · ');
    const bands = ['전체', ...S.data.meta.bands.filter((b) => d.trades.some((t) => t.band === b))];
    const list = d.trades.filter((t) => A.band === '전체' || t.band === A.band);
    const now = new Date();
    const cut = `${now.getFullYear() - 1}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const y1 = list.filter((t) => t.ym >= cut);
    const last = list[0];
    const max1 = y1.reduce((m, t) => (!m || t.price > m.price ? t : m), null);
    const n = A.showAll ? list.length : Math.min(30, list.length);
    $('#aptInfo').innerHTML = `
      <div class="band-chips" role="group" aria-label="평형대">${bands.map((b) => `<button data-band="${esc(b)}" aria-pressed="${b === A.band}">${b}</button>`).join('')}</div>
      <div class="apt-summary">
        <div><small>최근 실거래</small><b>${last ? fmtEok(last.price) : '-'}</b><small>${last ? `${ymd(last)} · ${last.floor ?? '-'}층` : ''}</small>${last ? `<small>${tradeBadges(last)}</small>` : ''}</div>
        <div><small>최근 1년 최고</small><b>${max1 ? fmtEok(max1.price) : '-'}</b><small>${max1 ? ymd(max1) : '거래 없음'}</small></div>
        <div><small>최근 1년 거래</small><b>${y1.length}건</b><small>전체 ${list.length}건</small></div>
      </div>
      <div id="aptChart" class="chart small" role="img" aria-label="실거래가 추이"></div>
      <table class="trades">
        <thead><tr><th>계약일</th><th>전용면적</th><th class="num">층</th><th class="num">거래금액</th></tr></thead>
        <tbody>${list.slice(0, n).map((t) => `<tr><td>${ymd(t)}</td><td>${t.area}㎡ <span class="meta">${t.band}</span></td><td class="num">${t.floor ?? '-'}</td><td class="num"><b>${fmtEok(t.price)}</b><div class="badges">${tradeBadges(t)}</div></td></tr>`).join('')}</tbody>
      </table>
      ${list.length > n ? `<button class="more" data-apt-more>${list.length - n}건 더 보기</button>` : ''}
      ${d.total > d.trades.length ? `<p class="note">최근 ${d.trades.length}건까지만 보여요.</p>` : ''}
      <p class="note">${d.trades.some((t) => t.direct) ? '차트의 빈 점은 직거래예요. ' : ''}등기는 소유권 이전 등기까지 마친 거래예요. 자료: 국토교통부 아파트 매매 실거래가 (해제된 거래 제외)</p>
      ${d.trades.some((t) => !t.known) ? '<p class="note">등기·직거래 표시는 다시 받은 거래부터 보여요 (며칠 안에 모두 채워져요).</p>' : ''}`;
    drawAptChart(list);
  }
  function drawAptChart(list) {
    if (A.chart) { A.chart.dispose(); A.chart = null; }
    const el = $('#aptChart');
    if (!el || !list.length || !window.echarts) return;
    const COLORS = { '20평대 이하': '#8b5cf6', '20평대': '#31a26a', '30평대': '#3182f6', '40평대 이상': '#e8704a' };
    const groups = {};
    for (const t of list) (groups[t.band] = groups[t.band] || []).push(t);
    A.chart = echarts.init(el);
    A.chart.setOption({
      grid: { left: 44, right: 10, top: 28, bottom: 26 },
      legend: { top: 0, left: 0, itemWidth: 10, itemHeight: 10, textStyle: { color: css('--sub'), fontSize: 12 } },
      tooltip: { trigger: 'item', formatter: (p) => { const t = p.data.t; return `${ymd(t)} · 전용 ${t.area}㎡ · ${t.floor ?? '-'}층<br><b>${fmtEok(t.price)}</b>${t.direct ? ' · 직거래' : ''}${t.rgst ? ` · 등기 ${esc(t.rgst)}` : ''}`; } },
      xAxis: { type: 'time', axisLabel: { color: css('--faint'), fontSize: 11 }, axisLine: { lineStyle: { color: css('--line') } }, splitLine: { show: false } },
      yAxis: { type: 'value', scale: true, axisLabel: { color: css('--faint'), fontSize: 11, formatter: (v) => `${v}억` }, splitLine: { lineStyle: { color: css('--line') } } },
      series: Object.entries(groups).map(([band, ts]) => ({
        name: band, type: 'scatter', symbolSize: 7, itemStyle: { color: COLORS[band] || '#3182f6', opacity: 0.85 },
        data: ts.map((t) => ({
          value: [new Date(+t.ym.slice(0, 4), +t.ym.slice(4) - 1, t.day || 15), Math.round(t.price / 100) / 100], t,
          ...(t.direct ? { itemStyle: { color: 'transparent', borderColor: COLORS[band] || '#3182f6', borderWidth: 1.5 } } : {}),
        })),
      })),
    });
  }
  $('#aptInfo').addEventListener('click', (e) => {
    const b = e.target.closest('[data-band]');
    if (b) { A.band = b.dataset.band; A.showAll = false; return renderApt(); }
    if (e.target.closest('[data-apt-more]')) { A.showAll = true; renderApt(); }
  });

  // ── 클릭 위임 ──
  $('#main').addEventListener('keydown', (e) => {
    const ap = e.target.closest && e.target.closest('li[data-apt]');
    if (ap && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openApt(ap.dataset.sgg, ap.dataset.apt, S.data.band); }
  });
  $('#main').addEventListener('click', (e) => {
    const ap = e.target.closest('li[data-apt]');
    if (ap) return openApt(ap.dataset.sgg, ap.dataset.apt, S.data.band);
    const more = e.target.closest('[data-more]');
    if (more) {
      S.showAll[more.dataset.more] = true;
      if (more.dataset.more === 'apts') $('#aptCard').outerHTML = aptCard();
      else { const card = more.closest('.card'); card.outerHTML = childCard(); drawChildTreemap(); }
      return;
    }
    const link = e.target.closest('li.link[data-code]');
    if (link) return go(link.dataset.code);
    const ind = e.target.closest('li[data-ind]');
    if (ind) { const det = ind.querySelector('.detail'); det.hidden = !det.hidden; }
  });
  $('#main').addEventListener('change', (e) => { if (e.target.id === 'bandSel') loadApts(e.target.value).catch((err) => K.toast(err.message)); });
  window.addEventListener('resize', () => { charts.forEach((c) => c.resize()); if (A.chart) A.chart.resize(); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => S.data && render());

  // ── 시작 ──
  favs.load();
  K.api('/api/regions').then((d) => { S.regions = d.regions; }).catch(() => {});
  load(codeFromHash());
})();
