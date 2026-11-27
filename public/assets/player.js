// 独自再生UI: 映像と音声を別ストリームで取得した場合は同期して再生する
(() => {
  'use strict';
  const ICON = {
    play: 'M8 5v14l11-7z', pause: 'M6 19h4V5H6zm8-14v14h4V5h-4z', next: 'M6 18l8.5-6L6 6zM16 6h2v12h-2z',
    vol: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0014 8v8a4.5 4.5 0 002.5-4zM14 3.2v2.1a7 7 0 010 13.4v2.1a9 9 0 000-17.6z',
    mute: 'M16.5 12A4.5 4.5 0 0014 8v2.2l2.5 2.5zM4.3 3L3 4.3 7.7 9H3v6h4l5 5v-6.7l4.2 4.2c-.7.5-1.4.9-2.2 1.1v2.1a9 9 0 004-1.9l2 2L21 19.7 4.3 3z',
    theater: 'M19 6H5a2 2 0 00-2 2v8a2 2 0 002 2h14a2 2 0 002-2V8a2 2 0 00-2-2zm0 10H5V8h14z',
    mini: 'M19 7h-8v6h8zm2-4H3a2 2 0 00-2 2v14a2 2 0 002 2h18a2 2 0 002-2V5a2 2 0 00-2-2zm0 16H3V5h18z',
    full: 'M7 14H5v5h5v-2H7zm-2-4h2V7h3V5H5zm12 7h-3v2h5v-5h-2zM14 5v2h3v3h2V5z',
  };
  const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
  const svg = d => `<svg viewBox="0 0 24 24"><path d="${d}"/></svg>`;
  const fmt = s => {
    s = Math.max(0, Math.floor(s || 0));
    const h = (s / 3600) | 0, m = ((s % 3600) / 60) | 0, x = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
  };

  // 画質の候補: 音声込みはそのまま、映像のみは最良の音声と組にする（高画質）
  function build(F) {
    const muxed = F.filter(f => f.hasVideo && f.hasAudio);
    const vid = F.filter(f => f.hasVideo && !f.hasAudio);
    const aud = F.filter(f => f.hasAudio && !f.hasVideo).sort((x, y) => (y.ext === 'm4a') - (x.ext === 'm4a') || y.bitrate - x.bitrate);
    const hs = [...new Set(F.filter(f => f.hasVideo).map(f => f.height))].sort((a, b) => b - a);
    const out = [];
    hs.forEach(h => {
      const vv = vid.find(f => f.height === h && f.ext === 'mp4') || vid.find(f => f.height === h);
      const m = muxed.find(f => f.height === h);
      if (vv && aud[0]) out.push({ label: h + 'p', h, itag: vv.itag, audio: aud[0].itag, adaptive: true });
      else if (m) out.push({ label: h + 'p', h, itag: m.itag, adaptive: false });
    });
    return out;
  }

  function mount(box, o) {
    let pref = {};
    try { pref = JSON.parse(localStorage.getItem('nk3_cfg')) || {}; } catch (e) { }
    const list = build(o.streams || []);
    if (!list.length) { box.innerHTML = '<div class="ld">再生できる形式がありません</div>'; return; }
    box.classList.add('nkp');
    box.innerHTML = `<video playsinline></video><audio preload="auto"></audio>
      <div class="bigp"></div>
      <div class="pctl">
        <div class="prog"><div class="buf"></div><div class="pl"></div><span class="knob"></span></div>
        <div class="row">
          <button data-a="play" aria-label="再生">${svg(ICON.play)}</button>
          <button data-a="next" aria-label="次の動画">${svg(ICON.next)}</button>
          <div class="vol"><button data-a="mute" aria-label="ミュート">${svg(ICON.vol)}</button><input type="range" min="0" max="1" step="0.05" value="1"></div>
          <span class="time">0:00 / 0:00</span><span class="sp"></span>
          <button data-a="speed" class="txt">1x</button>
          <button data-a="qual" class="txt">自動</button>
          <button data-a="theater" aria-label="シアター">${svg(ICON.theater)}</button>
          <button data-a="mini" aria-label="ミニプレーヤー">${svg(ICON.mini)}</button>
          <button data-a="full" aria-label="全画面">${svg(ICON.full)}</button>
        </div>
      </div>
      <div class="menu" hidden></div>`;
    const v = box.querySelector('video'), a = box.querySelector('audio');
    const $ = s => box.querySelector(s);
    const menu = $('.menu'), bigp = $('.bigp'), prog = $('.prog');
    let muted = !!pref.mute, cur = null;

    // 初期画質: 設定があればそれ、無ければ720p以下の最高画質
    let idx = Math.max(0, list.findIndex(s => s.h <= 720));
    if (pref.quality && pref.quality !== 'auto') {
      const k = list.findIndex(s => String(s.h) === pref.quality);
      if (k >= 0) idx = k;
    }
    const url = t => `/api/nk3/play/${o.id}?itag=${t}`;
    const setVol = () => {
      const val = +$('.vol input').value;
      v.volume = a.volume = val;
      v.muted = a.muted = muted || val === 0;
      $('[data-a=mute]').innerHTML = svg(v.muted ? ICON.mute : ICON.vol);
    };
    const flash = ic => { bigp.innerHTML = svg(ic); bigp.style.display = 'grid'; clearTimeout(bigp._t); bigp._t = setTimeout(() => (bigp.style.display = 'none'), 600); };
    const load = (i, keepPlaying) => {
      const t = v.currentTime || 0;
      cur = list[i];
      $('[data-a=qual]').textContent = cur.label;
      v.src = url(cur.itag);
      if (cur.adaptive) a.src = url(cur.audio);
      else { a.removeAttribute('src'); a.load(); }
      v.addEventListener('loadedmetadata', () => {
        if (t) { v.currentTime = t; a.currentTime = t; }
        if (keepPlaying) v.play().catch(() => { });
      }, { once: true });
      idx = i;
    };
    const toggle = () => (v.paused ? v.play().catch(() => { }) : v.pause());

    // 映像と音声の同期（音声付きの映像は a を使わない）
    setInterval(() => {
      if (!cur || !cur.adaptive || v.paused) return;
      if (Math.abs(v.currentTime - a.currentTime) > 0.3) a.currentTime = v.currentTime;
      if (a.playbackRate !== v.playbackRate) a.playbackRate = v.playbackRate;
    }, 250);
    v.addEventListener('play', () => { $('[data-a=play]').innerHTML = svg(ICON.pause); flash(ICON.play); if (cur && cur.adaptive) a.play().catch(() => { }); });
    v.addEventListener('pause', () => { $('[data-a=play]').innerHTML = svg(ICON.play); flash(ICON.pause); a.pause(); });
    v.addEventListener('playing', () => { if (cur && cur.adaptive) a.play().catch(() => { }); });
    v.addEventListener('waiting', () => a.pause());
    v.addEventListener('seeking', () => { a.currentTime = v.currentTime; });
    v.addEventListener('ratechange', () => { a.playbackRate = v.playbackRate; });
    v.addEventListener('timeupdate', () => {
      const d = v.duration || 0, p = d ? (v.currentTime / d) * 100 : 0;
      $('.pl').style.width = p + '%';
      $('.knob').style.left = p + '%';
      const b = v.buffered;
      if (b.length && d) $('.buf').style.width = (b.end(b.length - 1) / d) * 100 + '%';
      $('.time').textContent = fmt(v.currentTime) + ' / ' + fmt(d);
    });
    v.addEventListener('ended', () => { if (o.autoplay && o.next) location.href = o.next; });
    v.addEventListener('click', toggle);

    // シークバー（ドラッグ対応）
    let drag = false;
    const seek = e => {
      const r = prog.getBoundingClientRect();
      const t = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * (v.duration || 0);
      if (isFinite(t)) { v.currentTime = t; a.currentTime = t; }
    };
    prog.addEventListener('pointerdown', e => { drag = true; prog.setPointerCapture(e.pointerId); seek(e); });
    prog.addEventListener('pointermove', e => drag && seek(e));
    prog.addEventListener('pointerup', () => (drag = false));

    // ボタン類
    $('[data-a=play]').onclick = toggle;
    $('[data-a=next]').onclick = () => { if (o.next) location.href = o.next; };
    $('.vol input').addEventListener('input', e => { muted = false; setVol(); });
    $('[data-a=mute]').onclick = () => { muted = !muted; setVol(); };
    $('[data-a=theater]').onclick = () => document.body.classList.toggle('theater');
    $('[data-a=mini]').onclick = () => v.requestPictureInPicture && v.requestPictureInPicture().catch(() => { });
    $('[data-a=full]').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : box.requestFullscreen().catch(() => { }));
    const openMenu = (html, pick) => {
      menu.innerHTML = html;
      menu.hidden = false;
      menu.onclick = e => {
        const b = e.target.closest('button[data-v]');
        if (!b) return;
        menu.hidden = true;
        pick(b.dataset.v);
      };
    };
    $('[data-a=speed]').onclick = e => {
      e.stopPropagation();
      openMenu(RATES.map(r => `<button data-v="${r}" class="${r === v.playbackRate ? 'on' : ''}">${r === 1 ? '標準' : r + 'x'}</button>`).join(''), x => {
        v.playbackRate = a.playbackRate = +x;
        $('[data-a=speed]').textContent = (+x === 1 ? '1' : x) + 'x';
      });
    };
    $('[data-a=qual]').onclick = e => {
      e.stopPropagation();
      openMenu(list.map((s, i) => `<button data-v="${i}" class="${i === idx ? 'on' : ''}">${s.label}${s.adaptive ? ' 高画質' : ''}</button>`).join(''),
        x => load(+x, !v.paused));
    };
    document.addEventListener('click', () => (menu.hidden = true));

    // 操作バーは一定時間の操作がないと隠れる
    let hideT;
    const wake = () => {
      box.classList.remove('idle');
      clearTimeout(hideT);
      hideT = setTimeout(() => { if (!v.paused) box.classList.add('idle'); }, 2500);
    };
    box.addEventListener('mousemove', wake);
    box.addEventListener('pointerdown', wake);

    // キーボード操作
    document.addEventListener('keydown', e => {
      if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      const k = e.key.toLowerCase();
      if (k === ' ' || k === 'k') { e.preventDefault(); toggle(); }
      else if (k === 'arrowright' || k === 'l') v.currentTime += 5;
      else if (k === 'arrowleft' || k === 'j') v.currentTime -= 5;
      else if (k === 'arrowup' || k === 'arrowdown') {
        e.preventDefault();
        const r = $('.vol input');
        r.value = Math.min(1, Math.max(0, +r.value + (k === 'arrowup' ? 0.1 : -0.1)));
        muted = false;
        setVol();
      }
      else if (k === 'm') { muted = !muted; setVol(); }
      else if (k === 'f') (document.fullscreenElement ? document.exitFullscreen() : box.requestFullscreen());
      else if (k === 't') document.body.classList.toggle('theater');
    });

    load(idx, !!o.autoplay);
    setVol();
  }

  window.NK3Player = { mount, build };
})();
