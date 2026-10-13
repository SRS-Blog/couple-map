// 入口：把地图、面板、回忆墙、统计串起来
import { loadState, saveState, loadAvatars, uploadAvatar, deleteAvatar } from './api.js';
import { createMapView } from './map.js';
import { createPanel } from './panel.js';
import { createReplay } from './replay.js';
import { createMusicPlayer } from './music.js';
import { openGallery, openSettings } from './gallery.js';
import { openReport } from './report.js';
import { featureLngLat, haversine } from './projection.js';
import {
  $, ic, toast, escapeHtml, today, fmtDate, daysBetween, pickRandom,
  startHeartRain, startQuoteRotation, isImage, isVideo,
} from './ui.js';

const state = {
  settings: { coupleNames: ['我', '你'], startDate: '', theme: 'rose', motto: '' },
  records: [],
};

let map = null;
let panel = null;
let replay = null;
let hintShown = true;

/* ---------------- 主题 ---------------- */
function applyTheme() {
  const night = state.settings.theme === 'night';
  document.body.dataset.theme = night ? 'night' : 'rose';
  // 按钮是 <svg><use id="themeUse">，换 href 就换形状，不用整颗按钮重画
  const use = document.getElementById('themeUse');
  if (use) use.setAttribute('href', night ? '#ic-sun' : '#ic-moon');
  // 手机浏览器那圈跟主题走：地址栏 / 状态栏底色换掉，别页面黑了上头还是白天的。
  // 颜色取自 --bg-base（两个主题的底色），桌面端没有浏览器外壳，写了也无感
  const meta = document.getElementById('themeColor');
  if (meta) meta.setAttribute('content', night ? '#1a0d16' : '#fff6f9');
}

function toggleTheme() {
  state.settings.theme = state.settings.theme === 'night' ? 'rose' : 'night';
  applyTheme();
  saveState(state).catch(() => {});
}

/* ---------------- 品牌区 ---------------- */
function applyBranding() {
  const [a, b] = state.settings.coupleNames || ['我', '你'];
  $('#coupleTitle').textContent = a + ' 和 ' + b + ' 的足迹';
  $('#motto').textContent = state.settings.motto || '把每一次心动，都钉在地图上。';
  document.title = a + ' 和 ' + b + ' 的足迹';
}

/* ---------------- 纪念日倒数 ----------------
   接下来值得倒数的日子，全折算成「哪一天」好排先后：
   整百天、520 / 1314 这种有含意的天数、每个周年，外加设置里自己记的。
   每条带 from/span —— 进度条从上一站那天走到这一站 */
const DAY_MARKS = [100, 200, 300, 400, 500, 520, 600, 700, 800, 900, 1000, 1314, 1500, 2000, 2500, 3000, 4000, 5000];
const CN_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

