// 音乐播放器：本地 MP3 歌单，黑胶唱片转圈效果
// 打开页面自动播放；浏览器不让自动播时，点一下页面任意处就接着播
import { loadMusic, uploadTrack, deleteTrack } from './api.js';
import { $, ic, escapeHtml, uid, toast, fmtSize } from './ui.js';

const LS = {
  idx: 'cm_music_idx',
  vol: 'cm_music_vol',
  on: 'cm_music_on', // 用户是否想让音乐响着（默认想）
};

const fmtTime = (s) => {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return m + ':' + String(r).padStart(2, '0');
};

export function createMusicPlayer({ mountEl }) {
  const audio = new Audio();
  audio.preload = 'metadata';

  let tracks = [];   // [{id,name,ext,type,size,url,addedAt}]
  let index = -1;
  let ready = false;
  let wantPlay = localStorage.getItem(LS.on) !== '0';
  let awaitingGesture = false;

  /* ---------------- UI 骨架 ---------------- */
  const root = document.createElement('div');
  root.className = 'player';
  root.innerHTML = `
    <div class="player-card" id="pcCard" hidden>
      <div class="pc-head">
        <span class="pc-title">${ic('note')}我们的歌单</span>
        <div class="pc-head-btns">
          <button class="pc-mini" id="pcAdd" title="上传 MP3">${ic('plus')}上传</button>
          <button class="pc-mini icon" id="pcFold" title="收起">${ic('chev-up')}</button>
        </div>
      </div>

      <div class="pc-now">
        <div class="pc-name" id="pcName">还没有歌～</div>
        <div class="pc-bar" id="pcBar" title="点击跳转进度">
          <i id="pcFill"></i>
        </div>
        <div class="pc-time"><span id="pcCur">0:00</span><span id="pcDur">0:00</span></div>
      </div>

      <div class="pc-ctrls">
        <button class="pc-btn" id="pcPrev" title="上一首">${ic('prev')}</button>
        <button class="pc-btn big" id="pcPlay" title="播放 / 暂停">${ic('play')}</button>
        <button class="pc-btn" id="pcNext" title="下一首">${ic('next')}</button>
        <label class="pc-vol" title="音量">
          <span id="pcVolIcon">${ic('volume')}</span>
          <input type="range" id="pcVol" min="0" max="100" value="80" aria-label="音量">
        </label>
      </div>

      <ul class="pc-list" id="pcList"></ul>
      <div class="pc-empty" id="pcEmpty">还没有歌，点「＋ 上传」把你们的 BGM 放进来 ♪</div>
      <input type="file" id="pcFile" accept=".mp3,.wav,.m4a,.aac,.ogg,.flac,audio/*" multiple hidden>
    </div>

    <div class="player-hint" id="pcHint" hidden>点一下开启音乐 ♪</div>

    <button class="vinyl" id="pcVinyl" title="音乐 · 点开歌单">
      <span class="vinyl-ring"></span>
      <span class="vinyl-disc"></span>
      <span class="vinyl-art" id="pcArt">${ic('heart')}</span>
    </button>
  `;
  mountEl.appendChild(root);

  const el = {
    card: $('#pcCard', root),
    add: $('#pcAdd', root),
    fold: $('#pcFold', root),
    name: $('#pcName', root),
    bar: $('#pcBar', root),
    fill: $('#pcFill', root),
    cur: $('#pcCur', root),
    dur: $('#pcDur', root),
    prev: $('#pcPrev', root),
    play: $('#pcPlay', root),
    next: $('#pcNext', root),
    vol: $('#pcVol', root),
    volIcon: $('#pcVolIcon', root),
    list: $('#pcList', root),
    empty: $('#pcEmpty', root),
    file: $('#pcFile', root),
    hint: $('#pcHint', root),
    vinyl: $('#pcVinyl', root),
    art: $('#pcArt', root),
  };

  /* ---------------- 状态渲染 ---------------- */
  function renderList() {
    el.empty.hidden = tracks.length > 0;
    el.list.innerHTML = tracks
      .map((t, i) => `
        <li class="pc-item${i === index ? ' playing' : ''}" data-i="${i}">
          <span class="pc-idx">${i === index ? ic('note') : i + 1}</span>
          <span class="pc-item-name" title="${escapeHtml(t.name)}">${escapeHtml(t.name)}</span>
          <span class="pc-item-size">${fmtSize(t.size || 0)}</span>
          <button class="pc-del" data-del="${escapeHtml(t.id)}" title="删除这首歌">${ic('x')}</button>
        </li>`)
      .join('');

    el.list.querySelectorAll('.pc-item').forEach((li) => {
      li.addEventListener('click', (e) => {
        if (e.target.closest('.pc-del')) return;
        playIndex(Number(li.dataset.i), true);
      });
    });
    el.list.querySelectorAll('.pc-del').forEach((b) => {
      b.addEventListener('click', async (e) => {
        e.stopPropagation();
        await removeTrack(b.dataset.del);
      });
    });
  }

  // 只改「正在播放」那一条的样式，不重建列表（免得滚动位置和事件被冲掉）
  function markPlaying() {
    el.list.querySelectorAll('.pc-item').forEach((li) => {
      const i = Number(li.dataset.i);
      const on = i === index;
      li.classList.toggle('playing', on);
      const idx = li.querySelector('.pc-idx');
      if (idx) idx.innerHTML = on ? ic('note') : String(i + 1);
    });
  }

  function syncPlayUI() {
    const playing = !audio.paused && !audio.ended;
    el.play.innerHTML = playing ? ic('pause') : ic('play');
    root.classList.toggle('is-playing', playing);
    el.vinyl.setAttribute('aria-label', playing ? '正在播放' : '已暂停');
    if (index >= 0 && tracks[index]) {
      el.name.textContent = tracks[index].name;
      el.name.title = tracks[index].name;
    }
    markPlaying();
  }

  function syncProgress() {
    const d = audio.duration;
    const c = audio.currentTime;
    const p = Number.isFinite(d) && d > 0 ? (c / d) * 100 : 0;
    el.fill.style.width = p + '%';
    el.cur.textContent = fmtTime(c);
    el.dur.textContent = fmtTime(d);
  }

  function showHint(show) {
    el.hint.hidden = !show;
  }

  /* ---------------- 播放控制 ---------------- */
  function playIndex(i, userGesture, autoplay = true) {
    if (!tracks.length) { index = -1; return; }
    if (i < 0 || i >= tracks.length) i = 0;
    index = i;
    localStorage.setItem(LS.idx, String(index));
    audio.src = tracks[index].url;
    audio.load();
    syncPlayUI();
    if (autoplay) tryStart(userGesture);
  }

  function tryStart(userGesture) {
    if (!tracks.length) return;
    if (index < 0) { playIndex(0, userGesture); return; }
    const p = audio.play();
    if (p && p.then) {
      p.then(() => {
        awaitingGesture = false;
        showHint(false);
        syncPlayUI();
      }).catch(() => {
        // 浏览器自动播放策略拦住了：等一次用户点一下再放
        awaitingGesture = true;
        syncPlayUI();
        if (wantPlay) showHint(true);
      });
    }
    if (userGesture) {
      wantPlay = true;
      localStorage.setItem(LS.on, '1');
    }
  }

  function toggle() {
    if (!tracks.length) {
      openCard(true);
      toast('先点「＋ 上传」添加一首歌吧');
      return;
    }
    wantPlay = true;
    localStorage.setItem(LS.on, '1');
    if (audio.paused || audio.ended) {
      if (index < 0) playIndex(0, true);
      else tryStart(true);
    } else {
      audio.pause();
      wantPlay = false;
      localStorage.setItem(LS.on, '0');
      syncPlayUI();
    }
  }

  function next(manual) {
    if (!tracks.length) return;
    playIndex((index + 1) % tracks.length, manual);
  }

  function prev() {
    if (!tracks.length) return;
    playIndex((index - 1 + tracks.length) % tracks.length, true);
  }

  /**
   * 按 id 点一首歌唱（给回忆配的 BGM 用）。
   * 歌单还没加载好会先等一下；找不到这首歌返回 false
   */
  async function playById(id) {
    if (!id) return false;
    if (!tracks.length) await refresh();
    const i = tracks.findIndex((t) => t.id === id);
    if (i < 0) return false;
    if (i === index && !audio.paused && !audio.ended) return true; // 正在放这首，不用打断
    playIndex(i, true, true);
    return true;
  }

  const trackById = (id) => tracks.find((t) => t.id === id) || null;

  /* ---------------- 歌单增删 ---------------- */
  async function refresh() {
    try {
      const lib = await loadMusic();
      tracks = Array.isArray(lib.tracks) ? lib.tracks : [];
    } catch {
      tracks = [];
    }
    renderList();
    return tracks;
  }

  async function addFiles(fileList) {
    const files = Array.from(fileList || []).filter((f) => f && f.size > 0);
    if (!files.length) return;

    openCard(true);
    const wasEmpty = tracks.length === 0;
    let firstAdded = -1;

    for (const file of files) {
      const id = uid('t_');
      const label = file.name || '新歌';
      toast('正在上传「' + label + '」…', 'info', 6000);
      try {
        const r = await uploadTrack(id, file, (p) => {
          toast('正在上传「' + label + '」 ' + Math.round(p * 100) + '%', 'info', 2000);
        });
        if (r && r.track) {
          if (firstAdded < 0) firstAdded = tracks.length;
          const at = tracks.findIndex((t) => t.id === r.track.id);
          if (at >= 0) tracks[at] = r.track; else tracks.push(r.track);
        }
        toast('「' + label + '」已加入歌单');
      } catch (e) {
        toast('上传失败：' + (e && e.message), 'bad', 5000);
      }
    }
    renderList();

    // 歌单从无到有，就从第一首新歌开播
    if (wasEmpty && firstAdded >= 0 && tracks[firstAdded]) {
      playIndex(firstAdded, true);
    } else if (firstAdded >= 0 && audio.paused && wantPlay) {
      tryStart(true);
    }
  }

  async function removeTrack(id) {
    const at = tracks.findIndex((t) => t.id === id);
    const name = at >= 0 ? tracks[at].name : id;
    try {
      await deleteTrack(id);
    } catch (e) {
      toast('删除失败：' + (e && e.message), 'bad');
      return;
    }
    const wasCurrent = at === index;
    if (at >= 0) tracks.splice(at, 1);
    renderList();

    if (wasCurrent) {
      audio.pause();
      audio.removeAttribute('src');
      if (tracks.length) {
        // 删歌本身是个用户手势，接着播没问题
        playIndex(Math.min(index, tracks.length - 1), true, wantPlay);
      } else {
        index = -1;
        el.name.textContent = '还没有歌～';
        el.fill.style.width = '0%';
        el.cur.textContent = '0:00';
        el.dur.textContent = '0:00';
        syncPlayUI();
      }
    } else if (at >= 0 && at < index) {
      index--;
      localStorage.setItem(LS.idx, String(index));
      syncPlayUI();
    }
    toast('已删除「' + name + '」');
  }

  /* ---------------- 卡片开合 ---------------- */
  function openCard(open) {
    el.card.hidden = !open;
    root.classList.toggle('open', open);
    if (open) renderList();
  }

  /* ---------------- 事件绑定 ---------------- */
  el.vinyl.addEventListener('click', () => openCard(el.card.hidden));
  el.fold.addEventListener('click', () => openCard(false));

  el.play.addEventListener('click', toggle);
  el.next.addEventListener('click', () => next(true));
  el.prev.addEventListener('click', prev);

  // 点进度条跳转
  const seek = (e) => {
    const r = el.bar.getBoundingClientRect();
    const p = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      audio.currentTime = p * audio.duration;
      syncProgress();
    }
  };
  el.bar.addEventListener('pointerdown', (e) => {
    if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
    seek(e);
    const move = (ev) => seek(ev);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  // 音量
  const savedVol = Number(localStorage.getItem(LS.vol));
  audio.volume = Number.isFinite(savedVol) && savedVol >= 0 && savedVol <= 1 ? savedVol : 0.8;
  el.vol.value = String(Math.round(audio.volume * 100));
  const syncVolUI = () => {
    el.volIcon.innerHTML = audio.volume === 0 ? ic('volume-off') : audio.volume < 0.4 ? ic('volume-low') : ic('volume');
  };
  syncVolUI();
  el.vol.addEventListener('input', () => {
    audio.volume = Number(el.vol.value) / 100;
    localStorage.setItem(LS.vol, String(audio.volume));
    syncVolUI();
  });
  el.volIcon.addEventListener('click', () => {
    if (audio.volume > 0) {
      audio.dataset.prev = String(audio.volume);
      audio.volume = 0;
      el.vol.value = '0';
    } else {
      const back = Number(audio.dataset.prev);
      audio.volume = Number.isFinite(back) && back > 0 ? back : 0.8;
      el.vol.value = String(Math.round(audio.volume * 100));
    }
    localStorage.setItem(LS.vol, String(audio.volume));
    syncVolUI();
  });

  // 上传
  el.add.addEventListener('click', () => el.file.click());
  el.file.addEventListener('change', () => {
    addFiles(el.file.files);
    el.file.value = ''; // 同一批文件可以再选一次
  });

  // 拖音频到卡片上也能加歌
  root.addEventListener('dragover', (e) => { e.preventDefault(); root.classList.add('drop'); });
  root.addEventListener('dragleave', () => root.classList.remove('drop'));
  root.addEventListener('drop', (e) => {
    e.preventDefault();
    root.classList.remove('drop');
    addFiles(e.dataTransfer && e.dataTransfer.files);
  });

  // 音频事件
  audio.addEventListener('timeupdate', syncProgress);
  audio.addEventListener('loadedmetadata', syncProgress);
  audio.addEventListener('play', syncPlayUI);
  audio.addEventListener('pause', syncPlayUI);
  audio.addEventListener('ended', () => {
    // 依次轮播，最后一首播完回到第一首
    next(false);
  });
  audio.addEventListener('error', () => {
    if (!audio.src) return;
    toast('这首歌读不出来，跳到下一首', 'bad');
    setTimeout(() => next(false), 400);
  });

  // 浏览器拦自动播放时：用户点一下页面任意处就接着播
  const onGesture = () => {
    if (!awaitingGesture || !wantPlay) return;
    awaitingGesture = false;
    tryStart(true);
    showHint(false);
  };
  window.addEventListener('pointerdown', onGesture, { once: false });
  window.addEventListener('keydown', onGesture, { once: false });

  /* ---------------- 启动 ---------------- */
  async function init() {
    await refresh();

    const savedIdx = Number(localStorage.getItem(LS.idx));
    let start = Number.isInteger(savedIdx) && savedIdx >= 0 && savedIdx < tracks.length ? savedIdx : 0;

    if (tracks.length) {
      // 打开页面自动播放；上次是手动暂停的就只装载不打扰
      playIndex(start, false, wantPlay);
      if (wantPlay && (audio.paused || awaitingGesture)) {
        // 没播起来就给个提示，等用户点一下
        setTimeout(() => { if (audio.paused && wantPlay) showHint(true); }, 800);
      }
    } else {
      syncPlayUI();
    }

    ready = true;
    return api;
  }

  const api = {
    init,
    refresh,
    openCard,
    playById,
    trackById,
    get tracks() { return tracks; },
    get index() { return index; },
  };
  return api;
}
