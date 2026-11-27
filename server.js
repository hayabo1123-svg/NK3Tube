'use strict';
// NK3Tube server: 画面は /home などのきれいなURLで配信し、データは /api/nk3/* から取得する
const http = require('http');
const fs = require('fs');
const path = require('path');
const yt = require('./youtube');

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');
// ルート → 表示する HTML
const PAGES = {
  '/': 'index.html', '/home': 'pages/home.html', '/watch': 'pages/watch.html', '/results': 'pages/results.html',
  '/channel': 'pages/channel.html', '/shorts': 'pages/shorts.html', '/subs': 'pages/subs.html',
  '/history': 'pages/history.html', '/settings': 'pages/settings.html',
};
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function sendFile(res, rel) {
  const f = path.normalize(path.join(PUB, rel));
  if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return false;
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
  return true;
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

async function api(route, u, req, res) {
  const [name, id] = route.split('/');
  const more = Math.min(5, parseInt(u.searchParams.get('more') || '0', 10) || 0);
  switch (name) {
    case 'home': return sendJson(res, 200, await yt.home());
    case 'search': return sendJson(res, 200, await yt.search(u.searchParams.get('q') || '', more, u.searchParams.get('type') || ''));
    case 'videos': return sendJson(res, 200, await yt.video(id));
    case 'stream': return sendJson(res, 200, await yt.stream(id));
    case 'play': return yt.play(req, res, id, u.searchParams); // 映像/音声を中継（Range対応・dl=1で保存）
    case 'comments': return sendJson(res, 200, await yt.comments(id));
    case 'shorts': return sendJson(res, 200, await yt.shorts(more));
    case 'channels': return sendJson(res, 200, await yt.channel(decodeURIComponent(id || ''), u.searchParams.get('tab') || 'videos', more));
    default: throw Object.assign(new Error('not found'), { status: 404 });
  }
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname.replace(/\/+$/, '') || '/';
  try {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
    if (p.startsWith('/api/nk3/')) return await api(p.slice('/api/nk3/'.length), u, req, res);
    if (p.startsWith('/assets/') && sendFile(res, p.slice(1))) return;
    if (PAGES[p] && sendFile(res, PAGES[p])) return;
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  } catch (e) {
    if (res.headersSent) return res.destroy();
    sendJson(res, e.status || 502, { error: String(e.message || e) });
  }
}).listen(PORT, () => console.log(`NK3Tube listening on :${PORT}`));
