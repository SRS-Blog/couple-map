// 记忆编辑面板：写文字、传照片视频、配 BGM、存下来
import { uploadMedia, deleteMedia, deleteRecordFiles, saveState, loadMusic } from './api.js';
import {
  $, ic, escapeHtml, uid, toast, today, fmtDate, fmtSize,
  openPicker, openModal, openViewer, isImage, isVideo,
} from './ui.js';

const MOODS = ['😍', '🥰', '😆', '🌧️', '🍜', '🏔️', '🎂', '💤', '🌅', '🎡'];
const PRESET_TAGS = ['第一次', '纪念日', '美食', '看海', '爬山', '咖啡', '电影', '生日', '惊喜', '夜宵', '吵架和好'];

export function createPanel({ panelEl, getState, onChange, player }) {
  let draft = null;
  let savedRecord = null;
  let panelOpen = false;

  panelEl.innerHTML =
    // 拖拽把手：手机上把面板改成底部抽屉之后，上推展开、下拉收起。
    // 桌面上 CSS 把它 display:none，这段手势也就无从触发。
    '<div class="panel-grip" id="pGrip" role="separator" aria-label="拖动调整面板高度"></div>' +
    '<div class="panel-head">' +
      '<div class="ph-text">' +
        '<div class="ph-region">' + ic('pin') + ' <span id="pPlace">—</span></div>' +
        '<h2 id="pTitle">写点什么</h2>' +
      '</div>' +
      '<button class="panel-close" id="pClose" title="关闭">' + ic('x') + '</button>' +
    '</div>' +
    '<div class="panel-body">' +
      '<div class="field">' +
        '<label>地点 <span class="hintline">点右边可以改成别的地方</span></label>' +
        '<div style="display:flex;gap:8px;align-items:center">' +
          '<div id="pPathText" style="flex:1;font-size:13px;color:var(--text-soft);overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></div>' +
          '<button class="btn" id="pPick" style="padding:7px 12px;font-size:12px">更改</button>' +
        '</div>' +
      '</div>' +

      '<div class="field"><label>给这段回忆起个名字</label>' +
        '<input type="text" id="fTitle" maxlength="60" placeholder="比如：第一次一起看海"></div>' +

      '<div class="field"><label>日期</label>' +
        '<input type="date" id="fDate"></div>' +

      '<div class="field"><label>那天的心情</label>' +
        '<div class="moods" id="fMoods"></div></div>' +

      '<div class="field"><label>想说点什么</label>' +
        '<textarea id="fText" placeholder="那天风很大，你把外套给了我……"></textarea></div>' +

      '<div class="field"><label>照片 / 视频 <span class="hintline">会保存在你自己电脑上</span></label>' +
        '<div class="dropzone" id="fDrop">' +
          '<span class="dz-emoji">' + ic('camera') + '</span>' +
          '<div class="dz-main">点这里选文件，或者直接拖进来</div>' +
          '<div class="dz-sub">支持图片和视频，可以一次选多个</div>' +
        '</div>' +
        '<input type="file" id="fFile" multiple accept="image/*,video/*" hidden>' +
        '<div class="media-grid" id="fGrid"></div>' +
      '</div>' +

      '<div class="field"><label>贴个标签</label>' +
        '<div class="tag-row" id="fTags"></div>' +
        '<input type="text" id="fTagNew" placeholder="也可以自己写一个，回车添加" style="margin-top:8px">' +
      '</div>' +

      '<div class="field"><label>配一首 BGM <span class="hintline">点开这段回忆时就放它</span></label>' +
        '<div class="bgm-row">' +
          '<div class="bgm-cur" id="fBgm"><span class="bgm-note">' + ic('note') + '</span><span class="bgm-name">不配音乐</span></div>' +
          '<button class="btn" id="fBgmPick" style="flex:0 0 auto;padding:7px 12px;font-size:12px">选一首</button>' +
          '<button class="btn" id="fBgmPlay" style="flex:0 0 auto;padding:7px 12px;font-size:12px" hidden>试听</button>' +
          '<button class="btn" id="fBgmClear" style="flex:0 0 auto;padding:7px 12px;font-size:12px" hidden>去掉</button>' +
        '</div>' +
      '</div>' +

      '<div class="field" style="margin-top:22px">' +
        '<label>这个地点已有的回忆 <span class="hintline" id="pCount"></span></label>' +
        '<div id="pExisting"></div>' +
      '</div>' +
    '</div>' +
    '<div class="panel-foot">' +
      '<button class="btn danger" id="pDelete" style="flex:0 0 auto">删除</button>' +
      '<button class="btn primary" id="pSave">保存这段回忆</button>' +
    '</div>';

  const el = {
    place: $('#pPlace', panelEl),
    title: $('#pTitle', panelEl),
    pathText: $('#pPathText', panelEl),
    pick: $('#pPick', panelEl),
    fTitle: $('#fTitle', panelEl),
    fDate: $('#fDate', panelEl),
    fMoods: $('#fMoods', panelEl),
    fText: $('#fText', panelEl),
    fDrop: $('#fDrop', panelEl),
    fFile: $('#fFile', panelEl),
    fGrid: $('#fGrid', panelEl),
    fTags: $('#fTags', panelEl),
    fTagNew: $('#fTagNew', panelEl),
    fBgm: $('#fBgm', panelEl),
    fBgmPick: $('#fBgmPick', panelEl),
    fBgmPlay: $('#fBgmPlay', panelEl),
    fBgmClear: $('#fBgmClear', panelEl),
    pExisting: $('#pExisting', panelEl),
    pCount: $('#pCount', panelEl),
    pSave: $('#pSave', panelEl),
    pDelete: $('#pDelete', panelEl),
    pClose: $('#pClose', panelEl),
  };

  /* ---------- 心情 ---------- */
  function renderMoods() {
    el.fMoods.innerHTML = '';
    for (const m of MOODS) {
      const b = document.createElement('button');
      b.className = 'mood' + (draft.mood === m ? ' on' : '');
      b.textContent = m;
      b.type = 'button';
      b.addEventListener('click', () => {
        draft.mood = draft.mood === m ? '' : m;
        renderMoods();
      });
      el.fMoods.appendChild(b);
    }
  }

  /* ---------- 标签 ---------- */
  function renderTags() {
    el.fTags.innerHTML = '';
    const all = PRESET_TAGS.concat((draft.tags || []).filter((t) => !PRESET_TAGS.includes(t)));
    for (const t of all) {
      const b = document.createElement('button');
      b.className = 'tag-chip' + (draft.tags.includes(t) ? ' on' : '');
      b.type = 'button';
      b.textContent = t;
      b.addEventListener('click', () => {
        const i = draft.tags.indexOf(t);
        if (i >= 0) draft.tags.splice(i, 1);
        else draft.tags.push(t);
        renderTags();
      });
      el.fTags.appendChild(b);
    }
  }

  /* ---------- BGM ---------- */
  function renderBgm() {
    const has = !!draft.bgmId;
    el.fBgm.querySelector('.bgm-name').textContent = has ? (draft.bgmName || '这首歌') : '不配音乐';
    el.fBgm.classList.toggle('on', has);
    el.fBgmPlay.hidden = !has;
    el.fBgmClear.hidden = !has;
    el.fBgmPick.textContent = has ? '换一首' : '选一首';
  }

  // 从歌单里挑一首挂到这段回忆上
  async function pickBgm() {
    let lib;
    try { lib = await loadMusic(); } catch (e) {
      toast('读不到歌单：' + e.message, 'bad');
      return;
    }
    const tracks = (lib && lib.tracks) || [];
    const rows = [
      '<div class="bgm-none" data-id="">' + ic('volume-off') + ' 不配音乐</div>',
    ].concat(tracks.map((t) => (
      '<div class="bgm-opt' + (t.id === draft.bgmId ? ' on' : '') + '" data-id="' + escapeHtml(t.id) + '" data-name="' + escapeHtml(t.name) + '">' +
        '<span class="bgm-note">' + ic('note') + '</span>' +
        '<span class="bgm-name">' + escapeHtml(t.name) + '</span>' +
        '<span class="bgm-size">' + fmtSize(t.size || 0) + '</span>' +
      '</div>'
    ))).join('');

    openModal({
      title: '挑一首 BGM',
      narrow: true,
      bodyHTML: tracks.length
        ? '<div class="bgm-list">' + rows + '</div>' +
          '<div class="hintline" style="margin-top:12px">点一首就选好了，顺便试听一下 ♪</div>'
        : '<div class="empty"><span class="ee">' + ic('headphones', 'lg') + '</span>歌单还是空的<br>先去右下角唱片那儿点「＋ 上传」加一首吧</div>',
      onMount: (h) => {
        h.el.querySelectorAll('.bgm-opt, .bgm-none').forEach((row) => {
          row.addEventListener('click', () => {
            const id = row.dataset.id || '';
            const name = row.dataset.name || '';
            draft.bgmId = id;
            draft.bgmName = id ? name : '';
            renderBgm();
            h.close();
            if (id && player) player.playById(id); // 选完直接试听
          });
        });
      },
    });
  }

  /* ---------- 媒体 ---------- */
  function renderGrid() {
    el.fGrid.innerHTML = '';
    for (const m of draft.media) {
      const item = document.createElement('div');
      item.className = 'media-item' + (m.uploading ? ' uploading' : '');

      if (m.uploading) {
        item.innerHTML = '<div class="prog"><i style="width:' + Math.round((m.progress || 0) * 100) + '%"></i></div>' +
          '<div class="prog-num">' + Math.round((m.progress || 0) * 100) + '%</div>';
      } else if (isVideo(m.type)) {
        item.innerHTML = '<video src="' + escapeHtml(m.url) + '" muted preload="metadata"></video><span class="badge">视频</span>';
      } else {
        item.innerHTML = '<img src="' + escapeHtml(m.url) + '" alt="" loading="lazy">';
      }

      if (!m.uploading) {
        const rm = document.createElement('button');
        rm.className = 'rm';
        rm.innerHTML = ic('x');
        rm.title = '移除';
        rm.addEventListener('click', async (e) => {
          e.stopPropagation();
          draft.media = draft.media.filter((x) => x.mediaId !== m.mediaId);
          renderGrid();
          try { await deleteMedia(draft.id, m.mediaId); } catch { /* 文件可能已经不在了 */ }
        });
        item.appendChild(rm);

        item.addEventListener('click', () => {
          const list = draft.media.filter((x) => !x.uploading).map((x) => ({ url: x.url, type: x.type, name: x.name }));
          openViewer(list, list.findIndex((x) => x.url === m.url));
        });
      }

      el.fGrid.appendChild(item);
    }
  }

  async function handleFiles(files) {
    const arr = Array.from(files || []).filter((f) => isImage(f.type) || isVideo(f.type));
    if (!arr.length) {
      toast('只认图片和视频哦', 'bad');
      return;
    }
    for (const file of arr) {
      const mediaId = uid('m');
      const tile = {
        mediaId, name: file.name, type: file.type, size: file.size,
        url: '', uploading: true, progress: 0,
      };
      draft.media.push(tile);
      renderGrid();

      try {
        const res = await uploadMedia(draft.id, mediaId, file, (p) => {
          tile.progress = p;
          const node = el.fGrid.querySelectorAll('.media-item')[draft.media.indexOf(tile)];
          if (node) {
            const bar = node.querySelector('.prog i');
            const num = node.querySelector('.prog-num');
            if (bar) bar.style.width = Math.round(p * 100) + '%';
            if (num) num.textContent = Math.round(p * 100) + '%';
          }
        });
        tile.uploading = false;
        tile.url = res.url;
        tile.name = res.name || tile.name;
        tile.type = res.type || tile.type;
        tile.size = res.size || tile.size;
        tile.ext = res.ext;
      } catch (e) {
        draft.media = draft.media.filter((x) => x !== tile);
        toast('「' + file.name + '」上传失败：' + e.message, 'bad', 4000);
      }
      renderGrid();
    }
  }

  /* ---------- 已有回忆列表 ---------- */
  function renderExisting() {
    const state = getState();
    const list = state.records
      .filter((r) => r.adcode === draft.adcode && r.id !== draft.id)
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

    el.pCount.textContent = list.length ? '共 ' + list.length + ' 段' : '';
    if (!list.length) {
      el.pExisting.innerHTML = '<div class="empty" style="padding:16px"><span class="ee">' + ic('pen', 'lg') + '</span>这里还是空白，等你写下第一段</div>';
      return;
    }
    el.pExisting.innerHTML = '';
    for (const r of list) {
      el.pExisting.appendChild(recordCard(r, () => open(regionOfRecord(r), r)));
    }
  }

  function regionOfRecord(r) {
    const names = Array.isArray(r.names) ? r.names : [r.placeName || ''];
    const path = Array.isArray(r.path) ? r.path : [r.adcode];
    return {
      adcode: r.adcode,
      name: names[names.length - 1] || '',
      path: path.map((ad, i) => ({ adcode: ad, name: names[i] || '' })),
      lnglat: r.lnglat || null,
    };
  }

  /* ---------- 记录卡片（面板内复用） ---------- */
  function recordCard(r, onClick) {
    const card = document.createElement('div');
    card.className = 'rec-card';
    const media = Array.isArray(r.media) ? r.media : [];
    const imgs = media.filter((m) => isImage(m.type)).length;
    const vids = media.filter((m) => isVideo(m.type)).length;
    card.innerHTML =
      '<div class="rc-top">' +
        '<span class="rc-mood">' + (r.mood || '💗') + '</span>' +
        '<span class="rc-title">' + escapeHtml(r.title || '无题') + '</span>' +
        '<span class="rc-date">' + escapeHtml(r.date || '') + '</span>' +
      '</div>' +
      (r.names ? '<div class="rc-place">' + ic('pin') + escapeHtml(r.names.join(' › ')) + '</div>' : '') +
      (r.text ? '<div class="rc-text">' + escapeHtml(r.text) + '</div>' : '') +
      (r.bgmId ? '<div class="rc-media"><span>' + ic('note') + escapeHtml(r.bgmName || 'BGM') + '</span></div>' : '') +
      ((imgs || vids) ? '<div class="rc-media">' +
        (imgs ? '<span>' + ic('camera') + imgs + ' 张照片</span>' : '') +
        (vids ? '<span>' + ic('video') + vids + ' 段视频</span>' : '') + '</div>' : '');
    if (onClick) card.addEventListener('click', onClick);
    return card;
  }

  /* ---------- 打开 / 关闭 ---------- */
  function fillForm() {
    el.fTitle.value = draft.title || '';
    el.fDate.value = draft.date || today();
    el.fText.value = draft.text || '';
    el.pathText.textContent = (draft.names || []).join(' › ') || draft.name || '—';
    el.place.textContent = (draft.names || []).join(' › ') || draft.name || '—';
    el.title.textContent = savedRecord ? '编辑这段回忆' : '写点什么';
    el.pDelete.style.display = savedRecord ? '' : 'none';
    el.pSave.textContent = savedRecord ? '保存修改' : '保存这段回忆';
    renderMoods();
    renderTags();
    renderBgm();
    renderGrid();
    renderExisting();
  }

  function open(region, record) {
    // 关掉上一个草稿：如果传过文件但没保存，把孤儿文件清掉
    if (draft && !savedRecord && draft.media && draft.media.length && draft.id) {
      deleteRecordFiles(draft.id).catch(() => {});
    }

    const names = (region.path || []).map((p) => p.name).filter(Boolean);
    if (record) {
      savedRecord = record;
      draft = {
        ...record,
        path: Array.isArray(record.path) ? record.path.slice() : [record.adcode],
        names: Array.isArray(record.names) ? record.names.slice() : names,
        tags: Array.isArray(record.tags) ? record.tags.slice() : [],
        media: Array.isArray(record.media) ? record.media.map((m) => ({ ...m })) : [],
        bgmId: record.bgmId || '',
        bgmName: record.bgmName || '',
      };
    } else {
      savedRecord = null;
      draft = {
        id: uid('r'),
        adcode: region.adcode,
        path: (region.path || []).map((p) => p.adcode),
        names,
        title: '',
        text: '',
        date: today(),
        mood: '💗',
        tags: [],
        media: [],
        bgmId: '',
        bgmName: '',
        lnglat: region.lnglat || null,
        createdAt: new Date().toISOString(),
      };
    }

    panelEl.classList.add('open');
    panelEl.classList.remove('tall'); // 上次拖出来的高度不带到这次
    panelEl.setAttribute('aria-hidden', 'false');
    document.body.classList.add('panel-open'); // 右下角的音乐播放器会往左让一让
    panelOpen = true;
    fillForm();
    setTimeout(() => el.fTitle.focus(), 320);

    // 这段回忆配了 BGM 就放它 —— 打开回忆自带 BGM
    if (draft.bgmId && player) {
      Promise.resolve(player.playById(draft.bgmId)).then((ok) => {
        if (!ok) toast('这首歌不在歌单里了，BGM 等你换一首', 'bad');
      });
    }
  }

  function close() {
    if (draft && !savedRecord && draft.media && draft.media.length && draft.id) {
      deleteRecordFiles(draft.id).catch(() => {});
    }
    panelEl.classList.remove('open');
    panelEl.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('panel-open');
    panelOpen = false;
    draft = null;
    savedRecord = null;
  }

  /* ---------- 保存 / 删除 ---------- */
  async function save() {
    if (!draft) return;
    if (!draft.title.trim() && !draft.text.trim() && !draft.media.length) {
      toast('至少写个名字、写句话，或者放张照片吧', 'bad');
      el.fTitle.focus();
      return;
    }
    if (draft.media.some((m) => m.uploading)) {
      toast('还有文件在上传，等一下下', 'bad');
      return;
    }

    el.pSave.disabled = true;
    const state = getState();
    const rec = {
      id: draft.id,
      adcode: draft.adcode,
      path: draft.path.slice(),
      names: draft.names.slice(),
      title: draft.title.trim(),
      text: draft.text.trim(),
      date: draft.date || today(),
      mood: draft.mood || '💗',
      tags: draft.tags.slice(),
      bgmId: draft.bgmId || '',
      bgmName: draft.bgmId ? (draft.bgmName || '') : '',
      media: draft.media.map((m) => ({
        mediaId: m.mediaId, name: m.name, type: m.type,
        size: m.size, ext: m.ext, url: m.url,
      })),
      lnglat: draft.lnglat || null,
      createdAt: draft.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const idx = state.records.findIndex((r) => r.id === rec.id);
    const isNew = idx < 0;
    if (isNew) state.records.push(rec);
    else state.records[idx] = rec;

    try {
      await saveState(state);
      savedRecord = rec;
      draft = { ...rec, tags: rec.tags.slice(), media: rec.media.map((m) => ({ ...m })) };
      fillForm();
      toast(isNew ? '记下了 ❤ 这个地方亮起来了' : '改好了');
      if (onChange) onChange({ type: 'save', record: rec, isNew });
    } catch (e) {
      toast('保存失败：' + e.message, 'bad', 4000);
    } finally {
      el.pSave.disabled = false;
    }
  }

  async function remove() {
    if (!savedRecord) return;
    if (!confirm('删掉这段回忆吗？照片和视频也会一起删掉，删了就找不回来了。')) return;

    const removed = savedRecord;
    const state = getState();
    state.records = state.records.filter((r) => r.id !== removed.id);
    try {
      await saveState(state);
      await deleteRecordFiles(removed.id);
      toast('已经删掉了');
      // 走统一的 close()：这里以前是手抄的一份，漏掉了 body.panel-open，
      // 删完回忆后手机上的图例、天数徽章就再也不回来了
      close();
      if (onChange) onChange({ type: 'delete', record: removed });
    } catch (e) {
      toast('删除失败：' + e.message, 'bad', 4000);
    }
  }

  /* ---------- 事件绑定 ---------- */

  /* 把手拖拽：上推展开到几乎全屏，下拉收起。
     拖的过程中直接改 height（关掉过渡才跟手），松手再交回 CSS 的 dvh 规则去收边。 */
  (function bindGrip() {
    const grip = panelEl.querySelector('#pGrip');
    if (!grip) return;
    let startY = 0;
    let startH = 0;
    let dragging = false;

    const MIN_H = 160;

    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      dragging = true;
      startY = e.clientY;
      startH = panelEl.offsetHeight;
      panelEl.style.transition = 'none';
      try { grip.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
    });

    grip.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const h = Math.max(MIN_H, startH - (e.clientY - startY));
      panelEl.style.height = h + 'px';
    });

    const settle = (e) => {
      if (!dragging) return;
      dragging = false;
      try { grip.releasePointerCapture(e.pointerId); } catch { /* 忽略 */ }
      panelEl.style.transition = '';

      const h = panelEl.offsetHeight;
      const vh = window.innerHeight;
      panelEl.style.height = ''; // 交回 CSS：72dvh / .tall 的 92dvh / 关闭时的 translateY

      if (h < vh * 0.35) close();
      else panelEl.classList.toggle('tall', h > vh * 0.82);
    };
    grip.addEventListener('pointerup', settle);
    grip.addEventListener('pointercancel', settle);
  })();

  el.pClose.addEventListener('click', close);
  el.pSave.addEventListener('click', save);
  el.pDelete.addEventListener('click', remove);
  el.fTitle.addEventListener('input', () => { if (draft) draft.title = el.fTitle.value; });
  el.fText.addEventListener('input', () => { if (draft) draft.text = el.fText.value; });
  el.fDate.addEventListener('change', () => { if (draft) draft.date = el.fDate.value; });

  el.fTagNew.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const v = el.fTagNew.value.trim();
    if (!v || !draft) return;
    if (!draft.tags.includes(v)) draft.tags.push(v);
    el.fTagNew.value = '';
    renderTags();
  });

  el.fBgmPick.addEventListener('click', () => { if (draft) pickBgm(); });
  el.fBgmPlay.addEventListener('click', () => {
    if (!draft || !draft.bgmId) return;
    if (!player) return;
    Promise.resolve(player.playById(draft.bgmId)).then((ok) => {
      if (!ok) toast('这首歌不在歌单里了，换一首吧', 'bad');
    });
  });
  el.fBgmClear.addEventListener('click', () => {
    if (!draft) return;
    draft.bgmId = '';
    draft.bgmName = '';
    renderBgm();
    toast('不配音乐了');
  });

  el.fDrop.addEventListener('click', () => el.fFile.click());
  el.fFile.addEventListener('change', () => {
    handleFiles(el.fFile.files);
    el.fFile.value = '';
  });
  ['dragenter', 'dragover'].forEach((t) =>
    el.fDrop.addEventListener(t, (e) => { e.preventDefault(); el.fDrop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) =>
    el.fDrop.addEventListener(t, (e) => { e.preventDefault(); el.fDrop.classList.remove('over'); }));
  el.fDrop.addEventListener('drop', (e) => {
    if (e.dataTransfer && e.dataTransfer.files) handleFiles(e.dataTransfer.files);
  });

  el.pick.addEventListener('click', () => {
    if (!draft) return;
    openPicker({
      startPath: (draft.path || []).map((ad, i) => ({ adcode: ad, name: (draft.names || [])[i] || '' })),
      onPick: (path) => {
        draft.path = path.map((p) => p.adcode);
        draft.names = path.map((p) => p.name);
        draft.adcode = path[path.length - 1].adcode;
        draft.lnglat = null;
        fillForm();
        toast('地点改成「' + draft.names.join(' › ') + '」了');
      },
    });
  });

  return { open, close, isOpen: () => panelOpen, getDraft: () => draft };
}
