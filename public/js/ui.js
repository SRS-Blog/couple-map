// 共享 UI 小件：toast、弹窗、大图查看器、地区选择器、爱心特效、工具函数

/* ---------------- 基础工具 ---------------- */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function uid(prefix = 'id') {
  return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export const pickRandom = (arr) => (arr && arr.length ? arr[Math.floor(Math.random() * arr.length)] : null);

/** 取一个图标。形状在 index.html 的 SVG sprite 里，颜色走 currentColor，
 *  跟着所在位置的文字颜色走 —— 要换色改那一处的 color 就行。
 *  extra 可以加 'lg'（空状态插画）之类的修饰类。 */
export const ic = (name, extra = '') =>
  '<svg class="ic' + (extra ? ' ' + extra : '') + '" aria-hidden="true"><use href="#ic-' + name + '"></use></svg>';

export const fmtSize = (b) => {
  if (!Number.isFinite(b)) return '';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(0) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
};

/** '2024-06-01' → '2024年6月1日' */
export function fmtDate(str) {
  if (!str) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(str));
  if (!m) return String(str);
  return m[1] + '年' + Number(m[2]) + '月' + Number(m[3]) + '日';
}

/** 两个日期之间相差的天数（b - a） */
export function daysBetween(a, b) {
  const t1 = new Date(a).getTime();
  const t2 = new Date(b).getTime();
  if (!Number.isFinite(t1) || !Number.isFinite(t2)) return null;
  return Math.floor((t2 - t1) / 86400000);
}

export const today = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
};

export const isImage = (t) => /^image\//.test(t || '');
export const isVideo = (t) => /^video\//.test(t || '');

/* ---------------- Toast ---------------- */

const toastBox = document.getElementById('toasts');

export function toast(msg, kind = 'good', ms = 2400) {
  if (!toastBox) return;
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.innerHTML = ic(kind === 'bad' ? 'warn' : kind === 'good' ? 'heart' : 'bubble') +
    '<span>' + escapeHtml(msg) + '</span>';
  toastBox.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 320);
  }, ms);
}

/* ---------------- 弹窗 ---------------- */

const overlay = document.getElementById('overlay');
let currentClose = null;

function onOverlayClick(e) {
  if (e.target === overlay && currentClose) currentClose();
}
function onOverlayKey(e) {
  if (e.key === 'Escape' && currentClose) currentClose();
}
overlay.addEventListener('click', onOverlayClick);
document.addEventListener('keydown', onOverlayKey);

/**
 * 打开一个弹窗。
 * 返回 { el, body, close }
 */
export function openModal({ title, bodyHTML = '', footerHTML = '', narrow = false, onMount, onClose }) {
  const modal = document.createElement('div');
  modal.className = 'modal' + (narrow ? ' narrow' : '');
  modal.innerHTML =
    '<div class="modal-head">' +
      '<h2>' + escapeHtml(title) + '</h2>' +
      '<button class="panel-close" data-x title="关闭">' + ic('x') + '</button>' +
    '</div>' +
    '<div class="modal-body">' + bodyHTML + '</div>' +
    (footerHTML ? '<div class="modal-foot">' + footerHTML + '</div>' : '');

  overlay.innerHTML = '';
  overlay.appendChild(modal);
  overlay.hidden = false;

  const close = () => {
    if (currentClose !== close) return;
    currentClose = null;
    overlay.hidden = true;
    overlay.innerHTML = '';
    if (onClose) onClose();
  };
  currentClose = close;

  modal.querySelector('[data-x]').addEventListener('click', close);

  const handle = { el: modal, body: modal.querySelector('.modal-body'), foot: modal.querySelector('.modal-foot'), close };
  if (onMount) onMount(handle);
  return handle;
}

export const closeModal = () => { if (currentClose) currentClose(); };

/* ---------------- 大图 / 视频查看器 ---------------- */

/**
 * mediaList: [{ url, type, name }]
 */