function ymd(d) {
  const p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function yearLabel(n) {
  return n <= 10 ? CN_NUM[n] + '周年' : n + ' 周年';
}

function upcomingMilestones(settings, todayStr) {
  const start = settings && settings.startDate;
  if (!start) return [];

  const all = [{ label: '在一起', date: start, kind: 'start' }];
  for (const n of DAY_MARKS) {
    const d = new Date(start + 'T00:00:00');
    if (!Number.isFinite(d.getTime())) return [];
    d.setDate(d.getDate() + n);
    all.push({ label: n + ' 天', date: ymd(d), kind: 'days' });
  }
  const y0 = new Date(start + 'T00:00:00');
  for (let n = 1; n <= 30; n++) {
    const d = new Date(y0);
    d.setFullYear(d.getFullYear() + n);
    all.push({ label: yearLabel(n), date: ymd(d), kind: 'year' });
  }
  for (const a of settings.anniversaries || []) {
    if (a && a.date) all.push({ label: a.name || '纪念日', date: a.date, kind: 'custom' });
  }

  all.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const out = [];
  for (let i = 0; i < all.length; i++) {
    const left = daysBetween(todayStr, all[i].date);
    if (!Number.isFinite(left) || left < 0) continue; // 日期坏了就别拿出来吓人
    out.push(Object.assign({}, all[i], { left, from: i > 0 ? all[i - 1].date : start }));
  }
  return out; // 已按日期升序，第一条就是「下一站」
}

/** 卡片上的「下一站」条：还差几天 + 走到哪了 + 后面两站 */
function renderNext() {
  const list = upcomingMilestones(state.settings, today());
  if (!list.length) return '';
  const m = list[0];
  const span = Math.max(1, daysBetween(m.from, m.date) || 1);
  const gone = Math.max(0, Math.min(span, daysBetween(m.from, today()) || 0));
  const pct = Math.round((gone / span) * 100);

  const chips = list.slice(1, 3).map((x) =>
    '<span class="tn-chip">' + escapeHtml(x.label) + ' <em>' + escapeHtml(fmtDate(x.date)) + '</em></span>'
  ).join('');

  return '<div class="to-next">' +
    '<div class="tn-head"><i>⏳</i><span>下一站</span></div>' +
    '<div class="tn-row"><b>' + escapeHtml(m.label) + '</b>' +
      '<span>' + (m.left === 0 ? '就是今天 ❤' : '还有 <em>' + m.left + '</em> 天') + '</span></div>' +
    '<div class="tn-bar"><i style="width:' + pct + '%"></i></div>' +
    (chips ? '<div class="tn-chips">' + chips + '</div>' : '') +
  '</div>';
}

/* ---------------- 统计 ---------------- */
function lngLatOf(r) {
  if (Array.isArray(r.lnglat) && r.lnglat.length === 2 && Number.isFinite(r.lnglat[0])) return r.lnglat;
  const f = map && map.findFeature(r.adcode);
  return f ? featureLngLat(f) : null;
}

function computeStats() {
  const recs = state.records;
  const prov = new Set(), city = new Set(), dist = new Set();
  let photos = 0, videos = 0;
  for (const r of recs) {
    const p = Array.isArray(r.path) && r.path.length ? r.path : [r.adcode];
    if (p[0]) prov.add(p[0]);
    if (p[1]) city.add(p[1]);
    if (p[2]) dist.add(p[2]);
    for (const m of r.media || []) {
      if (isImage(m.type)) photos++;
      else if (isVideo(m.type)) videos++;
    }
  }

  // 按日期排好序，把相邻两段回忆之间的直线距离加起来，图个乐
  const pts = recs
    .map((r) => ({ ll: lngLatOf(r), date: r.date || '' }))
    .filter((x) => x.ll)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  let km = 0;
  for (let i = 1; i < pts.length; i++) km += haversine(pts[i - 1].ll, pts[i].ll);

  const days = state.settings.startDate ? daysBetween(state.settings.startDate, today()) : null;

  return {
    days, provinces: prov.size, cities: city.size, districts: dist.size,
    records: recs.length, photos, videos, km: Math.round(km),
  };
}

function renderStats() {
  const s = computeStats();
  const box = $('#toBody');

  // 手机上默认只露一枚天数徽章，点开才见完整卡 —— 徽章上的数字跟卡里同源
  const tb = $('#tbText');
  if (tb) {
    tb.innerHTML = s.days == null
      ? '<em>定个纪念日</em>'
      : '<em>在一起</em><b>' + s.days + '</b><em>天</em>';
  }

  if (!box) return;

  // 纪念日还没定：别摆个空壳，给个入口
  if (s.days == null) {
    box.innerHTML =
      '<div class="to-eyebrow"><i class="to-heart">' + ic('heart') + '</i>在一起的日子</div>' +
      '<div class="to-blank">去右上角 <b>设置</b> 里填上你们<br>在一起的第一天，这里就开始<br>替你们数日子啦</div>';
    return;
  }

  const km = s.km >= 1000 ? (s.km / 1000).toFixed(1) + 'k' : s.km;
  const hero =
    '<div class="to-eyebrow"><i class="to-heart">' + ic('heart') + '</i>在一起</div>' +
    '<div class="to-hero"><b>' + s.days + '</b><em>天</em></div>' +
    '<div class="to-since">从 ' + fmtDate(state.settings.startDate) + ' 起</div>';

  if (!s.records) {
    box.innerHTML = hero + renderNext() + '<div class="to-blank">还没写下回忆<br>点地图上任意一块地方，开始吧</div>';
    return;
  }

  const cells = [
    [s.provinces, '省'],
    [s.cities, '市'],
    [s.districts, '区县'],
    [s.records, '回忆'],
    [s.photos, '照片'],
    [km, '公里'],
  ].map(([n, label]) => '<div class="to-cell"><b>' + n + '</b><span>' + label + '</span></div>').join('');

  box.innerHTML = hero + '<div class="to-grid">' + cells + '</div>' + renderNext();
}

/* ---------------- 头像对 ----------------
   两张方照片斜插在纪念卡顶边上，一左一右，中间一颗心。
   点一下换图，hover 才露 ✕ —— 平时别拿按钮的样子吓人 */
let avatarUrls = ['', ''];
let avatarSlot = 0;

function renderAvatars() {
  const box = $('#avatarPair');
  if (!box) return;
  const names = state.settings.coupleNames || ['我', '你'];

  box.innerHTML = [0, 1].map((i) => {
    const url = avatarUrls[i];
    const nm = escapeHtml(names[i] || (i ? 'TA' : '我'));
    return '<button type="button" class="av av' + i + (url ? ' has' : '') + '" data-slot="' + i + '"' +
      ' title="' + (url ? '点我换照片' : '点我上传照片') + '">' +
      (url
        ? '<img src="' + url + '" alt="' + nm + '">'
        : '<span class="av-empty"><i>' + ic('camera') + '</i><em>传张照片</em></span>') +
      '<span class="av-name">' + nm + '</span>' +
      (url ? '<span class="av-del" data-del="' + i + '" title="移除这张">' + ic('x') + '</span>' : '') +
      '</button>';
  }).join('') + '<i class="av-heart" aria-hidden="true">' + ic('heart') + '</i>';

  // 徽章上那两枚只是缩略图，不带上传 / 删除 —— 要换照片得点开完整卡
  const tb = $('#tbPair');
  if (tb) {
    tb.innerHTML = [0, 1].map((i) =>
      '<span class="tb-av tb' + i + (avatarUrls[i] ? '' : ' empty') + '">' +
      (avatarUrls[i] ? '<img src="' + avatarUrls[i] + '" alt="">' : '') +
      '</span>'
    ).join('');
  }

  box.querySelectorAll('.av').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const del = e.target.closest('[data-del]');
      if (del) {
        e.stopPropagation();
        removeAvatar(Number(del.dataset.del));
        return;
      }
      avatarSlot = Number(btn.dataset.slot);
      const input = $('#avatarInput');
      input.value = '';
      input.click();
    });
  });
}

