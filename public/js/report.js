// 恋爱年报：把这一年的足迹画成一张长图，一键下载。
// 纯 canvas 手绘 —— 不引图表库，颜色直接从当前主题的 CSS 变量里读，
// 白天是粉的、夜里是暗的，跟页面一个气质。
import { openModal, toast, isImage, today, daysBetween, ic } from './ui.js';
import { haversine } from './projection.js';

const W = 750;                       // 长图宽度：微信里竖着看刚好
const PAD = 46;                      // 左右留白
const FONT = '"PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", "Source Han Sans SC", sans-serif';

/* ---------------- 主题色（跟着页面走） ---------------- */
function palette() {
  const cs = getComputedStyle(document.body);
  const v = (name, fallback) => {
    const s = (cs.getPropertyValue(name) || '').trim();
    return s || fallback;
  };
  return {
    bg: v('--surface-solid', '#fffafc'),
    text: v('--text', '#2a1020'),
    soft: v('--text-soft', '#8a5570'),
    faint: v('--text-faint', '#a67a95'),
    a: v('--accent-a', '#ff8fb8'),
    b: v('--accent-b', '#ff5f9e'),
    c: v('--accent-c', '#e8578f'),
    rose50: v('--rose-50', '#fff7fa'),
    rose100: v('--rose-100', '#ffeaf2'),
    rose200: v('--rose-200', '#ffd8e7'),
    rose700: v('--rose-700', '#cf3a76'),
  };
}

/* ---------------- 小工具 ---------------- */
function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function bubble(ctx, x, y, w, h, fill) {
  roundRect(ctx, x, y, w, h, 18);
  ctx.fillStyle = fill;
  ctx.fill();
}

function label(ctx, text, x, y, size, color, weight = 400, align = 'left') {
  ctx.font = weight + ' ' + size + 'px ' + FONT;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, x, y);
}

/** 竖着裁切填满一格：宽高比不合适就裁边上，不拉变形 */
function drawCover(ctx, img, x, y, w, h) {
  const ir = img.width / img.height;
  const br = w / h;
  let sx = 0, sy = 0, sw = img.width, sh = img.height;
  if (ir > br) { sw = img.height * br; sx = (img.width - sw) / 2; }
  else { sh = img.width / br; sy = (img.height - sh) / 2; }
  ctx.save();
  roundRect(ctx, x, y, w, h, 16);
  ctx.clip();
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
  ctx.restore();
}

function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/* ---------------- 这一年的统计 ---------------- */
function yearRecords(state, year) {
  return (state.records || []).filter((r) => r.date && String(r.date).slice(0, 4) === String(year));
}

function summarize(state, year) {
  const recs = yearRecords(state, year);
  const prov = new Map(), city = new Map();
  let photos = 0, videos = 0, km = 0;
  const byMonth = new Array(12).fill(0);
  const mood = new Map();
  const pts = [];

  for (const r of recs) {
    const names = Array.isArray(r.names) ? r.names : [];
    if (names[0]) prov.set(names[0], (prov.get(names[0]) || 0) + 1);
    if (names[1]) city.set(names[1], (city.get(names[1]) || 0) + 1);
    else if (names[2]) city.set(names[2], (city.get(names[2]) || 0) + 1);

    const mo = Number(String(r.date).slice(5, 7));
    if (mo >= 1 && mo <= 12) byMonth[mo - 1]++;

    if (r.mood) mood.set(r.mood, (mood.get(r.mood) || 0) + 1);
    for (const m of r.media || []) {
      if (isImage(m.type)) photos++;
      else if (String(m.type || '').startsWith('video/')) videos++;
    }
    pts.push({ ll: Array.isArray(r.lnglat) ? r.lnglat : null, date: r.date });
  }

  // 今年走过的路：按日期把钉过的点连起来量一遍
  pts.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1].ll, b = pts[i].ll;
    if (!Array.isArray(a) || !Array.isArray(b)) continue;
    const d = haversine(a, b);
    if (Number.isFinite(d)) km += d;
  }

  const topOf = (m, n) => Array.from(m.entries()).sort((x, y) => y[1] - x[1]).slice(0, n);

  return {
    recs, photos, videos, km: Math.round(km),
    provinces: prov.size, cities: city.size,
    byMonth,
    bestMood: topOf(mood, 1)[0] || null,
    topProv: topOf(prov, 4),
    topCity: topOf(city, 4),
  };
}

/** 这一年照片最多 / 最近的回忆里挑九张 */
function pickPhotos(recs, max = 9) {
  const out = [];
  const sorted = recs.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
  for (const r of sorted) {
    const img = (r.media || []).find((m) => isImage(m.type));
    if (img && img.url) out.push(img);
    if (out.length >= max) break;
  }
  return out;
}

