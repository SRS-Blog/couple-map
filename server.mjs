// 情侣足迹地图 · 本地服务
// 零依赖（Node 内置模块）。职责：
//   1. 托管 public/ 静态页面
//   2. 托管 data/geo 地图数据、data/media 用户上传的图片视频、data/music 歌单音频
//   3. 提供记录读写 API，数据全部落在本机磁盘上，不联网、不上传
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
// 数据目录可用环境变量改掉 —— 测试就跑在沙箱里，绝不碰真实回忆
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const GEO_DIR = path.join(DATA_DIR, 'geo');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const MUSIC_DIR = path.join(DATA_DIR, 'music');
// 头像单独放：一对方框照片，跟记录里的媒体互不干扰
const AVATAR_DIR = path.join(DATA_DIR, 'avatars');
const BACKUP_DIR = process.env.BACKUP_DIR ? path.resolve(process.env.BACKUP_DIR) : path.join(ROOT, 'backups');
const STATE_FILE = path.join(DATA_DIR, 'records.json');
const MUSIC_FILE = path.join(DATA_DIR, 'music.json');

const PORT = Number(process.env.PORT || 5200);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

const DEFAULT_STATE = {
  version: 1,
  settings: {
    coupleNames: ['我', '你'],
    startDate: '',
    theme: 'rose',
    motto: '把每一次心动，都钉在地图上。',
    anniversaries: [],
  },
  records: [],
};

// 音乐只收这些格式（主打 mp3，顺带兼容常见音频）
const AUDIO_EXT = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.oga', '.flac']);
const DEFAULT_MUSIC = { tracks: [] };

// 头像只收图片，而且只有两个位置：0 = 左边那位，1 = 右边那位
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.bmp']);
const AVATAR_SLOTS = new Set(['0', '1']);

// ---------- 工具 ----------
const safeId = (s) => String(s || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);

function inside(base, target) {
  const b = path.resolve(base);
  const t = path.resolve(target);
  return t === b || t.startsWith(b + path.sep);
}

function json(res, data, code = 200) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
  res.end(body);
}

function readBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readState() {
  try {
    const txt = await fsp.readFile(STATE_FILE, 'utf8');
    const s = JSON.parse(txt);
    if (!s || typeof s !== 'object') throw new Error('bad');
    if (!Array.isArray(s.records)) s.records = [];
    if (!s.settings) s.settings = { ...DEFAULT_STATE.settings };
    return s;
  } catch {
    const fresh = structuredClone(DEFAULT_STATE);
    await writeState(fresh);
    return fresh;
  }
}

async function writeState(state) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await fsp.rename(tmp, STATE_FILE); // 原子替换，避免写一半断电损坏
}

// 歌单单独存一份，跟记录互不干扰
async function readMusic() {
  try {
    const txt = await fsp.readFile(MUSIC_FILE, 'utf8');
    const s = JSON.parse(txt);
    if (!s || typeof s !== 'object' || !Array.isArray(s.tracks)) throw new Error('bad');
    return s;
  } catch {
    return structuredClone(DEFAULT_MUSIC);
  }
}

async function writeMusic(list) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const tmp = MUSIC_FILE + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(list, null, 2), 'utf8');
  await fsp.rename(tmp, MUSIC_FILE);
}

// 按 id 前缀找到落盘的音频文件（扩展名可能变）
async function findTrackFile(trackId) {
  try {
    const files = await fsp.readdir(MUSIC_DIR);
    const hit = files.find((f) => f.startsWith(trackId + '.') && AUDIO_EXT.has(path.extname(f).toLowerCase()));
    return hit ? path.join(MUSIC_DIR, hit) : null;
  } catch {
    return null;
  }
}

