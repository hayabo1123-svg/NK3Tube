// NK3Tube server
//  - api.worker.js (YouTube Innertube 取得ロジック) を Node 単体で動くよう移植
//  - nkdlp (worker.js) の stream 抽出ロジックを内蔵: yt-dlp バックエンド → Innertube(ANDROID) の順
//  - /api/v1/play/:id で動画を中継再生 (Range対応) / dl=1 でダウンロード
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const PORT = process.env.PORT || 3000;
const YTDLP = (process.env.YTDLP_BACKEND || '').replace(/\/$/, ''); // nkdlp backend/server.py のURL (任意)
const YTDLP_TOKEN = process.env.YTDLP_BACKEND_TOKEN || '';
const PUB = path.join(__dirname, 'public');
const YT = 'https://www.youtube.com/youtubei/v1';
const UA_WEB = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
const WEB = {
  ctx: { client: { clientName: 'WEB', clientVersion: '2.20250101.00.00', hl: 'ja', gl: 'JP' } },
  headers: { 'X-YouTube-Client-Name': '1', 'X-YouTube-Client-Version': '2.20250101.00.00' },
  ua: UA_WEB,
};
const ANDROID = {
  ctx: { client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30, osName: 'Android', osVersion: '11', hl: 'ja', gl: 'JP' } },
  headers: { 'X-YouTube-Client-Name': '3', 'X-YouTube-Client-Version': '20.10.38' },
  ua: 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip',
};
const TAB = {
  videos: 'EgZ2aWRlb3PyBgQKAjoA',
  shorts: 'EgZzaG9ydHPyBgUKA5oBAA==',
  live: 'EgdzdHJlYW1z8gYECgJ6AA==',
  playlists: 'EglwbGF5bGlzdHPyBgQKAkIA',
};
const KIND_TYPE = { videos: ['video'], shorts: ['short'], live: ['video'], playlists: ['playlist'] };
const SEARCH_PARAM = { video: 'EgIQAQ==', channel: 'EgIQAg==', playlist: 'EgIQAw==' };
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

// ===== 小さなキャッシュ (不完全な結果は保存しない) =====
const cache = new Map();
async function cached(key, ttl, fn, ok = () => true) {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.v;
  const v = await fn();
  if (ok(v)) {
    if (cache.size > 500) cache.clear();
    cache.set(key, { v, exp: Date.now() + ttl * 1000 });
  }
  return v;
}

const httpErr = (status, message) => Object.assign(new Error(message), { status });

// ===== YouTube 呼び出し (再試行つき) =====
async function yt(ep, body, client = WEB) {
  let err;
  for (let i = 0; i < 2; i++) {
    if (i) await new Promise((r) => setTimeout(r, 300));
    try {
      const r = await fetch(`${YT}/${ep}?prettyPrint=false`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': client.ua, ...client.headers },
        body: JSON.stringify({ context: client.ctx, ...body }),
        signal: AbortSignal.timeout(6000),
      });
      if (r.ok) return await r.json();
      err = new Error(`YouTube ${ep} HTTP ${r.status}`);
      if (r.status !== 429 && r.status < 500) break;
    } catch (e) { err = e; }
  }
  throw err;
}

// ===== パース共通 =====
const text = (t) => t?.simpleText ?? t?.runs?.map((r) => r.text).join('') ?? t?.content ?? '';
const fixUrls = (arr) => (arr ?? []).map((t) => ({ ...t, url: t.url?.startsWith('//') ? 'https:' + t.url : t.url }));
const nextTok = (d) => collect(d, ['continuationCommand']).continuationCommand.map((c) => c.token).find(Boolean);

function collect(root, keys) {
  const out = {};
  keys.forEach((k) => (out[k] = []));
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    for (const k in o) {
      if (Object.hasOwn(out, k)) out[k].push(o[k]);
      walk(o[k]);
    }
  };
  walk(root);
  return out;
}

const KEYS = ['lockupViewModel', 'videoRenderer', 'gridVideoRenderer', 'compactVideoRenderer', 'playlistRenderer',
  'gridPlaylistRenderer', 'channelRenderer', 'reelItemRenderer', 'shortsLockupViewModel'];

function mapVideo(v) {
  const o = v.ownerText || v.shortBylineText || v.longBylineText;
  return {
    type: 'video', videoId: v.videoId, title: text(v.title), author: text(o),
    authorId: o?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId,
    lengthText: text(v.lengthText), viewCountText: text(v.viewCountText), publishedText: text(v.publishedTimeText),
  };
}