async function onAvatarFile(e) {
  const input = e.target;
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) { toast('头像只收图片哦', 'bad'); return; }

  try {
    const r = await uploadAvatar(avatarSlot, file);
    avatarUrls[avatarSlot] = r.url;
    renderAvatars();
    toast(avatarSlot ? 'TA 的照片放好啦' : '你的照片放好啦');
  } catch (err) {
    toast('头像没传上去：' + err.message, 'bad');
  }
}

async function removeAvatar(slot) {
  try {
    await deleteAvatar(slot);
    avatarUrls[slot] = '';
    renderAvatars();
    toast('照片取下来了');
  } catch (err) {
    toast('移除失败：' + err.message, 'bad');
  }
}

async function loadAvatarPair() {
  try {
    const data = await loadAvatars();
    avatarUrls = (data.avatars || []).map((x) => x.url || '');
    if (avatarUrls.length < 2) avatarUrls = ['', ''];
  } catch {
    avatarUrls = ['', ''];
  }
  renderAvatars();
}

/* ---------------- 面包屑 ---------------- */
function renderCrumbs(ctx) {
  const box = $('#crumbs');
  const stack = ctx.stack || [{ adcode: '100000', name: '中国' }];
  box.innerHTML = stack
    .map((s, i) => {
      const last = i === stack.length - 1;
      return (i ? '<span class="crumb-sep">›</span>' : '') +
        '<button class="crumb' + (last ? ' current' : '') + '" data-i="' + i + '">' +
        escapeHtml(s.name || (i === 0 ? '中国' : '—')) + '</button>';
    })
    .join('');

  box.querySelectorAll('.crumb').forEach((b) => {
    b.addEventListener('click', async () => {
      const i = Number(b.dataset.i);
      if (i === stack.length - 1) return;
      if (panel) panel.close();
      await map.goToLevel(i);
    });
  });
}

/* ---------------- 点击地图 ---------------- */
async function onRegionClick(region) {
  hideHint();
  map.hideTip();

  // 点到比当前层浅的另一块（在深圳市里点广州市 / 在市里点别的省）：
  // 不要「先退回上一级、再钻进来」两段动画，一次飞过去
  if (region.layer < map.getLevel()) {
    const drilled = await map.jumpTo(region);
    if (drilled) return;
    // 那块没有更细的数据，镜头已经对准它了，直接当成一个地点来记录
    panel.open(region, null);
    return;
  }

  if (region.hasChildren && map.getLevel() < 2) {
    const ok = await map.drillInto(region.adcode, region.name);
    if (ok) return;
    // 没有更细的数据，就直接当成一个地点来记录
  }
  panel.open(region, null);
}

