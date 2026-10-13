// 足迹回放：按时间顺序一张一张放下去，镜头飞到那个地方，配上那段回忆的 BGM。
// 像放一部只有你们俩的纪录片 —— 所以卡片做成「放映卡」，进度条就是片长，
// 走过的点连成一条虚线，是你们真的踩出来的那条路。
import { escapeHtml, fmtDate, clamp, toast, isImage, isVideo, ic } from './ui.js';
import { featureLngLat } from './projection.js';

const SLIDE_MS = 5600;        // 一张停多久
const SLIDE_MS_LONG = 7800;   // 字多的多给点时间

export function createReplay({ mountEl, map, player, getState }) {
  /* ---------------- DOM ---------------- */
  const veil = document.createElement('div');
  veil.className = 'replay-veil';
  veil.hidden = true;

  const card = document.createElement('section');
  card.className = 'replay';
  card.hidden = true;
  card.setAttribute('aria-label', '足迹回放');
  card.innerHTML =
    '<div class="rp-media" id="rpMedia"></div>' +
    '<div class="rp-main">' +
      '<div class="rp-eyebrow">' + ic('replay') + '足迹回放</div>' +
      '<div class="rp-meta" id="rpMeta"></div>' +
      '<div class="rp-title" id="rpTitle"></div>' +
      '<div class="rp-text" id="rpText"></div>' +
      '<div class="rp-foot">' +
        '<div class="rp-prog"><i id="rpFill"></i></div>' +
        '<div class="rp-count" id="rpCount"></div>' +
        '<div class="rp-ctrls">' +
          '<button class="rp-btn" id="rpPrev" title="上一段（←）">' + ic('prev') + '</button>' +
          '<button class="rp-btn big" id="rpPlay" title="播放 / 暂停（空格）">' + ic('pause') + '</button>' +
          '<button class="rp-btn" id="rpNext" title="下一段（→）">' + ic('next') + '</button>' +
          '<button class="rp-btn" id="rpExit" title="退出回放（Esc）">' + ic('x') + '</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  mountEl.appendChild(veil);
  mountEl.appendChild(card);

  const mediaEl = card.querySelector('#rpMedia');
  const metaEl = card.querySelector('#rpMeta');
  const titleEl = card.querySelector('#rpTitle');
  const textEl = card.querySelector('#rpText');
  const fillEl = card.querySelector('#rpFill');
  const countEl = card.querySelector('#rpCount');
  const playBtn = card.querySelector('#rpPlay');

  /* ---------------- 状态 ---------------- */
  let slides = [];
  let i = 0;
  let open = false;
  let paused = false;
  let gen = 0;              // 第几张的代号：连按下一张时，旧飞行别抢方向盘
  let flyBusy = false;
  let flyQueued = null;
  let timerRaf = 0;
  let slideDur = SLIDE_MS;
  let elapsed = 0;
  let slideT0 = 0;
  const llCache = [];       // 每张的经纬度，算过就记着

  /* ---------------- 经纬度 ----------------
     优先用记录上钉的点（更准）；没有就取那块几何的中心。
     几何在视野里的时候才找得到，所以没算出来先不缓存，等它进视野再补 */
  function llOf(k) {
    if (llCache[k]) return llCache[k];
    const r = slides[k];
    if (!r) return null;
    let ll = (Array.isArray(r.lnglat) && r.lnglat.length === 2 && Number.isFinite(r.lnglat[0]))
      ? r.lnglat : null;
    if (!ll && r.adcode) {
      const f = map.findFeature(r.adcode);
      if (f) {
        const c = featureLngLat(f);
        if (Array.isArray(c) && c.length === 2) ll = c;
      }
    }
    if (ll) llCache[k] = ll;
    return ll;
  }

  /** 到第 upto 张为止走过的点（跳过的洞就空着，线自己会拉直） */
  function routePoints(upto) {
    const pts = [];
    for (let k = 0; k <= upto; k++) {
      const ll = llOf(k);
      if (ll) pts.push(ll);
    }
    return pts;
  }

  /* ---------------- 计时 ---------------- */
  function cancelTimer() {
    if (timerRaf) cancelAnimationFrame(timerRaf);
    timerRaf = 0;
  }

  function tick(now) {
    if (!open || paused) return;
    const e = elapsed + (now - slideT0);
    const pct = clamp(e / slideDur, 0, 1);
    fillEl.style.width = (pct * 100).toFixed(2) + '%';
    if (pct >= 1) { next(); return; }
    timerRaf = requestAnimationFrame(tick);
  }

  function startTimer() {
    cancelTimer();
    const r = slides[i];
    slideDur = (r && r.text && r.text.length > 60) ? SLIDE_MS_LONG : SLIDE_MS;
    elapsed = 0;
    slideT0 = performance.now();
    fillEl.style.width = '0%';
    if (!paused) timerRaf = requestAnimationFrame(tick);
  }

  function setPaused(v) {
    if (!open) return;
    if (v === paused) return;
    if (v) {
      elapsed += performance.now() - slideT0;
      cancelTimer();
    } else {
      slideT0 = performance.now();
      timerRaf = requestAnimationFrame(tick);
    }
    paused = v;
    playBtn.innerHTML = paused ? ic('play') : ic('pause');
    playBtn.title = paused ? '继续（空格）' : '暂停（空格）';
  }

  /* ---------------- 画面 ---------------- */
  function renderSlide() {
    const r = slides[i];
    const media = Array.isArray(r.media) ? r.media : [];
    const img = media.find((m) => isImage(m.type));
    const vid = !img ? media.find((m) => isVideo(m.type)) : null;

    mediaEl.innerHTML = img
      ? '<img src="' + escapeHtml(img.url) + '" alt="">'
      : vid
        ? '<video src="' + escapeHtml(vid.url) + '" muted playsinline preload="metadata"></video>'
        : '<span class="rp-emoji">' + escapeHtml(r.mood || '💗') + '</span>';
    mediaEl.classList.toggle('is-emoji', !img && !vid);

    const names = Array.isArray(r.names) ? r.names : [];
    const place = names.filter(Boolean).join(' › ');
    metaEl.innerHTML =
      '<span class="rp-date">' + escapeHtml(r.date ? fmtDate(r.date) : '某一天') + '</span>' +
      (place ? '<span class="rp-sep">·</span><span class="rp-place">' + escapeHtml(place) + '</span>' : '') +
      (r.bgmName ? '<span class="rp-sep">·</span><span class="rp-bgm">' + ic('note') + escapeHtml(r.bgmName) + '</span>' : '');

    titleEl.textContent = r.title || (place ? '在 ' + place.split(' › ').pop() : '那天');
    textEl.innerHTML = r.text
      ? escapeHtml(r.text)
      : '<em>这段回忆还没写文字</em>';
    countEl.textContent = (i + 1) + ' / ' + slides.length;

    // 文字换上去的时候轻轻飘一下，别干巴巴地跳
    card.classList.remove('rp-swap');
    void card.offsetWidth;
    card.classList.add('rp-swap');
  }

  /* ---------------- 飞行（合并连按） ---------------- */
  function pumpFly() {
    if (flyBusy) return;
    const job = flyQueued;
    if (!job) return;
    flyQueued = null;
    flyBusy = true;
    Promise.resolve()
      .then(() => map.flyTo(job.path, job.names))
      .then(() => {
        if (!open || job.gen !== gen) return;
        map.celebrate(job.adcode);
        // 落地后这块几何才进视野，把这个点补进足迹里
        map.showRoute(routePoints(i));
      })
      .catch(() => { /* 这块几何缺了就缺了，卡片还在 */ })
      .then(() => {
        flyBusy = false;
        if (open) pumpFly();
      });
  }

  /* ---------------- 走一张 ---------------- */
  function goTo(index, { wrap = true } = {}) {
    if (!slides.length) return;
    let t = index;
    if (t < 0 || t >= slides.length) {
      if (!wrap) return;
      t = (t + slides.length) % slides.length;
    }
    i = t;
    gen++;
    const r = slides[i];

    renderSlide();
    startTimer();

    map.showRoute(routePoints(i));

    // 这段回忆配了歌就换上；找不到那首（被删了）就接着放上一首，别静音
    if (r.bgmId && player) {
      Promise.resolve(player.playById(r.bgmId)).catch(() => {});
    }

    const path = Array.isArray(r.path) && r.path.length ? r.path : [r.adcode];
    const names = Array.isArray(r.names) ? r.names : [];
    flyQueued = { path, names, adcode: r.adcode, gen };
    pumpFly();
  }

  const next = () => {
    if (i >= slides.length - 1) { stop(true); return; } // 放完了就谢幕
    goTo(i + 1);
  };
  const prev = () => goTo(i - 1);

  /* ---------------- 开关 ---------------- */
  function start() {
    const recs = (getState().records || []).slice();
    if (!recs.length) {
      toast('还没有回忆可以回放，先去点亮一个地方吧', 'bad');
      return false;
    }
    // 按日期排：有日期的按先后，没日期的搁在最后（它们是「还没想好哪天」）
    slides = recs.slice().sort((a, b) => {
      const da = a.date || '', db = b.date || '';
      if (da && db) return da.localeCompare(db);
      if (da) return -1;
      if (db) return 1;
      return 0;
    });
    llCache.length = 0;
    open = true;
    paused = false;
    playBtn.innerHTML = ic('pause');
    card.classList.remove('rp-out', 'rp-swap');
    veil.hidden = false;
    card.hidden = false;
    document.body.classList.add('replaying');
    goTo(0);
    toast('开始回放啦 · 一共 ' + slides.length + ' 段足迹');
    return true;
  }

  function stop(natural = false) {
    if (!open) return;
    open = false;
    cancelTimer();
    flyQueued = null;
    gen++;
    document.body.classList.remove('replaying');
    map.clearRoute();
    card.classList.add('rp-out');
    veil.hidden = true;
    setTimeout(() => {
      if (!open) { card.hidden = true; card.classList.remove('rp-out', 'rp-swap'); }
    }, 260);
    if (natural) toast('回放完啦，晚安 ❤');
  }

  /* ---------------- 交互 ---------------- */
  card.querySelector('#rpPrev').addEventListener('click', () => { setPaused(false); prev(); });
  card.querySelector('#rpNext').addEventListener('click', () => { setPaused(false); next(); });
  card.querySelector('#rpExit').addEventListener('click', () => stop());
  playBtn.addEventListener('click', () => setPaused(!paused));
  veil.addEventListener('click', () => stop()); // 点幕布 = 提前离场

  // 左右滑动换一段：手机上左右滑比戳那几颗小按钮顺手
  let swipe = null;
  card.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    if (e.target && e.target.closest && e.target.closest('button')) return;
    swipe = { x: e.clientX, y: e.clientY };
  });
  card.addEventListener('pointerup', (e) => {
    if (!swipe) return;
    const dx = e.clientX - swipe.x;
    const dy = e.clientY - swipe.y;
    swipe = null;
    if (Math.abs(dx) < 44 || Math.abs(dx) <= Math.abs(dy)) return;
    setPaused(false);
    if (dx < 0) next(); else prev();
  });

  function handleKey(e) {
    if (!open) return;
    if (e.key === 'Escape') { e.preventDefault(); stop(); return; }
    if (e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); setPaused(!paused); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); setPaused(false); next(); return; }
    if (e.key === 'ArrowLeft') { e.preventDefault(); setPaused(false); prev(); }
  }

  return { start, stop, handleKey, isOpen: () => open };
}