function mapLockupVideo(v) {
  const m = v.metadata?.lockupMetadataViewModel ?? {};
  const parts = (m.metadata?.contentMetadataViewModel?.metadataRows ?? []).flatMap((r) => r.metadataParts ?? [])
    .map((p) => p.text?.content).filter(Boolean);
  const avatar = m.image?.decoratedAvatarViewModel;
  return {
    type: 'video',
    videoId: v.contentId ?? v.rendererContext?.commandContext?.onTap?.innertubeCommand?.watchEndpoint?.videoId,
    title: m.title?.content,
    author: avatar?.a11yLabel?.replace(/^チャンネル「|」に移動します$/g, '') || parts[0],
    authorId: avatar?.rendererContext?.commandContext?.onTap?.innertubeCommand?.browseEndpoint?.browseId,
    lengthText: collect(v, ['thumbnailBadgeViewModel']).thumbnailBadgeViewModel.map((b) => b.text).find((t) => /^\d+:\d+/.test(t || '')),
    viewCountText: parts.find((p) => /回視聴|views/i.test(p)),
    publishedText: parts.find((p) => /前$/.test(p)),
  };
}

function mapShort(s) {
  return { type: 'short', videoId: s.videoId, title: text(s.headline), viewCountText: text(s.viewCountText) };
}

function mapShortLockup(s) {
  return {
    type: 'short',
    videoId: s.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId ?? s.entityId?.replace('shorts-shelf-item-', ''),
    title: s.overlayMetadata?.primaryText?.content ?? s.accessibilityText,
    viewCountText: s.overlayMetadata?.secondaryText?.content,
  };
}

function mapChannel(c) {
  const a = text(c.subscriberCountText), b = text(c.videoCountText);
  return {
    type: 'channel', channelId: c.channelId, title: text(c.title),
    handle: [a, b].find((t) => t.startsWith('@')),
    subscriberText: [b, a].find((t) => t && !t.startsWith('@')),
    description: text(c.descriptionSnippet),
    thumbnails: fixUrls(c.thumbnail?.thumbnails),
  };
}

function mapPlaylist(p) {
  return {
    type: 'playlist', playlistId: p.playlistId, title: text(p.title),
    videoCount: text(p.videoCountText || p.videoCountShortText),
    thumbnails: fixUrls(p.thumbnails?.[0]?.thumbnails ?? p.thumbnail?.thumbnails),
  };
}