export function openViewer(mediaList, startIndex = 0) {
  const list = (mediaList || []).filter(Boolean);
  if (!list.length) return;
  let i = clamp(startIndex, 0, list.length - 1);

  const box = document.createElement('div');
  box.className = 'viewer';
  document.body.appendChild(box);

  const render = () => {
    const m = list[i];
    box.innerHTML =
      '<button class="v-close" title="关闭 (Esc)">' + ic('x') + '</button>' +
      (list.length > 1 ? '<button class="v-nav v-prev" title="上一张">‹</button><button class="v-nav v-next" title="下一张">›</button>' : '') +
      (isVideo(m.type)
        ? '<video src="' + escapeHtml(m.url) + '" controls autoplay playsinline></video>'
        : '<img src="' + escapeHtml(m.url) + '" alt="' + escapeHtml(m.name || '') + '">') +
      '<div class="v-cap">' + escapeHtml(m.name || '') + (list.length > 1 ? '  ·  ' + (i + 1) + ' / ' + list.length : '') + '</div>';

    box.querySelector('.v-close').addEventListener('click', destroy);
    const prev = box.querySelector('.v-prev');
    const next = box.querySelector('.v-next');
    if (prev) prev.addEventListener('click', (e) => { e.stopPropagation(); i = (i - 1 + list.length) % list.length; render(); });
    if (next) next.addEventListener('click', (e) => { e.stopPropagation(); i = (i + 1) % list.length; render(); });
  };

  const onKey = (e) => {
    // 用捕获阶段 + 阻断，避免 Esc 同时把下面的弹窗也关掉
    if (e.key === 'Escape') { e.stopImmediatePropagation(); destroy(); }
    else if (e.key === 'ArrowLeft' && list.length > 1) { e.stopImmediatePropagation(); i = (i - 1 + list.length) % list.length; render(); }
    else if (e.key === 'ArrowRight' && list.length > 1) { e.stopImmediatePropagation(); i = (i + 1) % list.length; render(); }
  };

  function destroy() {
    document.removeEventListener('keydown', onKey, true);
    box.remove();
  }

  // 左右滑动切图 —— 手机上翻图就该用滑的，‹ ›按钮和方向键留给桌面。
  // 视频自己要拖进度条，起点在 video 上就不接手。
  let swipe = null;
  let justSwiped = false;
  box.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    if (e.target && e.target.tagName === 'VIDEO') return;
    swipe = { x: e.clientX, y: e.clientY };
    justSwiped = false;
  });
  box.addEventListener('pointerup', (e) => {
    if (!swipe) return;
    const dx = e.clientX - swipe.x;
    const dy = e.clientY - swipe.y;
    swipe = null;
    if (list.length < 2) return;
    // 横向不够长、或者主要是竖向的，当普通点击处理
    if (Math.abs(dx) < 40 || Math.abs(dx) <= Math.abs(dy)) return;
    justSwiped = true;
    i = dx < 0 ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
    render();
  });

  box.addEventListener('click', (e) => {
    // 滑完那一下会跟出一个 click，别当成「点背景 = 关闭」
    if (justSwiped) { justSwiped = false; return; }
    if (e.target === box) destroy();
  });
  document.addEventListener('keydown', onKey, true);
  render();
}

/* ---------------- 爱心特效 ---------------- */

const burstLayer = document.getElementById('burstLayer');

/** 在屏幕坐标处爆出一捧爱心 */
export function burstAt(clientX, clientY, n = 18) {
  if (!burstLayer) return;
  const glyphs = ['❤️', '💖', '💗', '💕', '💓', '🌸', '✨'];
  for (let k = 0; k < n; k++) {
    const el = document.createElement('i');
    el.textContent = glyphs[Math.floor(Math.random() * glyphs.length)];
    const ang = (Math.PI * 2 * k) / n + Math.random() * 0.5;
    const dist = 70 + Math.random() * 130;
    el.style.left = clientX + 'px';
    el.style.top = clientY + 'px';
    el.style.fontSize = (13 + Math.random() * 15) + 'px';
    el.style.setProperty('--dx', Math.cos(ang) * dist + 'px');
    el.style.setProperty('--dy', (Math.sin(ang) * dist - 40) + 'px');
    el.style.setProperty('--sc', (0.7 + Math.random() * 0.9).toFixed(2));
    el.style.setProperty('--rot', Math.round((Math.random() - 0.5) * 260) + 'deg');
    el.style.animationDelay = (Math.random() * 0.16).toFixed(2) + 's';
    burstLayer.appendChild(el);
    setTimeout(() => el.remove(), 1900);
  }
}

/** 背景飘落的爱心 */
export function startHeartRain(container, count = 16) {
  if (!container) return;
  const glyphs = ['❤', '💗', '💕', '🌸', '✨', '💖'];
  for (let k = 0; k < count; k++) {
    const el = document.createElement('i');
    el.textContent = glyphs[Math.floor(Math.random() * glyphs.length)];
    el.style.left = (Math.random() * 100).toFixed(2) + '%';
    el.style.fontSize = (11 + Math.random() * 15).toFixed(1) + 'px';
    el.style.animationDuration = (15 + Math.random() * 18).toFixed(1) + 's';
    el.style.animationDelay = (-Math.random() * 26).toFixed(1) + 's';
    el.style.opacity = '0';
    container.appendChild(el);
  }
}