/* ---------------- 画 ---------------- */
async function drawReport(canvas, state, year) {
  const P = palette();
  const s = summarize(state, year);
  const start = (state.settings && state.settings.startDate) || '';
  const names = (state.settings && state.settings.coupleNames) || ['我', '你'];
  const motto = (state.settings && state.settings.motto) || '把每一次心动，都钉在地图上。';
  const days = start ? daysBetween(start, today()) : null;

  // 先把九张图拉下来再开画，免得画到一半图才蹦出来
  const photos = pickPhotos(s.recs);
  const imgs = await Promise.all(photos.map((p) => loadImage(p.url)));
  const goodImgs = imgs.filter(Boolean).slice(0, 9);

  const ctx = canvas.getContext('2d');
  const X = PAD;
  const CW = W - PAD * 2;

  // 排版尺寸先量清楚再定画布高度 —— canvas 不能「画完再往回收」，
  // 估少了照片会戳到落款上，估多了底下空一截
  const placeRows = (s.topProv.length ? s.topProv : s.topCity).slice(0, 4);
  const photoCols = 3;
  const photoG = 12;
  const photoCell = (CW - photoG * (photoCols - 1)) / photoCols;
  const photoRows = Math.ceil(goodImgs.length / photoCols);

  const H_HEADER = 258;
  const H_STATS = 34 + 26 + 84 + 34;
  const H_PLACES = placeRows.length ? 24 + placeRows.length * 32 + 30 : 0;
  const H_MONTH = 30 + 96 + 48;
  const H_PHOTOS = goodImgs.length ? 22 + photoRows * (photoCell + photoG) + 30 : 0;
  const H_FOOT = 110;
  const H = H_HEADER + H_STATS + H_PLACES + H_MONTH + H_PHOTOS + H_FOOT;

  canvas.width = W;
  canvas.height = H;

  // 纸底
  ctx.fillStyle = P.bg;
  ctx.fillRect(0, 0, W, H);

  /* ---- 抬头：一整块粉渐变 ---- */
  const grad = ctx.createLinearGradient(0, 0, W, H_HEADER);
  grad.addColorStop(0, P.a);
  grad.addColorStop(0.55, P.b);
  grad.addColorStop(1, P.c);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H_HEADER);

  // 抬头里点几颗柔光球，跟页面的粉雾一个手法
  for (const [cx, cy, r, al] of [[110, 60, 120, 0.16], [640, 180, 150, 0.14], [420, -20, 110, 0.12]]) {
    const g2 = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g2.addColorStop(0, 'rgba(255,255,255,' + al + ')');
    g2.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g2;
    ctx.fillRect(0, 0, W, H_HEADER);
  }

  label(ctx, '♥', W / 2, 88, 30, '#fff', 700, 'center');
  label(ctx, '恋 爱 年 报', W / 2, 138, 40, '#fff', 800, 'center');
  label(ctx, String(year), W / 2, 186, 22, 'rgba(255,255,255,.88)', 600, 'center');
  label(ctx, names[0] + ' 和 ' + names[1], W / 2, 224, 17, 'rgba(255,255,255,.92)', 600, 'center');
  if (days != null) {
    label(ctx, '在一起的第 ' + days + ' 天', W / 2, 248, 13, 'rgba(255,255,255,.78)', 400, 'center');
  }

  let y = H_HEADER;

  /* ---- 今年数得出来的那些 ---- */
  const stats = [
    [s.recs.length, '段回忆'],
    [s.provinces, '个省'],
    [s.cities, '个市'],
    [s.photos, '张照片'],
    [s.km, '公里'],
  ];
  y += 34;
  label(ctx, '这一年，我们一起', X, y, 20, P.text, 800);
  y += 26;

  const gap = 10;
  const cellW = (CW - gap * (stats.length - 1)) / stats.length;
  const cellH = 84;
  stats.forEach(([n, lab], i) => {
    const cx = X + i * (cellW + gap);
    bubble(ctx, cx, y, cellW, cellH, P.rose100);
    label(ctx, String(n), cx + cellW / 2, y + 46, 26, P.rose700, 800, 'center');
    label(ctx, lab, cx + cellW / 2, y + 70, 12, P.soft, 400, 'center');
  });
  y += cellH + 34;

  /* ---- 走得最多的地方 ---- */
  if (H_PLACES) {
    label(ctx, '最常去的地方', X, y, 20, P.text, 800);
    y += 24;
    const rows = placeRows;
    const max = Math.max(1, ...rows.map((r) => r[1]));
    rows.forEach(([name, n], i) => {
      const ry = y + i * 32;
      label(ctx, name, X, ry + 12, 14, P.soft, 600);
      const barX = X + 190;
      const barW = CW - 190 - 56;
      bubble(ctx, barX, ry, barW, 16, P.rose50);
      const g3 = ctx.createLinearGradient(barX, 0, barX + barW, 0);
      g3.addColorStop(0, P.a);
      g3.addColorStop(1, P.c);
      roundRect(ctx, barX, ry, Math.max(10, barW * (n / max)), 16, 8);
      ctx.fillStyle = g3;
      ctx.fill();
      label(ctx, n + ' 次', W - PAD, ry + 12, 12, P.faint, 600, 'right');
    });
    y += rows.length * 32 + 30;
  }

  /* ---- 一年的脚印（按月） ---- */
  label(ctx, '每个月的心动', X, y, 20, P.text, 800);
  y += 30;
  const chartH = 96;
  const bw = (CW - 11 * 6) / 12;
  const maxM = Math.max(1, ...s.byMonth);
  s.byMonth.forEach((n, i) => {
    const bx = X + i * (bw + 6);
    const h = Math.max(4, chartH * (n / maxM));
    const g4 = ctx.createLinearGradient(0, y + chartH - h, 0, y + chartH);
    g4.addColorStop(0, P.b);
    g4.addColorStop(1, P.rose200);
    roundRect(ctx, bx, y + chartH - h, bw, h, 6);
    ctx.fillStyle = g4;
    ctx.fill();
    label(ctx, String(i + 1), bx + bw / 2, y + chartH + 18, 11, P.faint, 400, 'center');
    if (n) label(ctx, String(n), bx + bw / 2, y + chartH - h - 6, 10, P.soft, 600, 'center');
  });
  y += chartH + 48;

  /* ---- 九宫格照片 ---- */
  if (goodImgs.length) {
    label(ctx, '今年的高光时刻', X, y, 20, P.text, 800);
    y += 22;
    goodImgs.forEach((img, i) => {
      const gx = X + (i % photoCols) * (photoCell + photoG);
      const gy = y + Math.floor(i / photoCols) * (photoCell + photoG);
      // 白边垫一层，照片像贴上去的
      bubble(ctx, gx - 3, gy - 3, photoCell + 6, photoCell + 6, '#fff');
      drawCover(ctx, img, gx, gy, photoCell, photoCell);
    });
    y += photoRows * (photoCell + photoG) + 30;
  }

  /* ---- 落款 ---- */
  label(ctx, '「' + motto + '」', W / 2, y + 8, 16, P.soft, 600, 'center');
  if (s.bestMood) {
    label(ctx, '这一年最常出现的心情是 ' + s.bestMood[0], W / 2, y + 38, 13, P.faint, 400, 'center');
  }
  label(ctx, '由「我们的足迹」生成 · ' + today(), W / 2, y + 72, 11, P.faint, 400, 'center');

  return s;
}