function onRegionDblClick(region) {
  hideHint();
  map.hideTip();
  panel.open(region, null);
}

function hideHint() {
  if (!hintShown) return;
  hintShown = false;
  const h = $('#mapHint');
  if (h) h.classList.add('hide');
}

/* ---------------- 面板回调 ---------------- */
// 面板退场要滑走 480ms（.panel 的 --m-page）。点亮动画等它走完再放 ——
// 尤其手机上抽屉占了大半屏，不然「亮起来」那下正好被自己刚关掉的面板挡着
const PANEL_CLOSE_MS = 480;

function onPanelChange(evt) {
  // 数字先跟上：面板退场那半秒里，徽章 / 纪念卡别还挂着旧的
  renderStats();

  if (evt.type !== 'save') {
    map.setRecords(state.records);
    return;
  }

  const path = evt.record.path || [evt.record.adcode];
  // 在当前这一层找这块区域爆爱心；如果它不在当前层（比如刚用「更改」换到了别的区县），
  // celebrate 会退回在屏幕中央爆一下，不至于毫无反馈
  const target = path[path.length - 1];

  panel.close();
  setTimeout(() => {
    map.setRecords(state.records); // 这时才把区域染亮
    map.celebrate(target);         // 闪一下 + 爆爱心
    if (evt.isNew) setTimeout(() => map.celebrate(target), 700);
  }, PANEL_CLOSE_MS);
}

/* ---------------- 缩放滑条同步 ---------------- */
function syncZoomUI(percent) {
  const v = Math.round(percent);
  const range = $('#zoomRange');
  const pct = $('#zoomPct');
  const bar = $('#zoomBar');
  if (range && Number(range.value) !== v) range.value = String(v);
  if (pct) pct.textContent = v + '%';
  if (bar) bar.style.setProperty('--pct', v + '%');
}

