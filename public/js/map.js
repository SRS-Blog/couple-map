// 地图视图：单套全国投影 + 动画改 viewBox 实现「自然放大」
// 层级：中国(省) → 省(市) → 市(区县)，所有层级几何完全连续

import { createProjection, geoToPath, featureBounds, featureCenter, featureLngLat } from './projection.js';
import { loadGeo } from './api.js';
import { burstAt, escapeHtml } from './ui.js';

const NS = 'http://www.w3.org/2000/svg';
const W = 1000;
const H = 760;
const MAX_LEVEL = 2; // 0=省 1=市 2=区县
const MAX_ZOOM = 160; // 滑条 100% 时相对全国视图放大的倍数（对数刻度）
// 打开时把全国视图整体往下压。中国地图一直画到南沙（九段线最南端在曾母暗沙），
// 陆地只占上面七成，下面三成是空海面 —— 不压的话中国形状吊在顶栏底下，头重脚轻。
// 单位是 viewBox 坐标（整幅高 744），只挪位置、不改大小。
// 上限约 22 = 贴合整幅几何时四周的余量，再大就会把九段线最南那一小段切出画面。
const NATIONAL_DROP = 20;

const HEART_D =
  'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 ' +
  '14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z';

export function createMapView({ svg, onRegionClick, onRegionDblClick, onLevelChange, onZoomChange }) {
  const stack = [];        // [{ adcode, name, layer, features, view }]
  let projection = null;
  let currentView = { x: 0, y: 0, w: W, h: H };
  let raf = null;
  let records = [];
  let litMap = new Map();  // adcode -> 记录数（含子孙）
  let pinNodes = [];
  let hovered = null;
  let tip = null;

  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  /* ---------- 初始化 DOM ---------- */
  const defs = document.createElementNS(NS, 'defs');
  defs.innerHTML =
    '<linearGradient id="litGrad" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" style="stop-color: var(--lit-a)"></stop>' +
      '<stop offset="0.55" style="stop-color: var(--lit-b)"></stop>' +
      '<stop offset="1" style="stop-color: var(--lit-c)"></stop>' +
    '</linearGradient>';
  svg.appendChild(defs);

  const layers = [];
  for (let i = 0; i <= MAX_LEVEL; i++) {
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', 'layer layer-' + i);
    svg.appendChild(g);
    layers.push(g);
  }
  // 「足迹」线：回放时把走过的点连成一条虚线，画在色块之上、图钉之下
  const routeLayer = document.createElementNS(NS, 'g');
  routeLayer.setAttribute('class', 'layer-route');
  svg.appendChild(routeLayer);

  const pinLayer = document.createElementNS(NS, 'g');
  pinLayer.setAttribute('class', 'layer-pins');
  svg.appendChild(pinLayer);

  /* ---------- 悬浮提示 ---------- */
  function ensureTip() {
    if (tip) return tip;
    tip = document.createElement('div');
    tip.className = 'map-tip';
    Object.assign(tip.style, {
      position: 'absolute', zIndex: 9, pointerEvents: 'none',
      padding: '6px 11px', borderRadius: '11px', fontSize: '12px', fontWeight: '600',
      background: 'var(--surface-solid)', border: '1px solid var(--border)',
      boxShadow: 'var(--shadow)', opacity: '0', transition: 'opacity .16s ease',
      transform: 'translate(-50%, -140%)', whiteSpace: 'nowrap', color: 'var(--text)',
    });
    svg.parentElement.appendChild(tip);
    return tip;
  }

  /* ---------- 视图 ---------- */
  function elementAspect() {
    const w = svg.clientWidth || W;
    const h = svg.clientHeight || H;
    return w > 0 && h > 0 ? w / h : W / H;
  }

  /** 把包围盒扩成一个保持画布宽高比的 viewBox */
  function boundsToView(b, marginK = 0.16) {
    const pad = Math.max(b.w, b.h) * marginK + 8;
    const ar = elementAspect();
    let w = b.w + pad * 2;
    let h = b.h + pad * 2;
    if (w / h > ar) h = w / ar;
    else w = h * ar;
    const cx = (b.x0 + b.x1) / 2;
    const cy = (b.y0 + b.y1) / 2;
    return { x: cx - w / 2, y: cy - h / 2, w, h };
  }

  /** 全国视图：贴合整幅几何，再整体往下压 NATIONAL_DROP。
   *  只有全国这一层要压 —— 下钻到省市时框里就是那块地，本来就居中。 */
  function nationalView(b) {
    const v = boundsToView(b, 0.02);
    return { ...v, y: v.y - NATIONAL_DROP };
  }

  /** 一堆 feature 的并集包围盒 */
  function unionBounds(feats) {
    const b = feats.reduce((acc, f) => {
      const bb = featureBounds(f, projection.project);
      return {
        x0: Math.min(acc.x0, bb.x0), y0: Math.min(acc.y0, bb.y0),
        x1: Math.max(acc.x1, bb.x1), y1: Math.max(acc.y1, bb.y1),
      };
    }, { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
    b.w = b.x1 - b.x0;
    b.h = b.y1 - b.y0;
    return b;
  }

  function applyView() {
    svg.setAttribute('viewBox', currentView.x + ' ' + currentView.y + ' ' + currentView.w + ' ' + currentView.h);
    scalePins();
    if (onZoomChange) onZoomChange({ view: currentView, percent: zoomPercent() });
  }

  /** 当前缩放百分比：0 = 全国视图，100 = 放大 MAX_ZOOM 倍，中间按对数分布 */
  function zoomPercent() {
    const base = stack[0] ? stack[0].view : { w: W };
    const f = base.w / currentView.w;
    const p = (Math.log(Math.max(f, 1e-6)) / Math.log(MAX_ZOOM)) * 100;
    return Math.max(0, Math.min(100, p));
  }

  /** 按百分比直接设置缩放，围绕当前视图中心，不做动画（拖滑条时要跟手） */
  function setZoomPercent(p) {
    if (!stack[0]) return;
    if (raf) { cancelAnimationFrame(raf); raf = null; }
    const base = stack[0].view;
    const f = Math.pow(MAX_ZOOM, Math.max(0, Math.min(100, p)) / 100);
    const nw = base.w / f;
    const nh = base.h / f;
    const cx = currentView.x + currentView.w / 2;
    const cy = currentView.y + currentView.h / 2;
    currentView = { x: cx - nw / 2, y: cy - nh / 2, w: nw, h: nh };
    applyView();
  }

  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  function animateTo(target, duration = 820) {
    if (raf) cancelAnimationFrame(raf);
    const from = { ...currentView };
    const t0 = performance.now();
    return new Promise((resolve) => {
      const step = (now) => {
        const t = Math.min(1, (now - t0) / duration);
        const k = easeInOut(t);
        currentView = {
          x: from.x + (target.x - from.x) * k,
          y: from.y + (target.y - from.y) * k,
          w: from.w + (target.w - from.w) * k,
          h: from.h + (target.h - from.h) * k,
        };
        applyView();
        if (t < 1) raf = requestAnimationFrame(step);
        else { raf = null; resolve(); }
      };
      raf = requestAnimationFrame(step);
    });
  }

  /** 飞行时长按镜头要走多远自适应：邻市略快，跨省略慢，别一刀切 */
  function flightMs(target) {
    const dx = (target.x + target.w / 2) - (currentView.x + currentView.w / 2);
    const dy = (target.y + target.h / 2) - (currentView.y + currentView.h / 2);
    const dist = Math.hypot(dx, dy);
    const span = Math.max(currentView.w, currentView.h, target.w, target.h) || 1;
    return Math.round(520 + 360 * Math.min(1, dist / span));
  }

  /** 把某层以上的几何挪进「残影」组淡掉 —— 跨区飞行时新旧图层交叉过渡用 */
  function fadeOutLayers(fromIndex) {
    for (let i = Math.max(0, fromIndex); i < layers.length; i++) {
      const g = layers[i];
      if (!g.childNodes.length) continue;
      const ghost = document.createElementNS(NS, 'g');
      ghost.setAttribute('class', 'layer-ghost');
      while (g.firstChild) ghost.appendChild(g.firstChild);
      svg.insertBefore(ghost, pinLayer);
      ghost.style.pointerEvents = 'none';
      ghost.style.opacity = '1';
      ghost.style.transition = 'opacity .34s ease';
      requestAnimationFrame(() => { ghost.style.opacity = '0'; });
      setTimeout(() => ghost.remove(), 420);
    }
  }

  /* ---------- 渲染某一层 ---------- */
  function renderLayer(index, features) {    const g = layers[index];
    g.innerHTML = '';
    for (const f of features) {
      const props = f.properties || {};
      const adcode = String(props.adcode || '');
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', geoToPath(f.geometry, projection.project));
      p.setAttribute('class', 'region');
      p.setAttribute('data-adcode', adcode);
      p.setAttribute('data-name', props.name || '');
      p.setAttribute('data-lv', String(index));
      p.setAttribute('data-level', '0');
      p.__feature = f;
      p.addEventListener('click', (e) => {
        e.stopPropagation();
        if (onRegionClick) onRegionClick(regionOf(f, index), { shift: e.shiftKey });
      });
      p.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        if (onRegionDblClick) onRegionDblClick(regionOf(f, index));
      });
      // 用 pointer* 不用 mouse*：触屏上 mouseleave 常不触发，提示会卡在屏幕上
      p.addEventListener('pointerenter', () => showTip(p, f, adcode));
      p.addEventListener('pointerleave', hideTip);
      g.appendChild(p);
    }
    return g;
  }

  function regionOf(feature, layerIndex) {
    const props = feature.properties || {};
    // stack[0] 是「中国」这个虚拟节点，不是真实地点，所以从下标 1 开始取祖先
    // 这样 path 永远是 [省] / [省, 市] / [省, 市, 区县]，统计和展示才对得上
    const path = stack.slice(1, layerIndex + 1).map((s) => ({ adcode: s.adcode, name: s.name }));
    path.push({ adcode: String(props.adcode || ''), name: props.name || '' });
    return {
      adcode: String(props.adcode || ''),
      name: props.name || '',
      layer: layerIndex,
      feature,
      lnglat: featureLngLat(feature),
      path,
      // 不依赖数据里的 childrenNum 字段（不一定有），省和市一律先尝试往下钻，
      // 真没有下一级数据时 drillInto 会返回 false，调用方再退回到直接记录
      hasChildren: layerIndex < MAX_LEVEL,
    };
  }

  /* ---------- 悬浮提示 ---------- */
  function showTip(node, feature, adcode) {
    const t = ensureTip();
    const n = litMap.get(adcode) || 0;
    const rect = svg.getBoundingClientRect();
    const box = svg.parentElement.getBoundingClientRect();
    const c = featureCenter(feature, projection.project);
    const p = toScreen(c[0], c[1]);
    t.innerHTML = escapeHtml(feature.properties.name) +
      (n ? ' <span style="color:var(--accent-c)">· ' + n + ' 段回忆</span>' : ' <span style="color:var(--text-faint)">· 还没去过</span>');
    t.style.left = (p.x - box.left) + 'px';
    t.style.top = (p.y - box.top) + 'px';
    t.style.opacity = '1';
    node.classList.add('hovering');
    hovered = node;
  }
  function hideTip() {
    if (tip) tip.style.opacity = '0';
    if (hovered) hovered.classList.remove('hovering');
    hovered = null;
  }

  /** SVG 用户坐标 → 屏幕坐标 */
  function toScreen(x, y) {
    const { rect, sw, sh, ox, oy } = screenFit();
    return {
      x: rect.left + ox + ((x - currentView.x) / currentView.w) * sw,
      y: rect.top + oy + ((y - currentView.y) / currentView.h) * sh,
    };
  }

  /* ---------- 点亮状态 ---------- */
  function computeLit() {
    litMap = new Map();
    for (const r of records) {
      const path = Array.isArray(r.path) && r.path.length ? r.path : [r.adcode];
      for (const ad of path) {
        if (!ad) continue;
        litMap.set(ad, (litMap.get(ad) || 0) + 1);
      }
    }
  }

  // data-level 表示「点亮强度」：0 没去过 / 1 去过一次 / 2 去过 N 次（两次及以上）
  // 跟左下角图例三档对齐；data-lv 表示「属于第几层」，两者分开存，避免打架
  function litLevel(n) {
    return n >= 2 ? '2' : '1';
  }

  /** 把点亮状态刷到当前所有已渲染的层上 */
  function paintLit() {
    for (let i = 0; i < layers.length; i++) {
      for (const p of layers[i].children) {
        const n = litMap.get(p.getAttribute('data-adcode')) || 0;
        p.classList.toggle('is-lit', n > 0);
        p.setAttribute('data-level', n > 0 ? litLevel(n) : '0');
      }
    }
    paintPins();
  }

  /* ---------- 爱心标记 ---------- */
  function pinScale() {
    const px = svg.clientWidth || W;
    // 让爱心在屏幕上恒定约 22px 宽
    return (22 * (currentView.w / px)) / 22;
  }

  function scalePins() {
    const k = pinScale();
    for (const g of pinNodes) {
      const x = Number(g.dataset.x);
      const y = Number(g.dataset.y);
      g.setAttribute('transform', 'translate(' + x + ',' + y + ') scale(' + k.toFixed(4) + ')');
    }
  }

  function paintPins() {
    pinLayer.innerHTML = '';
    pinNodes = [];
    const top = stack.length - 1;
    const layer = layers[top];
    if (!layer) return;

    for (const p of layer.children) {
      const adcode = p.getAttribute('data-adcode');
      const n = litMap.get(adcode) || 0;
      if (!n) continue;
      const c = featureCenter(p.__feature, projection.project);

      const g = document.createElementNS(NS, 'g');
      g.setAttribute('class', 'pin');
      g.dataset.x = c[0];
      g.dataset.y = c[1];

      const halo = document.createElementNS(NS, 'circle');
      halo.setAttribute('class', 'halo');
      halo.setAttribute('r', '13');
      halo.setAttribute('cx', '0');
      halo.setAttribute('cy', '0');
      g.appendChild(halo);

      const heart = document.createElementNS(NS, 'path');
      heart.setAttribute('class', 'heart');
      heart.setAttribute('d', HEART_D);
      heart.setAttribute('transform', 'translate(-12,-11.5) scale(0.92)');
      g.appendChild(heart);

      if (n > 1) {
        const t = document.createElementNS(NS, 'text');
        t.setAttribute('x', '0');
        t.setAttribute('y', '2.5');
        t.setAttribute('font-size', '9.5');
        t.setAttribute('text-anchor', 'middle');
        t.textContent = n > 99 ? '99+' : String(n);
        g.appendChild(t);
      }

      pinLayer.appendChild(g);
      pinNodes.push(g);
    }
    scalePins();
  }

  /* ---------- 层级导航 ---------- */
  function setStackClasses() {
    const top = stack.length - 1;
    for (let i = 0; i < layers.length; i++) {
      for (const p of layers[i].children) {
        p.classList.remove('is-frame', 'is-faded', 'is-dimmed');
        if (i < top) {
          // 祖先层：只有当前路径上的那一块留个轮廓
          const adcode = p.getAttribute('data-adcode');
          const onPath = stack.some((s, si) => si >= i && si <= top && s.adcode === adcode);
          p.classList.add(onPath ? 'is-frame' : 'is-faded');
        }
      }
    }
  }

  async function loadChildren(parentAdcode, depth) {
    const level = depth === 1 ? 'province' : 'city';
    const geo = await loadGeo(level, parentAdcode);
    const feats = (geo.features || []).filter((f) => String(f.properties.adcode) !== parentAdcode);
    return feats;
  }

  /**
   * 钻入一个区域。animate=false 时只换层不缩放（用于一次性跳到某段回忆）
   */
  async function drillInto(adcode, name, { animate = true } = {}) {
    const depth = stack.length;           // 新层索引
    if (depth > MAX_LEVEL) return false;

    let feats;
    try {
      feats = await loadChildren(adcode, depth);
    } catch (e) {
      return false;
    }
    if (!feats.length) return false;

    const g = renderLayer(depth, feats);
    g.style.opacity = '0';
    g.style.transition = 'opacity .55s ease';

    const view = boundsToView(unionBounds(feats), 0.12);
    stack.push({ adcode, name, layer: depth, features: feats, view });

    setStackClasses();
    paintLit();

    requestAnimationFrame(() => { g.style.opacity = '1'; });
    if (animate) await animateTo(view, 860);
    else { currentView = view; applyView(); }

    emitLevel();
    return true;
  }

  function emitLevel() {
    if (onLevelChange) {
      onLevelChange({
        level: stack.length - 1,
        stack: stack.map((s) => ({ adcode: s.adcode, name: s.name })),
      });
    }
  }

  /** 回到第 index 层（0 = 全国） */
  async function goToLevel(index, { animate = true } = {}) {
    if (index < 0 || index >= stack.length) return;
    const top = stack.length - 1;
    if (index === top) return;

    for (let i = top; i > index; i--) {
      layers[i].innerHTML = '';
      layers[i].style.opacity = '';
      stack.pop();
    }

    setStackClasses();
    paintLit();
    emitLevel();

    const view = stack[index].view;
    if (animate) await animateTo(view, 780);
    else { currentView = view; applyView(); }
  }

  /**
   * 跨区直接飞过去。在深圳市里点了广州市，不要「先退回广东省、再钻进广州市」——
   * 那是两段动画（一退一进），中间还把整省版图闪出来一下，很晃。
   * 所有层级都画在同一套投影坐标里，viewBox 本来就连续，直接飞到目标就行：
   * 一次动画，新旧图层在起手最慢的那三百毫秒里交叉淡掉。
   *
   * 返回 true = 已经钻进目标；false = 镜头只对准了目标那块，调用方自己开面板。
   */
  async function jumpTo(region) {
    if (!projection) return false;
    let want = Array.isArray(region.path) && region.path.length
      ? region.path
      : [{ adcode: region.adcode, name: region.name }];

    // 栈里跟目标路径对得上的前缀留着不动，只重建对不上的后半截。
    // regionOf 的 path 就是拿当前栈拼的，所以对得上的至少有 want.length-1 段 ——
    // 真正要新建的顶多只有最后那层
    let keep = 0;
    while (keep < want.length && keep + 1 < stack.length && stack[keep + 1].adcode === want[keep].adcode) keep++;

    // 先把数据读齐再动栈：读不到就当没有下一级，不至于把栈弄成半截
    let childFeats = null;
    if (region.layer < MAX_LEVEL) {
      try { childFeats = await loadChildren(region.adcode, want.length); } catch { childFeats = null; }
    }

    let view, drilled = false;
    if (childFeats && childFeats.length) {
      view = boundsToView(unionBounds(childFeats), 0.12);
      drilled = true;
    } else {
      // 没有下一级数据：镜头对准这块自己，栈留到它的上一层，调用方开面板
      view = boundsToView(featureBounds(region.feature, projection.project), 0.2);
      want = want.slice(0, -1);
      keep = Math.min(keep, want.length);
    }

    // 旧图层进残影淡掉；要重建的层只有最后那层（上面的注释说了为什么）
    fadeOutLayers(keep + 1);
    while (stack.length > keep + 1) {
      const i = stack.length - 1;
      layers[i].innerHTML = '';
      layers[i].style.opacity = '';
      stack.pop();
    }

    if (keep < want.length) {
      const depth = want.length; // 它的下一级画在 layers[depth]
      const g = renderLayer(depth, childFeats);
      g.style.opacity = '0';
      g.style.transition = 'opacity .42s ease';
      requestAnimationFrame(() => { g.style.opacity = '1'; });
      stack.push({
        adcode: want[want.length - 1].adcode,
        name: want[want.length - 1].name,
        layer: depth,
        features: childFeats,
        view,
      });
    }

    setStackClasses();
    paintLit();
    emitLevel();

    await animateTo(view, flightMs(view));
    return drilled;
  }

  /** 缩放（滚轮 / 按钮），围绕视图中心 */
  function zoomBy(factor, anchor) {
    const k = Math.max(0.35, Math.min(3, factor));
    const cx = anchor ? anchor[0] : currentView.x + currentView.w / 2;
    const cy = anchor ? anchor[1] : currentView.y + currentView.h / 2;
    const nw = currentView.w / k;
    const nh = currentView.h / k;
    const target = {
      x: cx - (cx - currentView.x) * (nw / currentView.w),
      y: cy - (cy - currentView.y) * (nh / currentView.h),
      w: nw, h: nh,
    };
    // 限制：不要缩得比全国视图还小太多，也不要放得比滑条 100% 还深
    const base = stack[0] ? stack[0].view : { w: W, h: H };
    if (target.w > base.w * 3.2) return;
    if (target.w < base.w / MAX_ZOOM) return;
    animateTo(target, 240);
  }

  /**
   * preserveAspectRatio=xMidYMid meet：viewBox 与画布宽高比不一致时会留白，
   * 所以屏幕坐标换算要先把「真正画出来的那块」算出来（sw/sh/ox/oy）。
   * toScreen、滚轮锚点、捏合锚点三处共用。
   */
  function screenFit() {
    const rect = svg.getBoundingClientRect();
    const elAr = rect.width / rect.height || elementAspect();
    let sw = rect.width, sh = rect.height, ox = 0, oy = 0;
    const viewAr = currentView.w / currentView.h;
    if (viewAr > elAr) { sh = rect.width / viewAr; oy = (rect.height - sh) / 2; }
    else { sw = rect.height * viewAr; ox = (rect.width - sw) / 2; }
    return { rect, sw, sh, ox, oy };
  }

  /** 屏幕坐标 → SVG 用户坐标 */
  function toUser(clientX, clientY) {
    const { rect, sw, sh, ox, oy } = screenFit();
    return [
      currentView.x + ((clientX - rect.left - ox) / sw) * currentView.w,
      currentView.y + ((clientY - rect.top - oy) / sh) * currentView.h,
    ];
  }

  /**
   * 回到全国：既清掉所有下钻层，也把视图拉回全国范围。
   * 不能只用 goToLevel(0)——如果用户是用滑条或滚轮放大的，层级栈还停在第 0 层，
   * goToLevel 会判定「已经在第 0 层」直接返回，视图不动。
   */
  async function resetAll() {
    if (stack.length > 1) {
      for (let i = stack.length - 1; i > 0; i--) {
        layers[i].innerHTML = '';
        layers[i].style.opacity = '';
        stack.pop();
      }
      setStackClasses();
      paintLit();
      emitLevel();
    }
    return animateTo(stack[0] ? stack[0].view : { x: 0, y: 0, w: W, h: H }, 700);
  }

  /**
   * 一次飞到某条路径的终点：栈修到它的上一级，镜头压在它自己身上。
   * 回放、回忆漫游都走这里 —— 全程一段动画，不闪中间层。
   * 旧 locate 是「先瞬移到全国、再逐层塞进去、最后缩放」，近处跳转会看到镜头
   * 先抽回去再弹回来；现在公共前缀留着，只飞该飞的那一段。
   *
   * path:  ['440000','440300','440305']，或 [{adcode, name}, ...]
   * names: 对应中文名（path 传 adcode 数组时用），给面包屑用
   */
  async function flyTo(path, names) {
    if (!projection) return false;
    const raw = Array.isArray(path) ? path : [];
    if (!raw.length) return false;

    const list = raw.map((p, i) => (p && typeof p === 'object')
      ? { adcode: String(p.adcode || ''), name: p.name || (names && names[i]) || '' }
      : { adcode: String(p), name: (names && names[i]) || '' })
      .filter((x) => x.adcode)
      .slice(0, MAX_LEVEL + 1);
    if (!list.length) return false;

    const focusAd = list[list.length - 1].adcode;
    // 焦点自己不入栈：它画在栈顶那一层里，镜头对准它就够了
    const want = list.slice(0, -1);

    // 跟 jumpTo 同一套思路：公共前缀留着不动，只重建对不上的后半截
    let keep = 0;
    while (keep < want.length && keep + 1 < stack.length && stack[keep + 1].adcode === want[keep].adcode) keep++;

    // 数据先读齐再动栈：读不到就停在读得到的地方，不至于把栈弄成半截
    const add = [];
    for (let i = keep; i < want.length; i++) {
      let feats = null;
      try { feats = await loadChildren(want[i].adcode, i + 1); } catch { feats = null; }
      if (!feats || !feats.length) break;
      add.push({ adcode: want[i].adcode, name: want[i].name, layer: i + 1, features: feats });
    }

    fadeOutLayers(keep + 1);
    while (stack.length > keep + 1) {
      const i = stack.length - 1;
      layers[i].innerHTML = '';
      layers[i].style.opacity = '';
      stack.pop();
    }

    for (const entry of add) {
      const g = renderLayer(entry.layer, entry.features);
      g.style.opacity = '0';
      g.style.transition = 'opacity .42s ease';
      requestAnimationFrame(() => { g.style.opacity = '1'; });
      stack.push(entry);
    }

    setStackClasses();
    paintLit();
    emitLevel();

    // 镜头对准焦点自己；这块几何缺失就退到它所在那层的总览
    const feat = findFeature(focusAd);
    const view = feat
      ? boundsToView(featureBounds(feat, projection.project), 0.24)
      : boundsToView(unionBounds(stack[stack.length - 1].features), 0.16);

    // 两条回忆落在同一个地方：镜头站定就好，别再原地晃一下
    const near = Math.abs(view.w - currentView.w) < view.w * 0.02
      && Math.abs(view.h - currentView.h) < view.h * 0.02
      && Math.hypot(view.x - currentView.x, view.y - currentView.y) < view.w * 0.02;
    if (near) { currentView = view; applyView(); }
    else await animateTo(view, flightMs(view));
    return true;
  }

  /** 跳到某条路径所在的位置（回忆漫游、回放用） */
  const locate = (path, names) => flyTo(path, names);

  /** 把一串 [经度,纬度] 连成「足迹」线；少于两个点就清掉 */
  function showRoute(pts) {
    routeLayer.innerHTML = '';
    if (!projection || !Array.isArray(pts)) return;
    const coords = [];
    for (const ll of pts) {
      if (!Array.isArray(ll) || ll.length < 2) continue;
      const p = projection.project([Number(ll[0]), Number(ll[1])]);
      if (Number.isFinite(p[0]) && Number.isFinite(p[1])) coords.push(p);
    }
    if (coords.length < 2) return;
    let d = '';
    for (let i = 0; i < coords.length; i++) {
      d += (i ? 'L' : 'M') + coords[i][0].toFixed(1) + ' ' + coords[i][1].toFixed(1);
    }
    const node = document.createElementNS(NS, 'path');
    node.setAttribute('d', d);
    node.setAttribute('class', 'route-line');
    routeLayer.appendChild(node);
  }
  const clearRoute = () => { routeLayer.innerHTML = ''; };

  /** 高亮 + 爆爱心 */
  function celebrate(adcode) {
    const top = stack.length - 1;
    const layer = layers[top];
    for (const p of layer.children) {
      if (p.getAttribute('data-adcode') !== String(adcode)) continue;
      p.classList.remove('just-lit');
      void p.offsetWidth;
      p.classList.add('just-lit');
      setTimeout(() => p.classList.remove('just-lit'), 1600);

      const c = featureCenter(p.__feature, projection.project);
      const s = toScreen(c[0], c[1]);
      burstAt(s.x, s.y, 22);
      return;
    }
    // 当前层没有就退到屏幕中心爆一下
    const r = svg.getBoundingClientRect();
    burstAt(r.left + r.width / 2, r.top + r.height / 2, 16);
  }

  /* ---------- 对外 ---------- */
  async function init() {
    const geo = await loadGeo('country', '100000');
    const feats = geo.features || [];
    projection = createProjection(feats, { width: W, height: H, padding: 30 });

    renderLayer(0, feats);
    const all = feats.reduce((acc, f) => {
      const b = featureBounds(f, projection.project);
      return {
        x0: Math.min(acc.x0, b.x0), y0: Math.min(acc.y0, b.y0),
        x1: Math.max(acc.x1, b.x1), y1: Math.max(acc.y1, b.y1), w: 0, h: 0,
      };
    }, { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
    all.w = all.x1 - all.x0;
    all.h = all.y1 - all.y0;

    const view = nationalView(all);
    stack.push({ adcode: '100000', name: '中国', layer: 0, features: feats, view });
    currentView = view;
    applyView();
    paintLit();
    emitLevel();
  }

  function setRecords(list) {
    records = Array.isArray(list) ? list : [];
    computeLit();
    paintLit();
  }

  /** 找到当前层里某个 adcode 的 feature（给面板展示经纬度用） */
  function findFeature(adcode) {
    for (let i = layers.length - 1; i >= 0; i--) {
      for (const p of layers[i].children) {
        if (p.getAttribute('data-adcode') === String(adcode)) return p.__feature;
      }
    }
    return null;
  }

  // 滚轮缩放
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [ux, uy] = toUser(e.clientX, e.clientY);
    zoomBy(e.deltaY < 0 ? 1.18 : 1 / 1.18, [ux, uy]);
  }, { passive: false });

  /* ---------- 指针手势：1 根手指平移，2 根手指捏合缩放 ----------
     注意：不能在 pointerdown 时就 setPointerCapture，否则 pointerup 会被重定向到 svg，
     click 事件的目标就变成 svg 而不是省块 <path>，点击监听永远收不到。
     所以平移只在真的拖出一段距离之后才捕获；双指本来就不会触发单击，
     一进入捏合就直接捕获两根手指。 */
  const pointers = new Map();   // pointerId -> {x, y}
  let drag = null;              // 单指平移
  let pinch = null;             // 双指捏合
  let pressTimer = 0;           // 长按定时器
  let pressRegion = null;

  function clearPress() {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = 0; }
    pressRegion = null;
  }

  /**
   * 捏合缩放。
   * 用「捏合起点」做基准做绝对换算，不是每帧按增量累积 —— 增量式碰上限位会橡皮筋：
   * 缩到顶之后手指往回一点点就会立刻反向缩放。
   * 锚点钉在「起点时中点下面的那个用户坐标」上，让它始终跟着现在的中点走，
   * 这样边捏边拖也不会把画面甩走。
   */
  function applyPinch() {
    const pts = Array.from(pointers.values());
    if (pts.length < 2 || !pinch) return;
    const [a, b] = pts;
    const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;

    const v0 = pinch.view0;
    const base = stack[0] ? stack[0].view : { w: W, h: H };
    const minW = base.w / MAX_ZOOM;
    const maxW = base.w * 3.2;

    // 先算没被限位夹住的理想宽度，再夹一次 —— 夹过之后仍要按真实的 nw 排锚点，不然会跳
    let nw = v0.w * (pinch.dist0 / dist);
    if (nw > maxW) nw = maxW;
    if (nw < minW) nw = minW;
    const nh = nw * (v0.h / v0.w);

    // pinch 期间画布尺寸不变、缩放是等比的，所以 fit 里那几个值可以在起点算一次
    const { rect, sw, sh, ox, oy } = pinch.fit;
    if (raf) { cancelAnimationFrame(raf); raf = null; }
    currentView = {
      x: pinch.user0[0] - ((midX - rect.left - ox) / sw) * nw,
      y: pinch.user0[1] - ((midY - rect.top - oy) / sh) * nh,
      w: nw, h: nh,
    };
    applyView();
  }

  svg.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    hideTip(); // 触屏上 mouseleave 常不触发，提示会卡住 —— 按下就先收掉

    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 1) {
      drag = { x: e.clientX, y: e.clientY, view: { ...currentView }, moved: false, pointerId: e.pointerId };

      // 长按 = 在这里写（触屏没有 dblclick，只能另找一只手势替代）。
      // 鼠标另有 dblclick，别抢它。
      if (e.pointerType !== 'mouse' && e.target && e.target.__feature) {
        pressRegion = regionOf(e.target.__feature, Number(e.target.getAttribute('data-lv')));
        pressTimer = setTimeout(() => {
          pressTimer = 0;
          if (!pressRegion) return;
          const r = pressRegion;
          pressRegion = null;
          if (onRegionDblClick) onRegionDblClick(r);
        }, 500);
      }
      return;
    }

    // 第二根手指落地：进入捏合。两根手指一起按下的时候不可能是单击，
    // 直接捕获，这样即使指头滑出 svg 也收得到 move。
    clearPress();
    drag = null;
    svg.classList.remove('dragging');
    const pts = Array.from(pointers.values());
    const [a, b] = pts;
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    pinch = {
      dist0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      view0: { ...currentView },
      fit: screenFit(),
      user0: toUser(midX, midY),
    };
    for (const id of pointers.keys()) {
      try { svg.setPointerCapture(id); } catch { /* 忽略 */ }
    }
  });

  svg.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pinch && pointers.size >= 2) { applyPinch(); return; }

    if (!drag) return;
    const dxPx = e.clientX - drag.x;
    const dyPx = e.clientY - drag.y;
    if (!drag.moved) {
      if (Math.hypot(dxPx, dyPx) < 5) return; // 还没到拖拽阈值，当成点击，什么都不做
      clearPress();
      drag.moved = true;
      svg.classList.add('dragging');
      try { svg.setPointerCapture(drag.pointerId); } catch { /* 忽略 */ }
    }
    const rect = svg.getBoundingClientRect();
    const dx = dxPx * (drag.view.w / rect.width);
    const dy = dyPx * (drag.view.h / rect.height);
    currentView = { ...drag.view, x: drag.view.x - dx, y: drag.view.y - dy };
    applyView();
  });

  const endPointer = (e) => {
    if (!pointers.delete(e.pointerId)) return;
    clearPress();

    if (pinch) {
      // 还有两根以上手指就接着捏
      if (pointers.size >= 2) return;
      pinch = null;
      for (const id of pointers.keys()) {
        try { svg.releasePointerCapture(id); } catch { /* 忽略 */ }
      }
      // 捏合退回单指：把剩下那根当成新的平移起点（moved=true，免得又触发单击），
      // 否则视图会在下一次 move 时突然跳回旧基准
      const leftId = Array.from(pointers.keys())[0];
      const left = leftId !== undefined ? pointers.get(leftId) : null;
      if (left) {
        drag = { x: left.x, y: left.y, view: { ...currentView }, moved: true, pointerId: leftId };
        svg.classList.add('dragging');
        try { svg.setPointerCapture(leftId); } catch { /* 忽略 */ }
      } else {
        drag = null;
        svg.classList.remove('dragging');
      }
      return;
    }

    if (!drag) return;
    if (drag.moved) {
      try { svg.releasePointerCapture(drag.pointerId); } catch { /* 忽略 */ }
    }
    drag = null;
    svg.classList.remove('dragging');
  };
  svg.addEventListener('pointerup', endPointer);
  svg.addEventListener('pointercancel', endPointer);

  window.addEventListener('resize', () => {
    // 宽高比变了，重新贴合当前层级
    const top = stack.length - 1;
    if (top >= 0) {
      const b = stack[top].features.reduce((acc, f) => {
        const bb = featureBounds(f, projection.project);
        return {
          x0: Math.min(acc.x0, bb.x0), y0: Math.min(acc.y0, bb.y0),
          x1: Math.max(acc.x1, bb.x1), y1: Math.max(acc.y1, bb.y1), w: 0, h: 0,
        };
      }, { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
      b.w = b.x1 - b.x0;
      b.h = b.y1 - b.y0;
      const view = top === 0 ? nationalView(b) : boundsToView(b, 0.12);
      stack[top].view = view;
      currentView = view;
      applyView();
    }
  });

  return {
    init,
    setRecords,
    drillInto,
    jumpTo,
    flyTo,
    goToLevel,
    zoomBy,
    zoomPercent,
    setZoomPercent,
    resetAll,
    locate,
    showRoute,
    clearRoute,
    celebrate,
    findFeature,
    getStack: () => stack.map((s) => ({ adcode: s.adcode, name: s.name })),
    getLevel: () => stack.length - 1,
    hideTip,
  };
}