/* ---------------- 入口：挑年份 → 预览 → 下载 ---------------- */
export function openReport({ state }) {
  const years = new Set();
  const thisYear = String(today()).slice(0, 4);
  for (const r of state.records || []) {
    if (r.date) years.add(String(r.date).slice(0, 4));
  }
  years.add(thisYear);
  const list = Array.from(years).sort((a, b) => b.localeCompare(a));
  let year = list[0];

  const handle = openModal({
    title: '恋爱年报',
    bodyHTML:
      '<div class="rep-bar">' +
        '<div class="rep-years" id="repYears"></div>' +
        '<span class="rep-tip">竖着截成一张长图，发给谁都好看</span>' +
      '</div>' +
      '<div class="rep-preview"><canvas id="repCanvas"></canvas></div>',
    footerHTML: '<button class="btn" data-cancel>关闭</button><button class="btn primary" id="repDown">' + ic('download') + ' 下载 PNG</button>',
    onClose: () => { /* canvas 是自绘的，没有全局状态要清 */ },
  });

  const q = (sel) => handle.el.querySelector(sel);
  const canvas = q('#repCanvas');
  let busy = false;

  function renderYears() {
    q('#repYears').innerHTML = list.map((yy) =>
      '<button class="rep-year' + (yy === year ? ' on' : '') + '" data-y="' + yy + '">' + yy + '</button>'
    ).join('');
    q('#repYears').querySelectorAll('.rep-year').forEach((b) => {
      b.addEventListener('click', () => {
        if (b.dataset.y === year) return;
        year = b.dataset.y;
        renderYears();
        run();
      });
    });
  }

  async function run() {
    if (busy) return;
    busy = true;
    q('#repDown').disabled = true;
    try {
      await drawReport(canvas, state, year);
    } catch (e) {
      console.error(e);
      toast('画年报的时候卡住了：' + e.message, 'bad');
    } finally {
      busy = false;
      q('#repDown').disabled = false;
    }
  }

  q('[data-cancel]').addEventListener('click', handle.close);
  q('#repDown').addEventListener('click', () => {
    if (busy) return;
    canvas.toBlob((blob) => {
      if (!blob) { toast('导出失败了', 'bad'); return; }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = '恋爱年报-' + year + '.png';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast('年报下好了 · 恋爱年报-' + year + '.png');
    }, 'image/png');
  });

  renderYears();
  run();
}
