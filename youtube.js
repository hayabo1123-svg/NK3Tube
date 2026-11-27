'use strict';
// youtube.js: api.worker.js の取得・パース処理を Node 用に移植したモジュール（Workerのルーター/キャッシュ部分は server.js 側へ）
const { Readable } = require('stream');

const YT = 'https://www.youtube.com/youtubei/v1';
const YTDLP = (process.env.YTDLP_BACKEND || '').replace(/\/$/, ''); // 任意: nkdlp の yt-dlp バックエンド
const YTDLP_TOKEN = process.env.YTDLP_BACKEND_TOKEN || '';
const UA_WEB = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
const WEB = {
  ctx: { client: { clientName: 'WEB', clientVersion: '2.20250101.00.00', hl: 'ja', gl: 'JP' } },
  h: { 'X-YouTube-Client-Name': '1', 'X-YouTube-Client-Version': '2.20250101.00.00' }, ua: UA_WEB,
};
const ANDROID = {
  ctx: { client: { clientName: 'ANDROID', clientVersion: '19.09.37', androidSdkVersion: 30, hl: 'ja', gl: 'JP' } },
  h: { 'X-YouTube-Client-Name': '3', 'X-YouTube-Client-Version': '19.09.37' },
  ua: 'com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip',
};
const ANDROID_NEW = {
  ctx: { client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30, osName: 'Android', osVersion: '11', hl: 'ja', gl: 'JP' } },
  h: { 'X-YouTube-Client-Name': '3', 'X-YouTube-Client-Version': '20.10.38' },
  ua: 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip',
};
// ストリーム取得は順番に試す（全部失敗したら WEB の結果をそのまま使う）
const STREAM_CLIENTS = [ANDROID, ANDROID_NEW, WEB];
const TAB = {
  videos: 'EgZ2aWRlb3PyBgQKAjoA', shorts: 'EgZzaG9ydHPyBgUKA5oBAA==',
  live: 'EgdzdHJlYW1z8gYECgJ6AA==', playlists: 'EglwbGF5bGlzdHPyBgQKAkIA',
};
const SEARCH = { video: 'EgIQAQ==', channel: 'EgIQAg==', playlist: 'EgIQAw==' };
const KEYS = ['lockupViewModel', 'videoRenderer', 'gridVideoRenderer', 'compactVideoRenderer', 'playlistRenderer',
  'gridPlaylistRenderer', 'channelRenderer', 'reelItemRenderer', 'shortsLockupViewModel'];
const validId = id => /^[\w-]{11}$/.test(id || '');
const httpErr = (status, message) => Object.assign(new Error(message), { status });

// ===== キャッシュ（失敗・空の結果は保存しない） =====
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

// ===== YouTube 呼び出し（再試行つき） =====
async function yt(ep, body, client = WEB) {
  let err;
  for (let i = 0; i < 2; i++) {
    if (i) await new Promise(r => setTimeout(r, 300));
    try {
      const r = await fetch(`${YT}/${ep}?prettyPrint=false`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': client.ua, ...client.h },
        body: JSON.stringify({ context: client.ctx, ...body }),
        signal: AbortSignal.timeout(7000),
      });
      if (r.ok) return await r.json();
      err = new Error(`YouTube ${ep} HTTP ${r.status}`);
      if (r.status !== 429 && r.status < 500) break;
    } catch (e) { err = e; }
  }
  throw err;
}

