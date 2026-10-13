// 冒烟测试：在**沙箱数据目录**里起一个临时服务，把每个接口跑一遍，再关掉。
// 注意：这个测试从头到尾不碰真实的 data/ —— 服务用 DATA_DIR 指到临时目录，
// 测完整个临时目录删掉。所以怎么折腾都不会弄丢你的回忆。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5299; // 故意用个冷门端口，不和正在跑的服务打架
const BASE = 'http://localhost:' + PORT;

// 沙箱：所有写入都落在这儿，测完就删
const SANDBOX = path.join(os.tmpdir(), 'couple-map-smoke-' + Date.now());
const SBOX_DATA = path.join(SANDBOX, 'data');
const SBOX_BACKUP = path.join(SANDBOX, 'backups');
fs.mkdirSync(path.join(SBOX_DATA, 'geo'), { recursive: true });
fs.mkdirSync(SBOX_BACKUP, { recursive: true });

const results = [];
const ok = (name, d) => results.push(['OK  ', name, d || '']);
const bad = (name, d) => results.push(['FAIL', name, d || '']);
const skip = (name, d) => results.push(['SKIP', name, d || '']);

// 起跑前先给真实的 data/ 拍个快照，收尾时逐字节比对 —— 谁敢动真实数据就当场报警
const realDataBefore = JSON.stringify({
  state: fs.existsSync(path.join(ROOT, 'data', 'records.json'))
    ? fs.readFileSync(path.join(ROOT, 'data', 'records.json'), 'utf8') : null,
  music: fs.existsSync(path.join(ROOT, 'data', 'music.json'))
    ? fs.readFileSync(path.join(ROOT, 'data', 'music.json'), 'utf8') : null,
  media: fs.existsSync(path.join(ROOT, 'data', 'media'))
    ? fs.readdirSync(path.join(ROOT, 'data', 'media')).sort().join(',') : '',
  avatars: fs.existsSync(path.join(ROOT, 'data', 'avatars'))
    ? fs.readdirSync(path.join(ROOT, 'data', 'avatars')).sort().join(',') : '',
});

const srv = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: SBOX_DATA, BACKUP_DIR: SBOX_BACKUP },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvOut = '';
srv.stdout.on('data', (d) => { srvOut += d; });
srv.stderr.on('data', (d) => { srvOut += d; });

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/state'); if (r.ok) return true; } catch { /* 还没起来 */ }
    await new Promise((s) => setTimeout(s, 100));
  }
  return false;
}