function mapLockupPlaylist(v) {
  const m = v.metadata?.lockupMetadataViewModel ?? {};
  const th = v.contentImage?.collectionThumbnailViewModel?.primaryThumbnail?.thumbnailViewModel ?? {};
  return {
    type: 'playlist', playlistId: v.contentId, title: m.title?.content,
    videoCount: collect(th, ['thumbnailBadgeViewModel']).thumbnailBadgeViewModel.map((b) => b.text).find(Boolean),
    thumbnails: fixUrls(th.image?.sources),
  };
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((r) => {
    const id = r.videoId || r.channelId || r.playlistId;
    if (!id) return false;
    const k = r.type + id;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// 検索・ホーム・チャンネルタブ共通の全件パーサー
function parseAll(data) {
  const c = collect(data, KEYS);
  return dedupe([
    ...c.lockupViewModel.filter((l) => !l.contentType || l.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO').map(mapLockupVideo),
    ...c.lockupViewModel.filter((l) => l.contentType === 'LOCKUP_CONTENT_TYPE_PLAYLIST').map(mapLockupPlaylist),
    ...c.videoRenderer.concat(c.gridVideoRenderer, c.compactVideoRenderer).map(mapVideo),
    ...c.playlistRenderer.concat(c.gridPlaylistRenderer).map(mapPlaylist),
    ...c.channelRenderer.map(mapChannel),
    ...c.reelItemRenderer.map(mapShort),
    ...c.shortsLockupViewModel.map(mapShortLockup),
  ]);
}

async function paginate(ep, body, more) {
  let data = await yt(ep, body);
  const items = parseAll(data);
  let token = nextTok(data);
  for (let p = 0; p < more && token; p++) {
    data = await yt(ep, { continuation: token });
    items.push(...parseAll(data));
    token = nextTok(data);
  }
  return { items: dedupe(items), hasMore: !!token };
}

// ===== nkdlp: 動画の配信情報 (stream) 抽出 =====
async function getPlayer(id) {
  const a = await yt('player', { videoId: id }, ANDROID).catch(() => null);
  if (a?.streamingData) return a;
  const w = await yt('player', { videoId: id }, WEB).catch(() => null);
  if (!a && !w) throw new Error('player request failed');
  return w ?? a;
}

function normFormats(sd) {
  return [...(sd?.formats ?? []), ...(sd?.adaptiveFormats ?? [])].filter((f) => f.url).map((f) => {
    const mime = f.mimeType || '';
    return {
      itag: String(f.itag), url: f.url, mime,
      ext: /webm/.test(mime) ? 'webm' : /mp4/.test(mime) ? (mime.startsWith('audio') ? 'm4a' : 'mp4') : '',
      height: f.height || 0, fps: f.fps || 0, bitrate: f.bitrate || 0,
      hasVideo: mime.startsWith('video/'),
      hasAudio: mime.startsWith('audio/') || /mp4a|opus|vorbis/.test(mime),
      contentLength: Number(f.contentLength) || 0,
    };
  });
}

async function viaYtdlp(id) {
  const r = await fetch(`${YTDLP}/extract?id=${id}`, {
    headers: YTDLP_TOKEN ? { authorization: `Bearer ${YTDLP_TOKEN}` } : {},
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`ytdlp backend HTTP ${r.status}`);
  const info = await r.json();
  return {
    id, title: info.title, author: info.uploader || info.channel, duration: info.duration || 0,
    formats: (info.formats || []).filter((f) => f.url && f.protocol !== 'mhtml').map((f) => {
      const v = !!f.vcodec && f.vcodec !== 'none', a = !!f.acodec && f.acodec !== 'none';
      return {
        itag: String(f.format_id), url: f.url, mime: `${v ? 'video' : 'audio'}/${f.ext || 'mp4'}`, ext: f.ext || 'mp4',
        height: f.height || 0, fps: f.fps || 0, bitrate: Math.round((f.tbr || 0) * 1000),
        hasVideo: v, hasAudio: a, contentLength: f.filesize || f.filesize_approx || 0,
      };
    }),
  };
}

const validId = (id) => /^[\w-]{11}$/.test(id || '');

function getStream(id) {
  if (!validId(id)) throw httpErr(400, 'invalid videoId');
  return cached('st:' + id, 300, async () => {
    if (YTDLP) {
      try { return await viaYtdlp(id); } catch (e) { console.warn('yt-dlp backend failed:', e.message); }
    }
    const p = await getPlayer(id);
    const d = p.videoDetails ?? {};
    if (!p.streamingData) {
      throw httpErr(502, `no streaming data: ${p.playabilityStatus?.status ?? '?'} ${p.playabilityStatus?.reason ?? ''}`.trim());
    }
    return { id, title: d.title, author: d.author, authorId: d.channelId, duration: +d.lengthSeconds || 0, formats: normFormats(p.streamingData), provider: 'innertube' };
  }, (v) => v.formats.length > 0);
}

const bestMuxed = (fs) =>
  fs.filter((f) => f.hasVideo && f.hasAudio).sort((a, b) => b.height - a.height)[0] ??
  fs.filter((f) => f.hasVideo).sort((a, b) => b.height - a.height)[0];

// 動画を中継再生 / ダウンロード (Range 対応)
async function play(req, res, id, u) {
  const s = await getStream(id);
  const itag = u.searchParams.get('itag');
  const dl = u.searchParams.get('dl') === '1';
  const f = itag ? s.formats.find((x) => x.itag === itag) : bestMuxed(s.formats);
  if (!f) throw httpErr(404, 'format not found');
  const h = { 'user-agent': ANDROID.ua };
  if (req.headers.range) h.range = req.headers.range;
  const up = await fetch(f.url, { headers: h });
  if (!up.ok && up.status !== 206) throw httpErr(502, `upstream HTTP ${up.status}`);
  const hdr = { 'Content-Type': f.mime.split(';')[0] || 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  for (const k of ['content-length', 'content-range']) if (up.headers.get(k)) hdr[k] = up.headers.get(k);
  if (dl) {
    const name = `${(s.title || id).replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 120)}.${f.ext || 'mp4'}`;
    hdr['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
  }
  res.writeHead(up.status, hdr);
  if (!up.body) return res.end();
  Readable.fromWeb(up.body).on('error', () => res.destroy()).pipe(res);
}

// ===== 高画質: 映像(音声なし) + 音声 を ffmpeg で結合 (ffmpeg が無い環境では無効) =====
const { spawn, execFile } = require('child_process');
let ffOk;
const hasFfmpeg = () => (ffOk ??= new Promise((r) => execFile('ffmpeg', ['-version'], (e) => r(!e))));
const bestAudio = (fs) => fs.filter((f) => f.hasAudio && !f.hasVideo)
  .sort((a, b) => (b.ext === 'm4a') - (a.ext === 'm4a') || b.bitrate - a.bitrate)[0];

async function merge(req, res, id, u) {
  const s = await getStream(id);
  const v = s.formats.find((f) => f.itag === u.searchParams.get('v') && f.hasVideo);
  const a = s.formats.find((f) => f.itag === u.searchParams.get('a') && f.hasAudio) ?? bestAudio(s.formats);
  if (!v || !a) throw httpErr(404, 'format not found');
  if (!(await hasFfmpeg())) throw httpErr(501, 'ffmpeg is not installed on this server');
  const mp4 = v.ext === 'mp4' && a.ext === 'm4a';
  const hdr = `user-agent: ${ANDROID.ua}\r\n`;
  const out = mp4 ? ['-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4'] : ['-f', 'matroska'];
  const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error',
    '-headers', hdr, '-i', v.url, '-headers', hdr, '-i', a.url,
    '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', ...out, 'pipe:1']);
  const name = `${(s.title || id).replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 120)}_${v.height}p.${mp4 ? 'mp4' : 'mkv'}`;
  res.writeHead(200, {
    'Content-Type': mp4 ? 'video/mp4' : 'video/x-matroska',
    'Cache-Control': 'no-store',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
  });
  ff.stdout.pipe(res);
  ff.stderr.on('data', (d) => console.warn('ffmpeg:', String(d).trim()));
  res.on('close', () => ff.kill('SIGKILL'));
  ff.on('error', () => res.destroy());
}

// ===== 検索・ホーム・Shorts =====
function search(q, more, type) {
  if (!q) throw httpErr(400, 'q is required');
  return cached(`s:${q}:${type}:${more}`, 600, async () => {
    const { items, hasMore } = await paginate('search', { query: q, ...(SEARCH_PARAM[type] && { params: SEARCH_PARAM[type] }) }, more);
    return { query: q, type: type || 'all', hasMore, results: items };
  }, (v) => v.results.length > 0);
}

const home = () => cached('home', 600, async () => {
  const d = await yt('browse', { browseId: 'FEwhat_to_watch' });
  return { videos: parseAll(d).filter((x) => x.type === 'video') };
}, (v) => v.videos.length > 0);

const shortsFeed = (more) => cached(`sh:${more}`, 300, async () => {
  const { items, hasMore } = await paginate('search', { query: '#shorts' }, more);
  return { shorts: items.filter((x) => x.type === 'short'), hasMore };
}, (v) => v.shorts.length > 0);

// ===== 動画メタ情報・関連動画 =====
function videoMeta(id, withRelated, kind) {
  if (!validId(id)) throw httpErr(400, 'invalid videoId');
  return cached(`v:${id}:${withRelated}:${kind || ''}`, 900, async () => {
    const [p, n] = await Promise.all([getPlayer(id), withRelated ? yt('next', { videoId: id }).catch(() => null) : null]);
    const d = p.videoDetails ?? {};
    if (!d.title) throw httpErr(404, p.playabilityStatus?.reason || 'video not found');
    const related = n ? parseAll(n).filter((x) => x.type === 'video' && x.videoId !== id) : [];
    return {
      type: kind || 'video', videoId: id, title: d.title, description: d.shortDescription ?? '',
      author: d.author, authorId: d.channelId, lengthSeconds: +d.lengthSeconds || 0,
      viewCount: +d.viewCount || 0, isLive: !!d.isLiveContent, related,
    };
  }, (v) => !!v.title);
}

// ===== チャンネル =====
const resolveChannel = (raw) => {
  if (/^UC[\w-]{22}$/.test(raw)) return Promise.resolve(raw);
  return cached('h:' + raw, 86400, async () => {
    const url = raw.startsWith('http') ? raw : `https://www.youtube.com/${raw.startsWith('@') ? raw : '@' + raw}`;
    const r = await yt('navigation/resolve_url', { url });
    const b = r.endpoint?.browseEndpoint?.browseId ?? collect(r, ['browseId']).browseId.find((x) => /^UC/.test(x));
    if (!b) throw httpErr(404, 'channel not found');
    return b;
  }, (v) => !!v);
};

function channelMeta(d, cid) {
  const m = d.metadata?.channelMetadataRenderer ?? {};
  const h = d.header ?? {};
  const c4 = h.c4TabbedHeaderRenderer ?? {};
  const pv = h.pageHeaderRenderer?.content?.pageHeaderViewModel ?? {};
  const parts = (pv.metadata?.contentMetadataViewModel?.metadataRows ?? []).flatMap((r) => r.metadataParts ?? [])
    .map((p) => p.text?.content).filter(Boolean);
  return {
    channelId: m.externalId ?? cid,
    title: m.title ?? pv.title?.content ?? text(c4.title),
    handle: parts.find((p) => p.startsWith('@')) ?? text(c4.channelHandleText),
    subscriberText: parts.find((p) => /登録者|subscriber/i.test(p)) ?? text(c4.subscriberCountText),
    description: m.description ?? '',
    avatar: fixUrls(m.avatar?.thumbnails ?? c4.avatar?.thumbnails),
    banner: fixUrls(c4.banner?.thumbnails ?? pv.banner?.imageBannerViewModel?.image?.sources),
  };
}

function channelInfo(raw, kinds, more) {
  return cached(`c:${raw}:${kinds.join()}:${more}`, 1800, async () => {
    const cid = await resolveChannel(raw);
    const base = await yt('browse', { browseId: cid });
    const out = channelMeta(base, cid);
    const tabs = await Promise.all(kinds.map((k) =>
      paginate('browse', { browseId: cid, params: TAB[k] }, more).catch((e) => ({ items: [], hasMore: false, error: e.message }))));
    kinds.forEach((k, i) => {
      out[k] = tabs[i].items.filter((x) => KIND_TYPE[k].includes(x.type));
      out[k + 'HasMore'] = tabs[i].hasMore;
    });
    return out;
  }, (v) => !!v.title);
}

// ===== コメント =====
const comments = (id) => {
  if (!validId(id)) throw httpErr(400, 'invalid videoId');
  return cached('cm:' + id, 900, async () => {
    const n = await yt('next', { videoId: id });
    const tok = nextTok(n);
    if (!tok) return { videoId: id, comments: [] };
    const d = await yt('next', { continuation: tok });
    const c = collect(d, ['commentEntityPayload', 'commentRenderer']);
    let list = c.commentEntityPayload.map((p) => ({
      id: p.properties?.commentId, author: p.author?.displayName, authorId: p.author?.channelId,
      content: p.properties?.content?.content, publishedText: p.properties?.publishedTime,
      likeCount: p.toolbar?.likeCountNotliked, replyCount: p.toolbar?.replyCount,
    }));
    if (!list.length) {
      list = c.commentRenderer.map((r) => ({
        id: r.commentId, author: text(r.authorText), content: text(r.contentText),
        publishedText: text(r.publishedTimeText), likeCount: text(r.voteCount),
      }));
    }
    return { videoId: id, comments: list.filter((x) => x.content) };
  }, (v) => v.comments.length > 0);
};

// ===== ルーター =====
async function api(p, u, req, res) {
  const [, , r, id] = p.split('/').filter(Boolean);
  const more = Math.min(5, parseInt(u.searchParams.get('more') || '0', 10) || 0);
  switch (r) {
    case 'home': return home();
    case 'search': return search(u.searchParams.get('q') || '', more, u.searchParams.get('type'));
    case 'shorts': return id ? videoMeta(id, false, 'short') : shortsFeed(more);
    case 'videos': return videoMeta(id, u.searchParams.get('light') !== '1');
    case 'channels': {
      const tabs = (u.searchParams.get('tabs') || 'videos,shorts,live,playlists').split(',').filter((k) => TAB[k]);
      return channelInfo(decodeURIComponent(id || ''), tabs.length ? tabs : Object.keys(TAB), more);
    }
    case 'comments': return comments(id);
    case 'stream': {
      const st = await getStream(id);
      return { ...st, merge: await hasFfmpeg(), bestAudioItag: bestAudio(st.formats)?.itag ?? null };
    }
    case 'merge': return merge(req, res, id, u);
    case 'play': return play(req, res, id, u);
    default: throw httpErr(404, 'not found');
  }
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}

function serveStatic(p, res) {
  let f = path.normalize(path.join(PUB, p === '/' ? 'index.html' : p));
  if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(PUB, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  try {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
    if (!u.pathname.startsWith('/api/')) return serveStatic(u.pathname, res);
    const data = await api(u.pathname, u, req, res);
    if (data !== undefined) sendJson(res, 200, data);
  } catch (e) {
    if (res.headersSent) return res.destroy();
    sendJson(res, e.status || 502, { error: String(e.message || e) });
  }
}).listen(PORT, () => console.log(`NK3Tube listening on :${PORT}`));