// ===== パース共通 =====
const text = t => t?.simpleText ?? t?.runs?.map(r => r.text).join('') ?? t?.content ?? '';
const fixUrl = u => (u && u.startsWith('//') ? 'https:' + u : u || '');
const last = arr => (Array.isArray(arr) && arr.length ? arr[arr.length - 1].url : '');
function collect(root, keys) {
  const out = {};
  keys.forEach(k => (out[k] = []));
  (function walk(o) {
    if (!o || typeof o !== 'object') return;
    for (const k in o) {
      if (Object.hasOwn(out, k)) out[k].push(o[k]);
      walk(o[k]);
    }
  })(root);
  return out;
}
const nextTok = d => collect(d, ['continuationCommand']).continuationCommand.map(c => c.token).find(Boolean);
function dedupe(items) {
  const seen = new Set();
  return items.filter(r => {
    const id = r.videoId || r.channelId || r.playlistId;
    if (!id) return false;
    const k = r.type + id;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ===== マッパー =====
function mapVideo(v) {
  const o = v.ownerText || v.shortBylineText || v.longBylineText;
  return {
    type: 'video', videoId: v.videoId, title: text(v.title), author: text(o),
    authorId: o?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId,
    lengthText: text(v.lengthText), viewsText: text(v.viewCountText), publishedText: text(v.publishedTimeText),
  };
}
function mapLockupVideo(v) {
  const m = v.metadata?.lockupMetadataViewModel ?? {};
  const parts = (m.metadata?.contentMetadataViewModel?.metadataRows ?? []).flatMap(r => r.metadataParts ?? [])
    .map(p => p.text?.content).filter(Boolean);
  const av = m.image?.decoratedAvatarViewModel;
  return {
    type: 'video',
    videoId: v.contentId ?? v.rendererContext?.commandContext?.onTap?.innertubeCommand?.watchEndpoint?.videoId,
    title: m.title?.content,
    author: av?.a11yLabel?.replace(/^チャンネル「|」に移動します$/g, '') || parts[0] || '',
    authorId: av?.rendererContext?.commandContext?.onTap?.innertubeCommand?.browseEndpoint?.browseId,
    lengthText: collect(v, ['thumbnailBadgeViewModel']).thumbnailBadgeViewModel.map(b => b.text).find(t => /^\d+:\d+/.test(t || '')),
    viewsText: parts.find(p => /回視聴|views/i.test(p)),
    publishedText: parts.find(p => /前$/.test(p)),
  };
}
function mapShort(s) {
  return { type: 'short', videoId: s.videoId, title: text(s.headline), viewsText: text(s.viewCountText) };
}
function mapShortLockup(s) {
  return {
    type: 'short',
    videoId: s.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId ?? s.entityId?.replace('shorts-shelf-item-', ''),
    title: s.overlayMetadata?.primaryText?.content ?? s.accessibilityText,
    viewsText: s.overlayMetadata?.secondaryText?.content,
  };
}
function mapChannel(c) {
  const a = text(c.subscriberCountText), b = text(c.videoCountText);
  return {
    type: 'channel', channelId: c.channelId, title: text(c.title),
    handle: [a, b].find(t => t.startsWith('@')) || '',
    subscribersText: [b, a].find(t => t && !t.startsWith('@')) || '',
    description: text(c.descriptionSnippet), avatar: fixUrl(last(c.thumbnail?.thumbnails)),
  };
}
function mapPlaylist(p) {
  return { type: 'playlist', playlistId: p.playlistId, title: text(p.title), videoCount: text(p.videoCountText || p.videoCountShortText) };
}
function mapLockupPlaylist(v) {
  const m = v.metadata?.lockupMetadataViewModel ?? {};
  const th = v.contentImage?.collectionThumbnailViewModel?.primaryThumbnail?.thumbnailViewModel ?? {};
  return {
    type: 'playlist', playlistId: v.contentId, title: m.title?.content,
    videoCount: collect(th, ['thumbnailBadgeViewModel']).thumbnailBadgeViewModel.map(b => b.text).find(Boolean),
  };
}
// 検索・ホーム・チャンネルタブ共通の全件パーサー
function parseAll(data) {
  const c = collect(data, KEYS);
  const isVideoLock = l => !l.contentType || l.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO';
  return dedupe([
    ...c.lockupViewModel.filter(isVideoLock).map(mapLockupVideo),
    ...c.lockupViewModel.filter(l => l.contentType === 'LOCKUP_CONTENT_TYPE_PLAYLIST').map(mapLockupPlaylist),
    ...c.videoRenderer.concat(c.gridVideoRenderer, c.compactVideoRenderer).map(mapVideo),
    ...c.playlistRenderer.concat(c.gridPlaylistRenderer).map(mapPlaylist),
    ...c.channelRenderer.map(mapChannel),
    ...c.reelItemRenderer.map(mapShort),
    ...c.shortsLockupViewModel.map(mapShortLockup),
  ]);
}
async function paginate(ep, body, more = 0) {
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

// ===== 配信情報（ストリーム） =====
async function getPlayer(id) {
  for (const c of STREAM_CLIENTS) {
    const p = await yt('player', { videoId: id }, c).catch(() => null);
    if (p?.streamingData) return { p, c };
  }
  const w = await yt('player', { videoId: id }, WEB).catch(() => null);
  if (!w) throw httpErr(502, 'player request failed');
  return { p: w, c: WEB };
}
function normFormats(sd, ua) {
  return [...(sd.formats ?? []), ...(sd.adaptiveFormats ?? [])].filter(f => f.url).map(f => {
    const m = f.mimeType || '';
    return {
      itag: String(f.itag), url: f.url, ua, mime: m,
      ext: /webm/.test(m) ? 'webm' : /mp4/.test(m) ? (m.startsWith('audio') ? 'm4a' : 'mp4') : '',
      height: f.height || 0, fps: f.fps || 0, bitrate: f.bitrate || 0,
      hasVideo: m.startsWith('video/'), hasAudio: m.startsWith('audio/') || /mp4a|opus|vorbis/.test(m),
      label: f.qualityLabel || (f.audioQuality || '').replace('AUDIO_QUALITY_', ''),
      contentLength: +f.contentLength || 0,
    };
  });
}
async function viaYtdlp(id) {
  const r = await fetch(`${YTDLP}/extract?id=${id}`, {
    headers: YTDLP_TOKEN ? { authorization: `Bearer ${YTDLP_TOKEN}` } : {},
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`yt-dlp backend HTTP ${r.status}`);
  const info = await r.json();
  const formats = (info.formats || []).filter(f => f.url && f.protocol !== 'mhtml').map(f => {
    const v = !!f.vcodec && f.vcodec !== 'none', a = !!f.acodec && f.acodec !== 'none';
    return {
      itag: String(f.format_id), url: f.url, ua: ANDROID.ua, mime: `${v ? 'video' : 'audio'}/${f.ext || 'mp4'}`,
      ext: f.ext || 'mp4', height: f.height || 0, fps: f.fps || 0, bitrate: Math.round((f.tbr || 0) * 1000),
      hasVideo: v, hasAudio: a, label: f.format_note || (f.height ? f.height + 'p' : ''), contentLength: f.filesize || 0,
    };
  });
  return { id, title: info.title || '', author: info.uploader || info.channel || '', duration: info.duration || 0, formats };
}
// URL を含む完全版（サーバー内部だけで使う。クライアントには出さない）
function fullStream(id) {
  if (!validId(id)) throw httpErr(400, 'invalid videoId');
  return cached('full:' + id, 300, async () => {
    if (YTDLP) {
      try { return await viaYtdlp(id); } catch (e) { console.warn('yt-dlp backend failed:', e.message); }
    }
    const { p, c } = await getPlayer(id);
    const d = p.videoDetails ?? {};
    if (!p.streamingData) throw httpErr(502, `再生情報を取得できません（${p.playabilityStatus?.status || '不明'}）`);
    return {
      id, title: d.title || '', author: d.author || '', duration: +d.lengthSeconds || 0,
      formats: normFormats(p.streamingData, c.ua),
    };
  }, v => v.formats.length > 0);
}
async function stream(id) {
  const s = await fullStream(id);
  return { id, title: s.title, author: s.author, duration: s.duration, formats: s.formats.map(({ url, ua, ...f }) => f) };
}
const bestMuxed = fs => fs.filter(f => f.hasVideo && f.hasAudio).sort((a, b) => b.height - a.height)[0];

// 映像/音声を中継（Range対応）。dl=1 で保存用の添付ヘッダーを付ける
async function play(req, res, id, sp) {
  const s = await fullStream(id);
  const itag = sp.get('itag');
  const f = itag ? s.formats.find(x => x.itag === itag) : bestMuxed(s.formats);
  if (!f) throw httpErr(404, 'format not found');
  const h = { 'user-agent': f.ua };
  if (req.headers.range) h.range = req.headers.range;
  const up = await fetch(f.url, { headers: h });
  if (!up.ok && up.status !== 206) throw httpErr(502, `upstream HTTP ${up.status}`);
  const out = { 'content-type': f.mime.split(';')[0] || 'video/mp4', 'accept-ranges': 'bytes', 'cache-control': 'no-store' };
  for (const k of ['content-length', 'content-range']) { const v = up.headers.get(k); if (v) out[k] = v; }
  if (sp.get('dl') === '1') {
    const name = `${s.title || id}.${f.ext || 'mp4'}`.replace(/[\\/:*?"<>|\r\n]/g, '_');
    out['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
  }
  res.writeHead(up.status, out);
  if (!up.body) return res.end();
  Readable.fromWeb(up.body).on('error', () => res.destroy()).pipe(res);
}

// ===== 検索・ホーム・ショート =====
function search(q, more = 0, type = '') {
  if (!q) throw httpErr(400, 'q is required');
  return cached(`s:${q}:${type}:${more}`, 600, async () => {
    const { items, hasMore } = await paginate('search', { query: q, ...(SEARCH[type] && { params: SEARCH[type] }) }, more);
    return { query: q, hasMore, results: items };
  }, v => v.results.length > 0);
}
const home = () => cached('home', 600, async () => {
  const d = await yt('browse', { browseId: 'FEwhat_to_watch' });
  return { videos: parseAll(d).filter(x => x.type === 'video') };
}, v => v.videos.length > 0);
const shorts = (more = 0) => cached(`sh:${more}`, 300, async () => {
  const { items, hasMore } = await paginate('search', { query: '#shorts' }, more);
  return { shorts: items.filter(x => x.type === 'short'), hasMore };
}, v => v.shorts.length > 0);

// ===== 動画情報（関連動画つき） =====
const video = id => {
  if (!validId(id)) throw httpErr(400, 'invalid videoId');
  return cached('v:' + id, 900, async () => {
    const [{ p }, n] = await Promise.all([getPlayer(id), yt('next', { videoId: id }).catch(() => null)]);
    const d = p.videoDetails ?? {};
    if (!d.title) throw httpErr(404, p.playabilityStatus?.reason || 'video not found');
    const related = n ? parseAll(n).filter(x => x.type === 'video' && x.videoId !== id) : [];
    return {
      videoId: id, title: d.title, description: d.shortDescription || '', author: d.author || '', authorId: d.channelId || '',
      views: +d.viewCount || 0, lengthSeconds: +d.lengthSeconds || 0,
      publishedText: (p.microformat?.playerMicroformatRenderer?.publishDate || '').slice(0, 10), related,
    };
  }, v => !!v.title);
};

// ===== コメント =====
const comments = id => {
  if (!validId(id)) throw httpErr(400, 'invalid videoId');
  return cached('cm:' + id, 900, async () => {
    const n = await yt('next', { videoId: id });
    const tok = nextTok(n);
    if (!tok) return { videoId: id, comments: [] };
    const d = await yt('next', { continuation: tok });
    const c = collect(d, ['commentEntityPayload', 'commentRenderer']);
    let list = c.commentEntityPayload.map(p => ({
      id: p.properties?.commentId, author: p.author?.displayName || '', avatar: p.author?.avatarThumbnailUrl || '',
      content: p.properties?.content?.content || '', publishedText: p.properties?.publishedTime || '',
      likeCount: p.toolbar?.likeCountNotliked || '', replies: p.toolbar?.replyCount || 0,
    }));
    if (!list.length) {
      list = c.commentRenderer.map(r => ({
        id: r.commentId, author: text(r.authorText), avatar: r.authorThumbnail?.thumbnails?.[0]?.url || '',
        content: text(r.contentText), publishedText: text(r.publishedTimeText), likeCount: text(r.voteCount), replies: 0,
      }));
    }
    return { videoId: id, comments: list.filter(x => x.content) };
  }, v => v.comments.length > 0);
};

// ===== チャンネル =====
const channelId = raw => {
  if (/^UC[\w-]{22}$/.test(raw)) return Promise.resolve(raw);
  return cached('h:' + raw, 86400, async () => {
    const url = raw.startsWith('http') ? raw : `https://www.youtube.com/${raw.startsWith('@') ? raw : '@' + raw}`;
    const r = await yt('navigation/resolve_url', { url });
    const b = r.endpoint?.browseEndpoint?.browseId ?? collect(r, ['browseId']).browseId.find(x => /^UC/.test(x));
    if (!b) throw httpErr(404, 'channel not found');
    return b;
  }, v => !!v);
};
const channel = (raw, tab = 'videos', more = 0) => cached(`c:${raw}:${tab}:${more}`, 1800, async () => {
  const cid = await channelId(raw);
  const base = await yt('browse', { browseId: cid });
  const m = base.metadata?.channelMetadataRenderer ?? {};
  const hdr = base.header?.pageHeaderRenderer?.content?.pageHeaderViewModel ?? {};
  const c4 = base.header?.c4TabbedHeaderRenderer ?? {};
  const parts = (hdr.metadata?.contentMetadataViewModel?.metadataRows ?? []).flatMap(r => r.metadataParts ?? [])
    .map(p => p.text?.content).filter(Boolean);
  const { items, hasMore } = await paginate('browse', { browseId: cid, params: TAB[tab] || TAB.videos }, more);
  const want = { videos: 'video', shorts: 'short', live: 'video', playlists: 'playlist' }[tab] || 'video';
  return {
    channelId: m.externalId || cid, title: m.title || hdr.title?.content || text(c4.title),
    handle: parts.find(p => p.startsWith('@')) || '', subscribersText: parts.find(p => /登録者|subscriber/i.test(p)) || '',
    description: m.description || '', avatar: fixUrl(last(m.avatar?.thumbnails) || last(c4.avatar?.thumbnails)),
    banner: fixUrl(last(c4.banner?.thumbnails) || last(hdr.banner?.imageBannerViewModel?.image?.sources)),
    tab, hasMore, items: items.filter(x => x.type === want),
  };
}, v => !!v.title);

module.exports = { home, search, video, stream, play, shorts, comments, channel };
