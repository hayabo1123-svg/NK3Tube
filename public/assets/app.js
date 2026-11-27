// NK3Tube 画面ロジック（ページごとに data-page で振り分け）
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const api = p => fetch('/api/nk3/' + p).then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); return j; });
  const cfg = () => { try { return { autoplay: true, quality: 'auto', theme: 'dark', ...JSON.parse(localStorage.getItem('nk3_cfg') || '{}') }; } catch (e) { return { autoplay: true, quality: 'auto', theme: 'dark' }; } };
  const setCfg = o => localStorage.setItem('nk3_cfg', JSON.stringify({ ...cfg(), ...o }));
  const list = k => { try { return JSON.parse(localStorage.getItem('nk3_' + k)) || []; } catch (e) { return []; } };
  const saveList = (k, v) => localStorage.setItem('nk3_' + k, JSON.stringify(v));
  const thumb = id => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
  const fmtN = n => { n = +n || 0; return n >= 1e8 ? (n / 1e8).toFixed(1) + '億' : n >= 1e4 ? (n / 1e4).toFixed(1) + '万' : n.toLocaleString('ja-JP'); };
  const loading = () => '<p class="empty">読み込み中…</p>';
  const applyTheme = () => { document.documentElement.dataset.theme = cfg().theme; };
  const svgPath = d => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;

  // 共通パーツ: 動画カード / 横並びの一覧
  const card = v => `<a class="card" href="/watch?v=${v.videoId}">
    <div class="th"><img loading="lazy" src="${thumb(v.videoId)}" alt="">${v.lengthText ? `<span class="len">${esc(v.lengthText)}</span>` : ''}</div>
    <div class="ci"><div class="ct">${esc(v.title)}</div><div class="cm">${esc(v.author)}</div>
    <div class="cm">${[v.viewsText, v.publishedText].filter(Boolean).map(esc).join(' ・ ')}</div></div></a>`;
  const row = v => `<a class="rowi" href="/watch?v=${v.videoId}"><div class="th"><img loading="lazy" src="${thumb(v.videoId)}" alt="">${v.lengthText ? `<span class="len">${esc(v.lengthText)}</span>` : ''}</div>
    <div class="rci"><div class="ct">${esc(v.title)}</div><div class="cm">${[v.viewsText, v.publishedText].filter(Boolean).map(esc).join(' ・ ')}</div>
    <div class="cm">${esc(v.author)}</div></div></a>`;
  const chRow = c => `<a class="rowi chr" href="/channel?c=${c.channelId}"><img src="${esc(c.avatar)}" alt="">
    <div class="rci"><div class="ct">${esc(c.title)}</div><div class="cm">${[c.handle, c.subscribersText].filter(Boolean).map(esc).join(' ・ ')}</div>
    <div class="cm">${esc(c.description)}</div></div></a>`;

  // ヘッダーとサイドバーを共通で描画
  const NAV = [['/home', 'home', 'ホーム'], ['/shorts', 'shorts', 'ショート'], ['/subs', 'subs', '登録'], ['/history', 'hist', '履歴'], ['/settings', 'set', '設定']];
  const ICON = {
    home: 'M12 3l9 8h-3v9h-5v-6h-2v6H6v-9H3z', shorts: 'M10 15.5v-7l6 3.5zM4 6h2v12H4zm14 0h2v12h-2z',
    subs: 'M4 6h16v12H4z', hist: 'M12 4a8 8 0 110 16 8 8 0 010-16zm-1 3v5l4 2.4.8-1.3-3.3-2V7z',
    set: 'M19.4 13a7.5 7.5 0 000-2l2.1-1.6-2-3.5-2.5 1a7 7 0 00-1.7-1L15 3h-4l-.4 2.6a7 7 0 00-1.7 1l-2.5-1-2 3.5L6.6 11a7.5 7.5 0 000 2l-2.1 1.6 2 3.5 2.5-1a7 7 0 001.7 1L11 21h4l.4-2.6a7 7 0 001.7-1l2.5 1 2-3.5zM12 15.5a3.5 3.5 0 110-7 3.5 3.5 0 010 7z',
  };
  function shell() {
    const q = new URLSearchParams(location.search).get('search_query') || '';
    document.body.insertAdjacentHTML('afterbegin', `
      <header class="hdr"><a class="logo" href="/home"><i></i>NK3Tube</a>
        <form class="search" action="/results"><input name="search_query" value="${esc(q)}" placeholder="検索" autocomplete="off">
          <button aria-label="検索">${svgPath('M15.5 14h-.8l-.3-.3A6.5 6.5 0 109.5 16a6.5 6.5 0 004.2-1.6l.3.3v.8l5 5 1.5-1.5-5-5zm-6 0a4.5 4.5 0 110-9 4.5 4.5 0 010 9z')}</button></form>
        <a class="av" href="/settings" aria-label="設定">N</a></header>
      <nav class="side">${NAV.map(([h, i, l]) => `<a href="${h}" class="${location.pathname === h ? 'on' : ''}">${svgPath(ICON[i])}<span>${l}</span></a>`).join('')}</nav>`);
  }

  // ===== 各ページ =====
  const pages = {
    async home(m) {
      m.innerHTML = loading();
      const d = await api('home');
      m.innerHTML = `<div class="grid">${d.videos.map(card).join('') || '<p class="empty">動画がありません</p>'}</div>`;
    },

    async results(m) {
      const p = new URLSearchParams(location.search), q = p.get('search_query') || '', type = p.get('type') || '';
      document.title = q ? q + ' - NK3Tube' : 'NK3Tube';
      const tabs = `<div class="tabs">${[['', 'すべて'], ['video', '動画'], ['channel', 'チャンネル']].map(([k, l]) =>
        `<a class="tab ${type === k ? 'on' : ''}" href="/results?search_query=${encodeURIComponent(q)}&type=${k}">${l}</a>`).join('')}</div>`;
      if (!q) { m.innerHTML = '<p class="empty">キーワードを入力してください</p>'; return; }
      m.innerHTML = tabs + loading();
      const d = await api(`search?q=${encodeURIComponent(q)}&type=${type}`);
      const items = d.results.filter(r => r.type !== 'playlist');
      m.innerHTML = tabs + (items.map(r => (r.type === 'channel' ? chRow(r) : row(r))).join('') || '<p class="empty">結果がありません</p>');
    },

    async watch(m) {
      const id = new URLSearchParams(location.search).get('v');
      m.innerHTML = `<div class="watch"><div><div id="player"><div class="ld">読み込み中…</div></div>
        <h1 class="ttl" id="ttl">読み込み中…</h1><div class="owner" id="owner"></div>
        <div class="desc" id="desc"></div><h3 id="cc"></h3><div id="cmts"></div></div>
        <aside id="rel"></aside></div>`;
      if (!id) { $('#ttl').textContent = '動画が指定されていません'; return; }
      const [v, s] = await Promise.all([api('videos/' + id), api('stream/' + id).catch(e => ({ error: e.message }))]);
      document.title = v.title + ' - NK3Tube';
      $('#ttl').textContent = v.title;
      const subbed = () => list('subs').some(x => x.id === v.authorId);
      $('#owner').innerHTML = `<a class="ch" href="/channel?c=${esc(v.authorId)}">${esc(v.author)}</a>
        <button class="pill" id="sub"></button>`;
      const paint = () => { $('#sub').textContent = subbed() ? '登録済み' : '登録'; $('#sub').className = 'pill' + (subbed() ? '' : ' solid'); };
      $('#sub').onclick = () => {
        const s2 = list('subs');
        saveList('subs', subbed() ? s2.filter(x => x.id !== v.authorId) : [...s2, { id: v.authorId, name: v.author }]);
        paint();
      };
      paint();
      $('#desc').innerHTML = `<div class="dm">${fmtN(v.views)}回視聴 ・ ${esc(v.publishedText)}</div><div>${esc(v.description)}</div>`;
      $('#desc').onclick = () => $('#desc').classList.toggle('open');
      const next = v.related.find(r => r.videoId);
      if (s.error) $('#player').innerHTML = `<div class="ld">再生できません：${esc(s.error)}</div>`;
      else NK3Player.mount($('#player'), { id, streams: s.formats, autoplay: cfg().autoplay, next: next ? '/watch?v=' + next.videoId : '' });
      $('#rel').innerHTML = v.related.filter(r => r.videoId).map(r => `<a class="rc" href="/watch?v=${r.videoId}">
        <div class="rth"><img loading="lazy" src="${thumb(r.videoId)}" alt=""><span class="len">${esc(r.lengthText || '')}</span></div>
        <div><div class="ct">${esc(r.title)}</div><div class="cm">${esc(r.author)}</div><div class="cm">${esc(r.viewsText || '')}</div></div></a>`).join('');
      const h = list('history').filter(x => x.videoId !== id);
      h.unshift({ videoId: id, title: v.title, author: v.author });
      if (localStorage.getItem('nk3_nohist') !== '1') saveList('history', h.slice(0, 200));
      api('comments/' + id).then(c => {
        $('#cc').textContent = `コメント ${c.comments.length}件`;
        $('#cmts').innerHTML = c.comments.map(x => `<div class="cmt"><div class="bd"></div><div><b>${esc(x.author)}</b> <span class="cm">${esc(x.publishedText)}</span><div>${esc(x.content)}</div><div class="cm">高評価 ${esc(x.likeCount)}</div></div></div>`).join('');
      }).catch(() => { $('#cc').textContent = 'コメントを取得できません'; });
    },

    async channel(m) {
      const p = new URLSearchParams(location.search), c = p.get('c') || '', tab = p.get('tab') || 'videos';
      m.innerHTML = loading();
      const d = await api(`channels/${encodeURIComponent(c)}?tab=${tab}`);
      document.title = d.title + ' - NK3Tube';
      const subbed = list('subs').some(x => x.id === d.channelId);
      const tabs = [['videos', '動画'], ['shorts', 'ショート'], ['live', 'ライブ'], ['playlists', '再生リスト']];
      m.innerHTML = `${d.banner ? `<img class="banner" src="${esc(d.banner)}" alt="">` : '<div class="banner"></div>'}
        <div class="chead"><img class="cav" src="${esc(d.avatar)}" alt=""><div class="cinfo"><h1>${esc(d.title)}</h1>
        <div class="cm">${[d.handle, d.subscribersText].filter(Boolean).map(esc).join(' ・ ')}</div>
        <div class="cm">${esc((d.description || '').slice(0, 140))}</div>
        <button class="pill ${subbed ? '' : 'solid'}" id="csub">${subbed ? '登録済み' : 'チャンネル登録'}</button></div></div>
        <div class="tabs">${tabs.map(([k, l]) => `<a class="tab ${k === tab ? 'on' : ''}" href="/channel?c=${encodeURIComponent(c)}&tab=${k}">${l}</a>`).join('')}</div>
        <div class="grid ${tab === 'shorts' ? 'sg' : ''}">${d.items.map(card).join('') || '<p class="empty">コンテンツがありません</p>'}</div>`;
      $('#csub').onclick = () => {
        const s = list('subs'), on = s.some(x => x.id === d.channelId);
        saveList('subs', on ? s.filter(x => x.id !== d.channelId) : [...s, { id: d.channelId, name: d.title }]);
        $('#csub').textContent = on ? 'チャンネル登録' : '登録済み';
        $('#csub').className = 'pill' + (on ? ' solid' : '');
      };
    },

    async shorts(m) {
      m.innerHTML = loading();
      const d = await api('shorts');
      m.innerHTML = `<h2>ショート</h2><div class="grid sg">${d.shorts.filter(v => v.videoId).map(card).join('') || '<p class="empty">ショートがありません</p>'}</div>`;
    },

    subs(m) {
      const s = list('subs');
      m.innerHTML = `<h2>登録チャンネル</h2>` + (s.map(c => `<a class="rowi chr" href="/channel?c=${esc(c.id)}"><div class="rci"><div class="ct">${esc(c.name)}</div></div></a>`).join('')
        || '<p class="empty">登録したチャンネルはありません</p>');
    },

    history(m) {
      const h = list('history');
      m.innerHTML = `<h2>履歴</h2>` + (h.map(v => `<a class="rowi" href="/watch?v=${v.videoId}"><div class="th"><img loading="lazy" src="${thumb(v.videoId)}" alt=""></div><div class="rci"><div class="ct">${esc(v.title)}</div><div class="cm">${esc(v.author)}</div></div></a>`).join('')
        || '<p class="empty">履歴はありません</p>') + (h.length ? '<p><button class="pill" id="clr">履歴を消去</button></p>' : '');
      if ($('#clr')) $('#clr').onclick = () => { saveList('history', []); pages.history(m); };
    },

    settings(m) {
      const c = cfg();
      m.innerHTML = `<div class="set"><h1>設定</h1>
        <label>テーマ<select id="th"><option value="dark">ダーク</option><option value="light">ライト</option></select></label>
        <label>自動再生<input type="checkbox" id="ap"></label>
        <label>既定の画質<select id="qu"><option value="auto">自動</option><option value="1080">1080p</option><option value="720">720p</option><option value="480">480p</option><option value="360">360p</option></select></label>
        <label>視聴履歴を記録<input type="checkbox" id="hi"></label></div>`;
      $('#th').value = c.theme; $('#ap').checked = c.autoplay; $('#qu').value = c.quality;
      $('#hi').checked = localStorage.getItem('nk3_nohist') !== '1';
      $('#th').onchange = e => { setCfg({ theme: e.target.value }); applyTheme(); };
      $('#ap').onchange = e => setCfg({ autoplay: e.target.checked });
      $('#qu').onchange = e => setCfg({ quality: e.target.value });
      $('#hi').onchange = e => localStorage.setItem('nk3_nohist', e.target.checked ? '0' : '1');
    },
  };

  function boot() {
    shell();
    applyTheme();
    const main = $('#main');
    const fn = pages[document.body.dataset.page];
    if (!fn) return;
    Promise.resolve().then(() => fn(main)).catch(e => { main.innerHTML = `<p class="empty err">読み込みに失敗しました：${esc(e.message)}</p>`; });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