/* ---------------- 情话 ---------------- */

export const QUOTES = [
  '把每一次心动，都钉在地图上。',
  '世界很大，幸好有你一起迷路。',
  '所谓旅行，就是换一个地方牵你的手。',
  '和你走过的路，都变成了纪念日。',
  '地图上的每一个点，都是一句「当时你在」。',
  '我们把日子过成了风景。',
  '再远的地方，只要你在就是回家。',
  '愿我们的脚印，铺满这整张地图。',
  '最好的风景，是转过头看见你。',
  '一起走过的地方，会长出花来。',
];

export function startQuoteRotation(node, ms = 9000) {
  if (!node) return;
  let last = node.textContent;
  setInterval(() => {
    let q = pickRandom(QUOTES);
    if (q === last) q = pickRandom(QUOTES);
    last = q;
    node.style.opacity = '0';
    node.style.transition = 'opacity .5s ease';
    setTimeout(() => {
      node.textContent = q;
      node.style.opacity = '1';
    }, 500);
  }, ms);
}

/* ---------------- 地区选择器 ---------------- */

/**
 * 层级式地区浏览选择器：中国 → 省 → 市 → 区县，任意一层都能选。
 * startPath: [{adcode, name}, ...]  已选路径
 * onPick(path)  path 形如 [{adcode,name}, ...]
 */
export function openPicker({ startPath = [], onPick }) {
  let path = startPath.slice(0, 3);

  const handle = openModal({
    title: '选择地点',
    narrow: true,
    bodyHTML: '<div class="crumbs" id="pkCrumbs"></div><div class="picker-body" id="pkBody" style="padding:0"><div class="empty">加载中…</div></div>',
    footerHTML: '<button class="btn" data-cancel>取消</button><button class="btn primary" data-ok disabled>就选这里</button>',
  });

  const body = handle.el.querySelector('#pkBody');
  const crumbs = handle.el.querySelector('#pkCrumbs');
  crumbs.style.position = 'static';
  crumbs.style.marginBottom = '14px';
  const okBtn = handle.el.querySelector('[data-ok]');
  handle.el.querySelector('[data-cancel]').addEventListener('click', handle.close);

  const levelFor = (depth) => (depth === 0 ? 'country' : depth === 1 ? 'province' : 'city');

  async function render() {
    const depth = path.length;
    crumbs.innerHTML =
      '<button class="crumb' + (depth === 0 ? ' current' : '') + '" data-d="-1">中国</button>' +
      path.map((p, i) => '<span class="crumb-sep">›</span><button class="crumb' + (i === depth - 1 ? ' current' : '') + '" data-d="' + i + '">' + escapeHtml(p.name) + '</button>').join('');

    crumbs.querySelectorAll('.crumb').forEach((b) => {
      b.addEventListener('click', () => {
        path = path.slice(0, Number(b.dataset.d) + 1);
        render();
      });
    });

    okBtn.disabled = depth === 0;
    okBtn.textContent = depth === 0 ? '就选这里' : '就选「' + path[depth - 1].name + '」';

    body.innerHTML = '<div class="empty">加载中…</div>';
    if (depth >= 3) {
      body.innerHTML = '<div class="empty"><span class="ee">' + ic('pin', 'lg') + '</span>已经是最细的一级了<br>点下面的按钮确认</div>';
      return;
    }

    const parentAdcode = depth === 0 ? '100000' : path[depth - 1].adcode;
    const { loadGeo } = await import('./api.js');
    let geo;
    try {
      geo = await loadGeo(levelFor(depth), parentAdcode);
    } catch (e) {
      body.innerHTML = '<div class="empty">这一级没有更细的数据了</div>';
      return;
    }

    const items = (geo.features || []).filter((f) => String(f.properties.adcode) !== parentAdcode);
    if (!items.length) {
      body.innerHTML = '<div class="empty">这一级没有更细的数据了</div>';
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'picker-grid';
    for (const f of items) {
      const adcode = String(f.properties.adcode);
      const btn = document.createElement('button');
      btn.className = 'picker-item' + (path.some((p) => p.adcode === adcode) ? ' has' : '');
      btn.textContent = f.properties.name;
      btn.addEventListener('click', () => {
        path = path.slice(0, depth).concat([{ adcode, name: f.properties.name }]);
        render();
      });
      grid.appendChild(btn);
    }
    body.innerHTML = '';
    body.appendChild(grid);
  }

  okBtn.addEventListener('click', () => {
    if (!path.length) return;
    onPick(path.slice());
    handle.close();
  });

  render();
}