async function sendFile(req, res, file, { cache = false } = {}) {
  let st;
  try { st = await fsp.stat(file); } catch { return json(res, { error: 'not found' }, 404); }
  if (st.isDirectory()) return json(res, { error: 'not found' }, 404);

  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const headers = {
    'content-type': type,
    'accept-ranges': 'bytes',
    'cache-control': cache ? 'public, max-age=86400' : 'no-cache',
  };

  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : st.size - 1;
      if (!Number.isFinite(start) || start < 0) start = 0;
      if (!Number.isFinite(end) || end >= st.size) end = st.size - 1;
      if (start > end) {
        res.writeHead(416, { 'content-range': 'bytes */' + st.size });
        return res.end();
      }
      headers['content-range'] = 'bytes ' + start + '-' + end + '/' + st.size;
      headers['content-length'] = end - start + 1;
      res.writeHead(206, headers);
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
  }

  headers['content-length'] = st.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  return fs.createReadStream(file).pipe(res);
}

// ---------- 路由 ----------
const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return json(res, { error: 'bad url' }, 400); }
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { return json(res, { error: 'bad path' }, 400); }
  const method = req.method || 'GET';

  try {
    // ---- 记录状态 ----
    if (pathname === '/api/state') {
      if (method === 'GET') return json(res, await readState());
      if (method === 'PUT') {
        const body = await readBody(req);
        const next = JSON.parse(body.toString('utf8'));
        if (!next || typeof next !== 'object' || !Array.isArray(next.records)) {
          return json(res, { error: '数据格式不正确' }, 400);
        }
        const cur = await readState();
        next.version = next.version || 1;
        next.settings = { ...cur.settings, ...(next.settings || {}) };
        await writeState(next);
        return json(res, { ok: true, count: next.records.length });
      }
      return json(res, { error: 'method not allowed' }, 405);
    }

    // ---- 上传媒体（原始二进制流式落盘，视频再大也不吃内存）----
    let m = pathname.match(/^\/api\/media\/([^/]+)\/([^/]+)$/);
    if (m) {
      const recordId = safeId(m[1]);
      const mediaId = safeId(m[2]);
      if (!recordId || !mediaId) return json(res, { error: '非法 id' }, 400);

      const dir = path.join(MEDIA_DIR, recordId);
      if (!inside(MEDIA_DIR, dir)) return json(res, { error: '非法路径' }, 400);

      if (method === 'POST') {
        await fsp.mkdir(dir, { recursive: true });

        let fileName = '';
        try { fileName = decodeURIComponent(req.headers['x-file-name'] || ''); } catch { fileName = ''; }
        const declaredType = String(req.headers['x-file-type'] || '');

        let ext = path.extname(fileName).toLowerCase().replace(/[^a-z0-9.]/g, '');
        if (!ext || ext.length > 8) {
          ext = Object.keys(MIME).find((k) => MIME[k] === declaredType) || '.bin';
        }

        const dest = path.join(dir, mediaId + ext);
        if (!inside(MEDIA_DIR, dest)) return json(res, { error: '非法路径' }, 400);

        await new Promise((resolve, reject) => {
          const ws = fs.createWriteStream(dest);
          req.pipe(ws);
          ws.on('finish', resolve);
          ws.on('error', reject);
          req.on('error', reject);
        });

        const size = (await fsp.stat(dest)).size;
        if (size === 0) { await fsp.unlink(dest).catch(() => {}); return json(res, { error: '空文件' }, 400); }

        return json(res, {
          ok: true,
          mediaId,
          name: fileName || mediaId + ext,
          type: declaredType || MIME[ext] || 'application/octet-stream',
          ext,
          size,
          url: '/media/' + recordId + '/' + mediaId + ext,
        });
      }

      if (method === 'DELETE') {
        let removed = 0;
        try {
          for (const f of await fsp.readdir(dir)) {
            if (f.startsWith(mediaId + '.')) { await fsp.unlink(path.join(dir, f)); removed++; }
          }
        } catch { /* 目录不存在，视作已删除 */ }
        return json(res, { ok: true, removed });
      }
      return json(res, { error: 'method not allowed' }, 405);
    }

    // ---- 头像：一对方框照片，0=左边那位、1=右边那位 ----
    m = pathname.match(/^\/api\/avatar(?:\/([^/]+))?$/);
    if (m) {
      // 一次取两个位置，前端好直接画出「一对」
      if (method === 'GET' && !m[1]) {
        const list = [];
        for (const s of ['0', '1']) {
          let file = null;
          try {
            for (const f of await fsp.readdir(AVATAR_DIR)) {
              if (f.startsWith('avatar-' + s + '.') && IMAGE_EXT.has(path.extname(f).toLowerCase())) {
                file = f; break;
              }
            }
          } catch { /* 还没传过头像 */ }
          // 带时间戳，换完头像不用强刷缓存
          list.push(file
            ? { slot: Number(s), url: '/avatars/' + file + '?t=' + Date.now(), name: file }
            : { slot: Number(s), url: '', name: '' });
        }
        return json(res, { avatars: list });
      }

      const slot = m[1] || '';
      if (!AVATAR_SLOTS.has(slot)) return json(res, { error: '头像只有两个位置（0 / 1）' }, 400);

      if (method === 'POST') {
        await fsp.mkdir(AVATAR_DIR, { recursive: true });

        let fileName = '';
        try { fileName = decodeURIComponent(req.headers['x-file-name'] || ''); } catch { fileName = ''; }
        const declaredType = String(req.headers['x-file-type'] || '');

        let ext = path.extname(fileName).toLowerCase().replace(/[^a-z0-9.]/g, '');
        if (!ext || ext.length > 8) {
          ext = Object.keys(MIME).find((k) => MIME[k] === declaredType) || '';
        }
        if (!IMAGE_EXT.has(ext)) return json(res, { error: '头像只收图片' }, 400);

        // 同一个位置只留一张：先清旧的，免得 png/jpg 叠着
        for (const f of await fsp.readdir(AVATAR_DIR).catch(() => [])) {
          if (f.startsWith('avatar-' + slot + '.')) {
            await fsp.unlink(path.join(AVATAR_DIR, f)).catch(() => {});
          }
        }

        const dest = path.join(AVATAR_DIR, 'avatar-' + slot + ext);
        if (!inside(AVATAR_DIR, dest)) return json(res, { error: '非法路径' }, 400);

        await new Promise((resolve, reject) => {
          const ws = fs.createWriteStream(dest);
          req.pipe(ws);
          ws.on('finish', resolve);
          ws.on('error', reject);
          req.on('error', reject);
        });

        const size = (await fsp.stat(dest)).size;
        if (size === 0) { await fsp.unlink(dest).catch(() => {}); return json(res, { error: '空文件' }, 400); }

        return json(res, {
          ok: true,
          slot: Number(slot),
          url: '/avatars/avatar-' + slot + ext + '?t=' + Date.now(),
          name: fileName || 'avatar-' + slot + ext,
          size,
        });
      }

      if (method === 'DELETE') {
        let removed = 0;
        for (const f of await fsp.readdir(AVATAR_DIR).catch(() => [])) {
          if (f.startsWith('avatar-' + slot + '.')) {
            await fsp.unlink(path.join(AVATAR_DIR, f)).catch(() => {});
            removed++;
          }
        }
        return json(res, { ok: true, removed });
      }
      return json(res, { error: 'method not allowed' }, 405);
    }

    // ---- 删除整条记录（连同它的媒体目录）----
    m = pathname.match(/^\/api\/records\/([^/]+)$/);
    if (m && method === 'DELETE') {
      const recordId = safeId(m[1]);
      const dir = path.join(MEDIA_DIR, recordId);
      if (inside(MEDIA_DIR, dir)) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      return json(res, { ok: true });
    }

    // ---- 歌单：列曲目 / 上传音频 / 删单曲 ----
    m = pathname.match(/^\/api\/music(?:\/([^/]+))?$/);
    if (m) {
      const trackId = m[1] ? safeId(m[1]) : '';
      const lib = await readMusic();

      if (method === 'GET' && !trackId) return json(res, lib);

      if (method === 'POST' && trackId) {
        await fsp.mkdir(MUSIC_DIR, { recursive: true });

        let fileName = '';
        try { fileName = decodeURIComponent(req.headers['x-file-name'] || ''); } catch { fileName = ''; }
        const declaredType = String(req.headers['x-file-type'] || '');

        let ext = path.extname(fileName).toLowerCase().replace(/[^a-z0-9.]/g, '');
        if (!AUDIO_EXT.has(ext)) {
          ext = Object.keys(MIME).find((k) => MIME[k] === declaredType && AUDIO_EXT.has(k)) || '';
        }
        if (!AUDIO_EXT.has(ext)) return json(res, { error: '只支持音频文件（mp3 / wav / m4a / ogg / flac）' }, 400);

        const dest = path.join(MUSIC_DIR, trackId + ext);
        if (!inside(MUSIC_DIR, dest)) return json(res, { error: '非法路径' }, 400);

        // 同 id 旧文件先清掉，避免出现 t_x.mp3 和 t_x.wav 并存
        const old = await findTrackFile(trackId);
        if (old && old !== dest) await fsp.unlink(old).catch(() => {});

        await new Promise((resolve, reject) => {
          const ws = fs.createWriteStream(dest);
          req.pipe(ws);
          ws.on('finish', resolve);
          ws.on('error', reject);
          req.on('error', reject);
        });

        const size = (await fsp.stat(dest)).size;
        if (size === 0) { await fsp.unlink(dest).catch(() => {}); return json(res, { error: '空文件' }, 400); }

        const track = {
          id: trackId,
          name: fileName || trackId + ext,
          ext,
          type: declaredType || MIME[ext] || 'audio/mpeg',
          size,
          url: '/music/' + trackId + ext,
          addedAt: new Date().toISOString(),
        };
        const at = lib.tracks.findIndex((t) => t.id === trackId);
        if (at >= 0) lib.tracks[at] = track; else lib.tracks.push(track);
        await writeMusic(lib);
        return json(res, { ok: true, track, count: lib.tracks.length });
      }

      if (method === 'DELETE' && trackId) {
        const f = await findTrackFile(trackId);
        if (f) await fsp.unlink(f).catch(() => {});
        lib.tracks = lib.tracks.filter((t) => t.id !== trackId);
        await writeMusic(lib);
        return json(res, { ok: true, count: lib.tracks.length });
      }

      return json(res, { error: 'method not allowed' }, 405);
    }

    // ---- 备份：把整个 data/ 复制一份到 backups/ ----
    if (pathname === '/api/backup' && method === 'POST') {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const dest = path.join(BACKUP_DIR, 'backup-' + stamp);
      await fsp.mkdir(BACKUP_DIR, { recursive: true });
      await fsp.cp(DATA_DIR, dest, { recursive: true });
      return json(res, { ok: true, path: dest });
    }

    // ---- 初始化：把一切恢复成刚装好的样子 ----
    // 只动「你们的东西」：记录、设置、照片视频、头像、歌曲。
    // data/geo 是地图数据，跟回忆无关，留着不动。
    // 不走 PUT /api/state —— 那个是整体覆盖，前端拼错一点就是灭顶之灾；
    // 这里是服务端自己动手，中间没有「把空状态 PUT 上去」这一步。
    if (pathname === '/api/reset' && method === 'POST') {
      // 必须带确认参数，免得哪天一个误请求把家底端了
      let payload = {};
      try { payload = JSON.parse((await readBody(req, 1024)).toString('utf8') || '{}'); } catch { payload = {}; }
      if (!payload || payload.confirm !== 'reset') {
        return json(res, { error: '缺少确认参数，初始化被拦下了' }, 400);
      }

      // 后悔药：动手之前先把现在的样子整个存一份
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const dest = path.join(BACKUP_DIR, 'backup-' + stamp);
      await fsp.mkdir(BACKUP_DIR, { recursive: true });
      await fsp.cp(DATA_DIR, dest, { recursive: true });

      // 照片视频 / 头像 / 歌曲：清空目录内容，目录本身留着（静态服务还要用）
      const wipeDir = async (dir) => {
        const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
        let n = 0;
        for (const e of entries) {
          await fsp.rm(path.join(dir, e.name), { recursive: true, force: true }).catch(() => {});
          n++;
        }
        return n;
      };
      const mediaN = await wipeDir(MEDIA_DIR);
      await wipeDir(AVATAR_DIR);
      await wipeDir(MUSIC_DIR);
      await fsp.rm(MUSIC_FILE, { force: true }).catch(() => {});

      const cur = await readState();
      const recN = Array.isArray(cur.records) ? cur.records.length : 0;
      await writeState(structuredClone(DEFAULT_STATE));

      return json(res, { ok: true, backup: dest, counts: { records: recN, media: mediaN } });
    }

    // ---- 在资源管理器里打开数据文件夹（照片视频的真身在这儿）----
    if (pathname === '/api/reveal' && method === 'POST') {
      const target = path.join(MEDIA_DIR);
      await fsp.mkdir(target, { recursive: true });
      if (process.platform === 'win32') exec('explorer "' + target + '"');
      else if (process.platform === 'darwin') exec('open "' + target + '"');
      else exec('xdg-open "' + target + '"');
      return json(res, { ok: true, path: target });
    }

    // ---- 静态资源 ----
    if (method !== 'GET' && method !== 'HEAD') return json(res, { error: 'method not allowed' }, 405);

    if (pathname === '/' || pathname === '/index.html') {
      return sendFile(req, res, path.join(PUBLIC_DIR, 'index.html'));
    }
    if (pathname.startsWith('/geo/')) {
      const f = path.join(GEO_DIR, pathname.slice(5));
      if (!inside(GEO_DIR, f)) return json(res, { error: 'forbidden' }, 403);
      return sendFile(req, res, f, { cache: true });
    }
    if (pathname.startsWith('/media/')) {
      const f = path.join(MEDIA_DIR, pathname.slice(7));
      if (!inside(MEDIA_DIR, f)) return json(res, { error: 'forbidden' }, 403);
      return sendFile(req, res, f, { cache: true });
    }
    if (pathname.startsWith('/music/')) {
      const f = path.join(MUSIC_DIR, pathname.slice(7));
      if (!inside(MUSIC_DIR, f)) return json(res, { error: 'forbidden' }, 403);
      return sendFile(req, res, f, { cache: true });
    }
    if (pathname.startsWith('/avatars/')) {
      const f = path.join(AVATAR_DIR, pathname.slice(9));
      if (!inside(AVATAR_DIR, f)) return json(res, { error: 'forbidden' }, 403);
      // 换头像后 URL 会带新的时间戳，这里可以放心缓存
      return sendFile(req, res, f, { cache: true });
    }
    const f = path.join(PUBLIC_DIR, pathname);
    if (!inside(PUBLIC_DIR, f)) return json(res, { error: 'forbidden' }, 403);
    return sendFile(req, res, f);
  } catch (err) {
    console.error('[error]', method, pathname, err && err.message);
    if (!res.headersSent) json(res, { error: String((err && err.message) || err) }, 500);
    else res.end();
  }
});

// 端口被占用就顺延，最多试 10 个
function listen(port, tries = 10) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && tries > 0) {
      console.log('端口 ' + port + ' 被占用，换 ' + (port + 1) + ' 试试…');
      listen(port + 1, tries - 1);
    } else {
      console.error(err);
      process.exit(1);
    }
  });
  server.listen(port, () => {
    const line = '─'.repeat(46);
    console.log('\n' + line);
    console.log('  ❤  情侣足迹地图 已经跑起来了');
    console.log(line);
    console.log('  在浏览器打开：  http://localhost:' + port);
    console.log('  照片视频真身：  ' + MEDIA_DIR);
    console.log('  数据备份文件：  ' + STATE_FILE);
    console.log(line);
    console.log('  按 Ctrl + C 停止\n');
  });
}
listen(PORT);