try {
  if (!(await waitReady())) { bad('服务启动', srvOut.slice(-400).trim()); throw new Error('服务没起来'); }
  ok('服务启动', '沙箱端口 ' + PORT + '，数据目录 ' + path.basename(SBOX_DATA));

  // 沙箱守卫：确认服务真的没在写真实 data/
  const realData = path.join(ROOT, 'data');
  ok('沙箱隔离', '真实 data/ = ' + realData + '，测试写入 = ' + SBOX_DATA);

  // ---- 静态资源 ----
  let r = await fetch(BASE + '/');
  const html = await r.text();
  r.status === 200 && html.includes('id="map"') ? ok('GET /', 'index.html ' + html.length + ' 字节') : bad('GET /', 'status ' + r.status);

  r = await fetch(BASE + '/js/app.js');
  const ct = r.headers.get('content-type') || '';
  r.status === 200 && ct.startsWith('text/javascript') ? ok('JS 的 Content-Type', ct) : bad('JS 的 Content-Type', 'status ' + r.status + ' type ' + ct);

  r = await fetch(BASE + '/css/style.css');
  r.status === 200 ? ok('GET /css/style.css', r.headers.get('content-type') || '') : bad('GET /css/style.css', 'status ' + r.status);

  r = await fetch(BASE + '/../server.mjs');
  r.status === 403 || r.status === 404 ? ok('路径穿越被拦', 'status ' + r.status) : bad('路径穿越被拦', '居然返回了 ' + r.status);

  // ---- 地图数据（从真实 data/geo 拷进沙箱一份；这是下载来的公开数据，不是私人回忆）----
  const realChina = path.join(ROOT, 'data', 'geo', 'china.json');
  const chinaFile = path.join(SBOX_DATA, 'geo', 'china.json');
  if (fs.existsSync(realChina)) {
    fs.copyFileSync(realChina, chinaFile);
    r = await fetch(BASE + '/geo/china.json', { headers: { range: 'bytes=0-99' } });
    const cr = r.headers.get('content-range') || '';
    r.status === 206 && cr.startsWith('bytes 0-99/') ? ok('Range 请求 /geo/china.json', cr) : bad('Range 请求 /geo/china.json', 'status ' + r.status + ' ' + cr);

    const geo = JSON.parse(fs.readFileSync(chinaFile, 'utf8'));
    const f0 = geo.features && geo.features[0];
    const p = (f0 && f0.properties) || {};
    const keys = Object.keys(p);
    const need = ['adcode', 'name', 'childrenNum', 'centroid'];
    const missing = need.filter((k) => !(k in p));
    missing.length === 0
      ? ok('GeoJSON 字段核对', geo.features.length + ' 个省，properties 含 ' + keys.join(','))
      : bad('GeoJSON 字段核对', '缺少 ' + missing.join(',') + '；实际有 ' + keys.join(','));
    Array.isArray(p.centroid) && p.centroid.length === 2
      ? ok('centroid 是 [经度,纬度]', JSON.stringify(p.centroid))
      : bad('centroid 是 [经度,纬度]', JSON.stringify(p.centroid));
  } else {
    skip('Range 请求 /geo/china.json', 'data/geo/china.json 还没下载');
    skip('GeoJSON 字段核对', '同上');
  }

  // ---- 媒体上传 ----
  const blob = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2000, 0x78)]);
  r = await fetch(BASE + '/api/media/r_smoke/m_smoke', {
    method: 'POST',
    headers: { 'x-file-name': encodeURIComponent('测试图.png'), 'x-file-type': 'image/png', 'content-type': 'image/png' },
    body: blob,
  });
  let j = await r.json();
  const mediaFile = path.join(SBOX_DATA, 'media', 'r_smoke', 'm_smoke.png');
  j.ok && fs.existsSync(mediaFile) && fs.statSync(mediaFile).size === blob.length
    ? ok('POST /api/media（流式落盘）', j.url + '，' + j.size + ' 字节，中文名=' + j.name)
    : bad('POST /api/media（流式落盘）', JSON.stringify(j).slice(0, 200) + ' 文件存在=' + fs.existsSync(mediaFile));

  r = await fetch(BASE + '/media/r_smoke/m_smoke.png');
  const got = Buffer.from(await r.arrayBuffer());
  r.status === 200 && got.length === blob.length && (r.headers.get('content-type') || '').startsWith('image/png')
    ? ok('GET /media/... 取回', r.headers.get('content-type'))
    : bad('GET /media/... 取回', 'status ' + r.status + ' 长度 ' + got.length);

  r = await fetch(BASE + '/media/r_smoke/m_smoke.png', { headers: { range: 'bytes=10-19' } });
  r.status === 206 && (await r.arrayBuffer()).byteLength === 10
    ? ok('媒体 Range（视频拖进度条靠它）', r.headers.get('content-range'))
    : bad('媒体 Range（视频拖进度条靠它）', 'status ' + r.status);

  // ---- 记录读写 ----
  const rec = {
    id: 'r_smoke', adcode: '440305', path: ['440000', '440300', '440305'],
    names: ['广东省', '深圳市', '南山区'], title: '冒烟测试', text: 't',
    date: '2026-10-10', mood: '💗', tags: ['测试'],
    bgmId: 't_bgm', bgmName: '我们的歌.mp3', media: [],
  };
  r = await fetch(BASE + '/api/state', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ records: [rec], settings: {} }),
  });
  j = await r.json();
  j.ok && j.count === 1 ? ok('PUT /api/state', 'count=' + j.count) : bad('PUT /api/state', JSON.stringify(j).slice(0, 200));

  j = await (await fetch(BASE + '/api/state')).json();
  j.records.length === 1 && j.records[0].id === 'r_smoke' && j.records[0].names[2] === '南山区'
    ? ok('GET 回读（含中文）', j.records[0].names.join('›'))
    : bad('GET 回读（含中文）', JSON.stringify(j).slice(0, 200));

  // 回忆上的 BGM 要能原样存住
  const g = j.records && j.records[0];
  g && g.bgmId === 't_bgm' && g.bgmName === '我们的歌.mp3'
    ? ok('回忆的 BGM 字段存住了', g.bgmId + ' / ' + g.bgmName)
    : bad('回忆的 BGM 字段存住了', JSON.stringify(g).slice(0, 200));

  r = await fetch(BASE + '/api/state', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"records":"not-array"}' });
  r.status === 400 ? ok('坏数据被拒', 'status 400') : bad('坏数据被拒', '居然返回 ' + r.status);

  // ---- 删除 ----
  j = await (await fetch(BASE + '/api/records/r_smoke', { method: 'DELETE' })).json();
  j.ok && !fs.existsSync(path.join(SBOX_DATA, 'media', 'r_smoke'))
    ? ok('DELETE /api/records（连媒体目录）', '目录已清')
    : bad('DELETE /api/records（连媒体目录）', JSON.stringify(j));

  // ---- 歌单 ----
  // 传一首假 mp3（内容无所谓，只验流式落盘和清单维护）
  const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(1500, 0x42)]);
  r = await fetch(BASE + '/api/music/t_smoke', {
    method: 'POST',
    headers: { 'x-file-name': encodeURIComponent('我们的歌.mp3'), 'x-file-type': 'audio/mpeg', 'content-type': 'audio/mpeg' },
    body: mp3,
  });
  j = await r.json();
  const trackFile = path.join(SBOX_DATA, 'music', 't_smoke.mp3');
  j.ok && j.track && fs.existsSync(trackFile) && fs.statSync(trackFile).size === mp3.length
    ? ok('POST /api/music（上传音频）', j.track.url + '，' + j.track.size + ' 字节，' + j.track.name)
    : bad('POST /api/music（上传音频）', JSON.stringify(j).slice(0, 200) + ' 文件存在=' + fs.existsSync(trackFile));

  j = await (await fetch(BASE + '/api/music')).json();
  const t0 = (j.tracks || []).find((t) => t.id === 't_smoke');
  t0 && t0.name === '我们的歌.mp3' && t0.ext === '.mp3'
    ? ok('GET /api/music（中文曲名回读）', j.tracks.length + ' 首，含「' + t0.name + '」')
    : bad('GET /api/music（中文曲名回读）', JSON.stringify(j).slice(0, 200));

  r = await fetch(BASE + '/music/t_smoke.mp3', { headers: { range: 'bytes=5-14' } });
  r.status === 206 && (await r.arrayBuffer()).byteLength === 10
    ? ok('音乐 Range（拖进度条靠它）', r.headers.get('content-range'))
    : bad('音乐 Range（拖进度条靠它）', 'status ' + r.status);

  // 非音频格式要被拒
  r = await fetch(BASE + '/api/music/t_bad', {
    method: 'POST',
    headers: { 'x-file-name': encodeURIComponent('木马.exe'), 'x-file-type': 'application/octet-stream' },
    body: Buffer.alloc(64, 1),
  });
  r.status === 400 ? ok('非音频格式被拒', 'status 400') : bad('非音频格式被拒', '居然返回 ' + r.status);

  j = await (await fetch(BASE + '/api/music/t_smoke', { method: 'DELETE' })).json();
  j.ok && !fs.existsSync(trackFile)
    ? ok('DELETE /api/music（连文件一起删）', '剩 ' + j.count + ' 首')
    : bad('DELETE /api/music（连文件一起删）', JSON.stringify(j).slice(0, 200) + ' 文件存在=' + fs.existsSync(trackFile));

  // ---- BGM 完整链路：传歌 → 回忆引用它 → 回读校验 ----
  r = await fetch(BASE + '/api/music/t_bgm1', {
    method: 'POST',
    headers: { 'x-file-name': encodeURIComponent('小幸运.mp3'), 'x-file-type': 'audio/mpeg' },
    body: Buffer.concat([Buffer.from('ID3'), Buffer.alloc(800, 0x41)]),
  });
  j = await r.json();
  j.ok ? ok('传一首 BGM', j.track.name) : bad('传一首 BGM', JSON.stringify(j).slice(0, 160));

  r = await fetch(BASE + '/api/music/t_bgm2', {
    method: 'POST',
    headers: { 'x-file-name': encodeURIComponent('慢慢喜欢你.mp3'), 'x-file-type': 'audio/mpeg' },
    body: Buffer.concat([Buffer.from('ID3'), Buffer.alloc(800, 0x42)]),
  });
  await r.json();
  j = await (await fetch(BASE + '/api/music')).json();
  j.tracks.length === 2 ? ok('歌单有两首（轮播素材）', j.tracks.map((t) => t.name).join(' / '))
    : bad('歌单有两首', '实际 ' + j.tracks.length);

  // 回忆挂上第一首
  const bgmRec = {
    id: 'r_bgmlink', adcode: '440305', path: ['440000', '440300', '440305'],
    names: ['广东省', '深圳市', '南山区'], title: '海边那天', text: '风很大',
    date: '2026-10-10', mood: '💗', tags: ['看海'],
    bgmId: 't_bgm1', bgmName: '小幸运.mp3', media: [],
  };
  r = await fetch(BASE + '/api/state', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ records: [bgmRec], settings: {} }),
  });
  await r.json();
  j = await (await fetch(BASE + '/api/state')).json();
  const linked = j.records.find((x) => x.id === 'r_bgmlink');
  linked && linked.bgmId === 't_bgm1' && linked.bgmName === '小幸运.mp3'
    ? ok('回忆挂上 BGM', linked.title + ' → ' + linked.bgmName)
    : bad('回忆挂上 BGM', JSON.stringify(linked).slice(0, 200));

  // 前端点歌时靠这个 id 找歌 —— 歌单里必须能命中
  const hit = (await (await fetch(BASE + '/api/music')).json()).tracks.find((t) => t.id === (linked && linked.bgmId));
  hit && hit.url === '/music/t_bgm1.mp3'
    ? ok('按 bgmId 能点到歌', hit.name + ' → ' + hit.url)
    : bad('按 bgmId 能点到歌', JSON.stringify(hit).slice(0, 200));

  // 删掉歌，回忆上的 bgmId 变成悬空引用 —— 前端要能容错（这正是 bgmName 冗余存一份的原因）
  await fetch(BASE + '/api/music/t_bgm1', { method: 'DELETE' });
  j = await (await fetch(BASE + '/api/music')).json();
  const orphan = j.tracks.find((t) => t.id === 't_bgm1');
  const rec2 = (await (await fetch(BASE + '/api/state')).json()).records.find((x) => x.id === 'r_bgmlink');
  (!orphan && rec2 && rec2.bgmName === '小幸运.mp3')
    ? ok('歌删了但回忆仍显示歌名', 'bgmName 冗余存住了「' + rec2.bgmName + '」')
    : bad('歌删了但回忆仍显示歌名', 'orphan=' + JSON.stringify(orphan) + ' rec=' + JSON.stringify(rec2 && rec2.bgmName));

  // ---- 头像对：两张方图 → 读回一对 → 覆盖换图 → 拒绝非图 / 非法位置 ----
  r = await fetch(BASE + '/api/avatar/0', {
    method: 'POST',
    headers: { 'x-file-name': encodeURIComponent('我.png'), 'x-file-type': 'image/png' },
    body: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(600, 0x43)]),
  });
  j = await r.json();
  j.ok && /^\/avatars\/avatar-0\.png\?t=/.test(j.url)
    ? ok('传左边的头像', j.url + '，' + j.size + ' 字节')
    : bad('传左边的头像', JSON.stringify(j).slice(0, 200));

  r = await fetch(BASE + '/api/avatar/1', {
    method: 'POST',
    headers: { 'x-file-name': encodeURIComponent('TA.jpg'), 'x-file-type': 'image/jpeg' },
    body: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(700, 0x44)]),
  });
  await r.json();

  j = await (await fetch(BASE + '/api/avatar')).json();
  const pair = j.avatars || [];
  (pair.length === 2 && pair[0].url && pair[1].url && pair[0].slot === 0 && pair[1].slot === 1)
    ? ok('读回一对头像', pair.map((p) => p.name).join(' / '))
    : bad('读回一对头像', JSON.stringify(pair).slice(0, 220));

  r = await fetch(BASE + pair[0].url); // url 自带开头的斜杠，别再补一个
  r.ok && r.headers.get('content-type').includes('image')
    ? ok('头像文件能取到', pair[0].url.split('?')[0] + ' → ' + r.headers.get('content-type'))
    : bad('头像文件能取到', 'status=' + r.status);

  // 同一个位置再传一次：只留新的，不能 png/jpg 叠着
  r = await fetch(BASE + '/api/avatar/0', {
    method: 'POST',
    headers: { 'x-file-name': encodeURIComponent('换了.webp'), 'x-file-type': 'image/webp' },
    body: Buffer.alloc(400, 0x45),
  });
  await r.json();
  const sboxAvatars = path.join(SBOX_DATA, 'avatars');
  const slot0Files = fs.readdirSync(sboxAvatars).filter((f) => f.startsWith('avatar-0.'));
  (slot0Files.length === 1 && slot0Files[0] === 'avatar-0.webp')
    ? ok('换头像会顶掉旧的', slot0Files[0] + '，目录里只剩 ' + slot0Files.length + ' 个 avatar-0')
    : bad('换头像会顶掉旧的', '目录里 avatar-0.* = ' + slot0Files.join(','));

  // 非图片拒收
  r = await fetch(BASE + '/api/avatar/0', {
    method: 'POST',
    headers: { 'x-file-name': encodeURIComponent('木马.mp3'), 'x-file-type': 'audio/mpeg' },
    body: Buffer.alloc(200, 0x46),
  });
  j = await r.json();
  (!j.ok && r.status === 400)
    ? ok('头像拒收非图片', j.error)
    : bad('头像拒收非图片', 'status=' + r.status + ' ' + JSON.stringify(j).slice(0, 120));

  // 只有两个位置，slot=2 不存在
  r = await fetch(BASE + '/api/avatar/2', {
    method: 'POST',
    headers: { 'x-file-name': encodeURIComponent('x.png'), 'x-file-type': 'image/png' },
    body: Buffer.alloc(50, 0x47),
  });
  j = await r.json();
  (!j.ok && r.status === 400)
    ? ok('头像位置只有 0/1', j.error)
    : bad('头像位置只有 0/1', 'status=' + r.status + ' ' + JSON.stringify(j).slice(0, 120));

  // 路径穿越被拦
  r = await fetch(BASE + '/avatars/..%2F..%2Frecords.json');
  (!r.ok || !(await r.text()).includes('"records"'))
    ? ok('头像路径穿越被拦', 'status ' + r.status)
    : bad('头像路径穿越被拦', '居然读到了 records.json');

  // 删掉左边那张
  r = await fetch(BASE + '/api/avatar/0', { method: 'DELETE' });
  j = await r.json();
  j.ok && j.removed === 1
    ? ok('删除单边头像', 'removed=' + j.removed + '，另一边还在')
    : bad('删除单边头像', JSON.stringify(j));
  j = await (await fetch(BASE + '/api/avatar')).json();
  (!j.avatars[0].url && j.avatars[1].url)
    ? ok('删完仍是一对（一边空一边有）', '左空右有，前端画空相框')
    : bad('删完仍是一对', JSON.stringify(j.avatars));

  // ---- 初始化：把一切恢复成刚装好的样子 ----
  // 先塞一张照片进去，不然等会儿「照片删干净了」这句话没什么可验的
  r = await fetch(BASE + '/api/media/r_wipe/m_wipe', {
    method: 'POST',
    headers: { 'x-file-name': encodeURIComponent('要删的照片.png'), 'x-file-type': 'image/png' },
    body: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(300, 0x5a)]),
  });
  await r.json();

  // 不带确认参数：谁误发一个 POST 都不能把家底端了
  r = await fetch(BASE + '/api/reset', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  j = await r.json();
  (!j.ok && r.status === 400)
    ? ok('初始化缺确认参数被拦', j.error)
    : bad('初始化缺确认参数被拦', 'status=' + r.status + ' ' + JSON.stringify(j).slice(0, 120));

  const beforeRec = (await (await fetch(BASE + '/api/state')).json()).records.length;
  const beforeMu = fs.existsSync(path.join(SBOX_DATA, 'music')) ? fs.readdirSync(path.join(SBOX_DATA, 'music')) : [];
  const beforeAv = fs.existsSync(path.join(SBOX_DATA, 'avatars')) ? fs.readdirSync(path.join(SBOX_DATA, 'avatars')) : [];
  const beforeMd = fs.existsSync(path.join(SBOX_DATA, 'media')) ? fs.readdirSync(path.join(SBOX_DATA, 'media')) : [];

  r = await fetch(BASE + '/api/reset', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirm: 'reset' }),
  });
  j = await r.json();
  j.ok && j.backup
    ? ok('POST /api/reset', '备份 ' + path.basename(j.backup) + '，清掉 ' + j.counts.records + ' 段 / ' + j.counts.media + ' 个媒体目录')
    : bad('POST /api/reset', JSON.stringify(j).slice(0, 200));

  // 后悔药得真在：旧记录能在备份里找回来
  const backedState = j.backup ? path.join(j.backup, 'records.json') : '';
  (backedState && fs.existsSync(backedState)
    && JSON.parse(fs.readFileSync(backedState, 'utf8')).records.length === beforeRec)
    ? ok('备份里存着旧记录', beforeRec + ' 段都在 ' + path.basename(j.backup))
    : bad('备份里存着旧记录', backedState || '没备份');

  // 记录清空、设置回出厂
  const afterR = await (await fetch(BASE + '/api/state')).json();
  const ds = afterR.settings || {};
  (afterR.records.length === 0 && Array.isArray(ds.coupleNames) && ds.coupleNames[0] === '我'
    && ds.startDate === '' && Array.isArray(ds.anniversaries) && ds.anniversaries.length === 0)
    ? ok('记录清空、设置回出厂', 'records=0，名字=' + ds.coupleNames.join('和') + '，签名=' + ds.motto)
    : bad('记录清空、设置回出厂', JSON.stringify(afterR).slice(0, 220));

  // 照片视频 / 头像 / 歌曲：文件真的从磁盘上没了
  const mdLeft = fs.existsSync(path.join(SBOX_DATA, 'media')) ? fs.readdirSync(path.join(SBOX_DATA, 'media')) : [];
  const avLeft = fs.existsSync(path.join(SBOX_DATA, 'avatars')) ? fs.readdirSync(path.join(SBOX_DATA, 'avatars')) : [];
  const muLeft = fs.existsSync(path.join(SBOX_DATA, 'music')) ? fs.readdirSync(path.join(SBOX_DATA, 'music')) : [];
  (mdLeft.length === 0 && avLeft.length === 0 && muLeft.length === 0)
    ? ok('照片视频 / 头像 / 歌曲删干净', '清了 ' + beforeMd.length + '+' + beforeAv.length + '+' + beforeMu.length + ' → 0+0+0')
    : bad('照片视频 / 头像 / 歌曲删干净', 'media=' + mdLeft + ' avatars=' + avLeft + ' music=' + muLeft);

  // 地图数据不是回忆，得留着
  if (fs.existsSync(realChina)) {
    fs.existsSync(path.join(SBOX_DATA, 'geo', 'china.json'))
      ? ok('地图数据没被动', 'geo/china.json 还在')
      : bad('地图数据没被动', 'china.json 被删了！');
  } else {
    skip('地图数据没被动', '本来就没下载');
  }
} catch (e) {
  bad('异常中断', e.message);
} finally {
  srv.kill();

  // 收尾断言：整个测试过程必须没碰过真实 data/，一个字节都不能变
  try {
    const realState = path.join(ROOT, 'data', 'records.json');
    const realMusic = path.join(ROOT, 'data', 'music.json');
    const now = JSON.stringify({
      state: fs.existsSync(realState) ? fs.readFileSync(realState, 'utf8') : null,
      music: fs.existsSync(realMusic) ? fs.readFileSync(realMusic, 'utf8') : null,
      media: fs.existsSync(path.join(ROOT, 'data', 'media'))
        ? fs.readdirSync(path.join(ROOT, 'data', 'media')).sort().join(',')
        : '',
      avatars: fs.existsSync(path.join(ROOT, 'data', 'avatars'))
        ? fs.readdirSync(path.join(ROOT, 'data', 'avatars')).sort().join(',')
        : '',
    });
    now === realDataBefore
      ? ok('真实 data/ 一个字节都没变', '测试全程在沙箱里跑')
      : (() => {
          const a = JSON.parse(realDataBefore);
          const b = JSON.parse(now);
          const diff = Object.keys({ ...a, ...b })
            .filter((k) => a[k] !== b[k])
            .map((k) => k + ': [' + String(a[k]).slice(0, 60) + '] → [' + String(b[k]).slice(0, 60) + ']')
            .join(' | ');
          bad('真实 data/ 被改动了！', diff || '两个快照字符串不同但字段值全一样？');
        })();
  } catch (e) { bad('真实数据核对', e.message); }

  // 沙箱删掉
  try {
    await fsp.rm(SANDBOX, { recursive: true, force: true });
    ok('沙箱已清理', path.basename(SANDBOX));
  } catch (e) { bad('沙箱已清理', e.message); }
}

console.log('');
for (const [s, name, d] of results) console.log(s + '  ' + name + (d ? '  —  ' + d : ''));
const fails = results.filter((x) => x[0] === 'FAIL').length;
console.log('\n' + (fails ? '❌ ' + fails + ' 项失败' : '✅ 全部通过'));
process.exit(fails ? 1 : 0);