/* ---------------- 按钮 ---------------- */
function wireButtons() {
  $('#btnTheme').addEventListener('click', toggleTheme);

  /* 「更多」菜单：只在 ≤1000px 出现，把顶栏那 4 个文字按钮收进去。
     桌面上 .more-menu 是 display:contents，里面 4 个按钮照样当 flex 子项排开，
     所以下面这套开合逻辑在桌面是空转，无害。 */
  (function wireMore() {
    const btn = $('#btnMore');
    const menu = $('#moreMenu');
    if (!btn || !menu) return;

    const setOpen = (open) => {
      menu.classList.toggle('open', open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    const isOpen = () => menu.classList.contains('open');

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      setOpen(!isOpen());
    });

    // 点了菜单里任何一项就收起来
    menu.addEventListener('click', () => setOpen(false));

    // 点外面 / 按 Esc 收起来
    document.addEventListener('click', (e) => {
      if (isOpen() && !menu.contains(e.target) && e.target !== btn) setOpen(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isOpen()) { setOpen(false); btn.focus(); }
    });
  })();

  $('#btnReplay').addEventListener('click', () => {
    if (replay.isOpen()) { replay.stop(); return; }
    if (panel) panel.close();
    replay.start();
  });

  $('#btnReport').addEventListener('click', () => {
    if (replay && replay.isOpen()) replay.stop();
    openReport({ state });
  });

  // 头像：点方框 → 弹系统选图 → 直接落盘
  $('#avatarInput').addEventListener('change', onAvatarFile);

  $('#btnSettings').addEventListener('click', () => {
    openSettings({
      state,
      onChanged: () => {
        applyBranding();
        applyTheme();
        renderStats();
        renderAvatars(); // 名字改了，头像下面的小名签也要跟着变
        map.setRecords(state.records);
      },
    });
  });

  $('#btnGallery').addEventListener('click', () => {
    openGallery({
      state,
      onOpenRecord: (r) => {
        const path = Array.isArray(r.path) && r.path.length ? r.path : [r.adcode];
        const names = Array.isArray(r.names) ? r.names : [];
        map.locate(path).then(() => {
          panel.open({
            adcode: r.adcode,
            name: names[names.length - 1] || '',
            path: path.map((ad, i) => ({ adcode: ad, name: names[i] || '' })),
            lnglat: r.lnglat || null,
          }, r);
        });
      },
      onChanged: () => {
        renderStats();
        map.setRecords(state.records);
      },
    });
  });

  $('#btnRandom').addEventListener('click', async () => {
    if (!state.records.length) {
      toast('还没有回忆可以漫游，先去点亮一个地方吧', 'bad');
      return;
    }
    const r = pickRandom(state.records);
    const path = Array.isArray(r.path) && r.path.length ? r.path : [r.adcode];
    const names = Array.isArray(r.names) ? r.names : [];
    toast('带你回到「' + (r.title || names[names.length - 1] || '那段回忆') + '」');
    await map.locate(path);
    panel.open({
      adcode: r.adcode,
      name: names[names.length - 1] || '',
      path: path.map((ad, i) => ({ adcode: ad, name: names[i] || '' })),
      lnglat: r.lnglat || null,
    }, r);
  });

  // 缩放滑条：拖动时直接设缩放；滚轮 / 钻取改变视图时反向同步到滑条
  const zoomRange = $('#zoomRange');
  zoomRange.addEventListener('input', () => map.setZoomPercent(Number(zoomRange.value)));

  $('#btnReset').addEventListener('click', async () => {
    panel.close();
    await map.resetAll();
  });

  // 手机上纪念卡收成天数徽章：点徽章展开，点 ✕ 或点卡片以外的地方收起
  {
    const card = $('#togetherCard');
    const badge = $('#toBadge');
    const closeBtn = $('#toClose');
    if (card && badge) {
      const setCardOpen = (open) => {
        card.classList.toggle('open', open);
        document.body.classList.toggle('to-open', open);
      };
      badge.addEventListener('click', () => setCardOpen(!card.classList.contains('open')));
      if (closeBtn) closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        setCardOpen(false);
      });
      document.addEventListener('pointerdown', (e) => {
        if (!card.classList.contains('open')) return;
        const t = e.target;
        if (t && t.closest && t.closest('#togetherCard, #toBadge')) return;
        setCardOpen(false);
      });
    }
  }

  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
    // 回放自己管 ←/→/空格/Esc，这时候别让「回忆漫游」的快捷键抢戏
    if (replay && replay.isOpen()) {
      if (!typing) replay.handleKey(e);
      return;
    }
    if (e.key === 'Escape' && panel.isOpen() && !typing) panel.close();
    if (typing) return;
    if (e.key === 'r' || e.key === 'R') $('#btnRandom').click();
    if (e.key === 'g' || e.key === 'G') $('#btnGallery').click();
    if (e.key === 'f' || e.key === 'F') $('#btnReplay').click();
  });

  // 面板关闭时收起选中态
  $('#panel').addEventListener('click', (e) => { if (e.target.id === 'pClose') map.hideTip(); });
}

/* ---------------- 启动 ---------------- */
async function boot() {
  startHeartRain($('#heartRain'), 16);

  try {
    const loaded = await loadState();
    state.settings = Object.assign(
      { coupleNames: ['我', '你'], startDate: '', theme: 'rose', motto: '把每一次心动，都钉在地图上。', anniversaries: [] },
      loaded.settings || {},
    );
    if (!Array.isArray(state.settings.anniversaries)) state.settings.anniversaries = [];
    state.records = Array.isArray(loaded.records) ? loaded.records : [];
  } catch (e) {
    toast('读不到数据，服务是不是没启动？', 'bad', 6000);
  }

  applyTheme();
  applyBranding();
  startQuoteRotation($('#motto'), 11000);

  map = createMapView({
    svg: $('#map'),
    onRegionClick,
    onRegionDblClick,
    onLevelChange: renderCrumbs,
    onZoomChange: (z) => syncZoomUI(z.percent),
  });

  try {
    await map.init();
  } catch (e) {
    $('#mapLoading').innerHTML = '<em>地图数据没找到。先运行 <b>node tools/fetch-geo.mjs</b> 下载一次。</em>';
    console.error(e);
    return;
  }

  map.setRecords(state.records);

  // 播放器要先建：面板里挑 BGM、点开回忆放歌都用得上它
  const player = createMusicPlayer({ mountEl: $('#playerMount') });
  player.init().catch((e) => console.warn('音乐播放器没起来：', e));

  panel = createPanel({
    panelEl: $('#panel'),
    getState: () => state,
    onChange: onPanelChange,
    player,
  });

  replay = createReplay({
    mountEl: $('#mapWrap'),
    map,
    player,
    getState: () => state,
  });

  wireButtons();
  renderStats();
  loadAvatarPair();
  $('#mapLoading').classList.add('hide');
  setTimeout(() => { $('#mapLoading').style.display = 'none'; }, 500);
}

boot();
