// 回忆墙 + 设置
import { backup, reveal, reset, saveState } from './api.js';
import {
  openModal, toast, escapeHtml, fmtDate, isImage, isVideo, ic,
} from './ui.js';

/* ============ 回忆墙 ============ */
export function openGallery({ state, onOpenRecord, onChanged }) {
  let filterProvince = '';
  let filterTag = '';
  let keyword = '';

  const provinces = () => {
    const m = new Map();
    for (const r of state.records) {
      const p = (r.names && r.names[0]) || '未标注';
      m.set(p, (m.get(p) || 0) + 1);
    }
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
  };

  const tags = () => {
    const m = new Map();
    for (const r of state.records) for (const t of r.tags || []) m.set(t, (m.get(t) || 0) + 1);
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]).slice(0, 16);
  };

  const handle = openModal({
    title: '回忆墙',
    bodyHTML: '<div class="wall-filters" id="wFilters"></div><div id="wWall"></div>',
    footerHTML: '<button class="btn" data-x2>关闭</button>',
  });

  const filters = handle.el.querySelector('#wFilters');
  const wall = handle.el.querySelector('#wWall');
  handle.el.querySelector('[data-x2]').addEventListener('click', handle.close);

  function renderFilters() {
    filters.innerHTML = '';

    const search = document.createElement('input');
    search.type = 'text';
    search.placeholder = '搜标题、正文、标签…';
    search.value = keyword;
    search.style.flex = '1';
    search.style.minWidth = '180px';
    search.addEventListener('input', () => { keyword = search.value.trim(); renderWall(); });
    filters.appendChild(search);

    const mk = (label, active, onClick) => {
      const b = document.createElement('button');
      b.className = 'tag-chip' + (active ? ' on' : '');
      b.textContent = label;
      b.addEventListener('click', onClick);
      return b;
    };

    filters.appendChild(mk('全部', !filterProvince && !filterTag, () => {
      filterProvince = ''; filterTag = ''; renderFilters(); renderWall();
    }));

    for (const [p, n] of provinces()) {
      filters.appendChild(mk(p + ' ' + n, filterProvince === p, () => {
        filterProvince = filterProvince === p ? '' : p;
        renderFilters(); renderWall();
      }));
    }
    for (const [t, n] of tags()) {
      filters.appendChild(mk('#' + t + ' ' + n, filterTag === t, () => {
        filterTag = filterTag === t ? '' : t;
        renderFilters(); renderWall();
      }));
    }
  }

  function match(r) {
    if (filterProvince && ((r.names && r.names[0]) || '未标注') !== filterProvince) return false;
    if (filterTag && !(r.tags || []).includes(filterTag)) return false;
    if (keyword) {
      const hay = [r.title, r.text, (r.names || []).join(' '), (r.tags || []).join(' ')].join(' ').toLowerCase();
      if (!hay.includes(keyword.toLowerCase())) return false;
    }
    return true;
  }

  function renderWall() {
    const list = state.records.filter(match).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    wall.className = 'wall';
    if (!list.length) {
      wall.className = '';
      wall.innerHTML = '<div class="empty"><span class="ee">' + ic('gallery', 'lg') + '</span>' +
        (state.records.length ? '没有符合条件的回忆' : '还没有任何回忆<br>回到地图，点一个省份开始吧') + '</div>';
      return;
    }
    wall.innerHTML = '';
    for (const r of list) wall.appendChild(card(r));
  }

  function card(r) {
    const el = document.createElement('div');
    el.className = 'rec-card';
    const media = (r.media || []).filter((m) => !m.uploading);
    const cover = media.find((m) => isImage(m.type));

    el.innerHTML =
      (cover ? '<div style="border-radius:12px;overflow:hidden;margin:-4px -4px 11px;aspect-ratio:16/10;background:var(--surface)">' +
        '<img src="' + escapeHtml(cover.url) + '" alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover;display:block"></div>' : '') +
      '<div class="rc-top">' +
        '<span class="rc-mood">' + (r.mood || '💗') + '</span>' +
        '<span class="rc-title">' + escapeHtml(r.title || '无题') + '</span>' +
      '</div>' +
      '<div class="rc-place">' + ic('pin') + escapeHtml((r.names || []).join(' › ') || '未标注') + '</div>' +
      '<div class="rc-date" style="font-size:11px;color:var(--text-faint);margin-bottom:6px">' + escapeHtml(fmtDate(r.date)) + '</div>' +
      (r.text ? '<div class="rc-text">' + escapeHtml(r.text) + '</div>' : '') +
      ((r.tags || []).length ? '<div class="rc-media">' + r.tags.map((t) => '<span>#' + escapeHtml(t) + '</span>').join('') + '</div>' : '') +
      (r.bgmId ? '<div class="rc-media"><span class="rc-bgm">' + ic('note') + escapeHtml(r.bgmName || 'BGM') + '</span></div>' : '') +
      (media.length ? '<div class="rc-media"><span>' + ic('clip') + media.length + ' 个文件</span></div>' : '');

    el.addEventListener('click', () => {
      handle.close();
      if (onOpenRecord) onOpenRecord(r);
    });
    return el;
  }

  renderFilters();
  renderWall();
}

/* ============ 设置 ============ */
export function openSettings({ state, onChanged }) {
  const s = state.settings;

  const handle = openModal({
    title: '设置',
    narrow: true,
    bodyHTML:
      '<div class="setting-row">' +
        '<div class="sr-label"><b>你们的名字</b><span>显示在左上角，用「和」连起来</span></div>' +
      '</div>' +
      '<div style="display:flex;gap:8px;margin:8px 0 16px">' +
        '<input type="text" id="sNameA" maxlength="12" placeholder="你" value="' + escapeHtml(s.coupleNames[0] || '') + '">' +
        '<span style="align-self:center;color:var(--text-faint)">和</span>' +
        '<input type="text" id="sNameB" maxlength="12" placeholder="TA" value="' + escapeHtml(s.coupleNames[1] || '') + '">' +
      '</div>' +

      '<div class="setting-row">' +
        '<div class="sr-label"><b>在一起的第一天</b><span>用来算「在一起多少天」</span></div>' +
        '<div class="sr-ctl"><input type="date" id="sStart" value="' + escapeHtml(s.startDate || '') + '" style="width:170px"></div>' +
      '</div>' +

      '<div class="setting-row" style="margin-top:18px">' +
        '<div class="sr-label"><b>自己的纪念日</b><span>「第一次见面」「求婚日」…… 都会一起倒数</span></div>' +
        '<div class="sr-ctl"><button class="btn" id="sAnnAdd">加一个</button></div>' +
      '</div>' +
      '<div class="ann-list" id="sAnnList"></div>' +
      '<div class="ann-form" id="sAnnForm" hidden>' +
        '<input type="text" id="sAnnName" maxlength="12" placeholder="叫什么，比如「第一次见面」">' +
        '<input type="date" id="sAnnDate">' +
        '<button class="btn primary" id="sAnnOk">加上</button>' +
      '</div>' +

      '<div class="setting-row">' +
        '<div class="sr-label"><b>一句话签名</b><span>显示在名字下面</span></div>' +
      '</div>' +
      '<input type="text" id="sMotto" maxlength="40" value="' + escapeHtml(s.motto || '') + '" style="margin:8px 0 4px">' +

      '<div class="setting-row" style="margin-top:18px">' +
        '<div class="sr-label"><b>打开照片文件夹</b><span>照片视频都原样存在你电脑的这个目录里</span></div>' +
        '<div class="sr-ctl"><button class="btn" id="sReveal">打开</button></div>' +
      '</div>' +

      '<div class="setting-row">' +
        '<div class="sr-label"><b>备份一份</b><span>把全部记录和媒体复制到 backups/ 目录</span></div>' +
        '<div class="sr-ctl"><button class="btn" id="sBackup">立即备份</button></div>' +
      '</div>' +

      '<div class="setting-row">' +
        '<div class="sr-label"><b>导出 / 导入</b><span>导出一份记录清单 JSON，方便换电脑</span></div>' +
        '<div class="sr-ctl" style="display:flex;gap:8px">' +
          '<button class="btn" id="sExport">导出</button>' +
          '<button class="btn" id="sImport">导入</button>' +
        '</div>' +
      '</div>' +

      '<div class="setting-row" style="margin-top:18px">' +
        '<div class="sr-label"><b>危险操作</b><span>先想清楚再点</span></div>' +
      '</div>' +
      '<div class="danger-zone">' +
        '<div class="dz-row">' +
          '<div class="dz-text">' +
            '<b>清空回忆</b>' +
            '<em>记录全没了，但照片视频文件还留在磁盘上 —— 后悔了还能去文件夹里翻出来</em>' +
          '</div>' +
          '<button class="btn danger" id="sWipe">清空</button>' +
        '</div>' +
        '<div class="dz-row">' +
          '<div class="dz-text">' +
            '<b>初始化</b>' +
            '<em>恢复成刚装好的样子：回忆、名字、在一起的日期、签名、照片视频、头像、歌曲，全部删掉。动手前会自动备份一份到 backups/</em>' +
          '</div>' +
          '<button class="btn danger" id="sReset">初始化</button>' +
        '</div>' +
      '</div>' +
      '<input type="file" id="sImportFile" accept="application/json" hidden>',
    footerHTML: '<button class="btn" data-cancel>取消</button><button class="btn primary" data-save>保存</button>',
  });

  const q = (sel) => handle.el.querySelector(sel);
  q('[data-cancel]').addEventListener('click', handle.close);

  // 自己记的纪念日：先攒在本地，按「保存」才落盘
  const annDraft = (Array.isArray(s.anniversaries) ? s.anniversaries : [])
    .map((a) => ({ name: (a && a.name) || '', date: (a && a.date) || '' }))
    .filter((a) => a.date);

  function renderAnn() {
    const box = q('#sAnnList');
    if (!annDraft.length) {
      box.innerHTML = '<div class="ann-empty">还没记 —— 加一个吧，它会跟着天数一起倒数</div>';
      return;
    }
    box.innerHTML = annDraft.map((a, i) =>
      '<div class="ann-item">' +
        '<b>' + escapeHtml(a.name || '纪念日') + '</b>' +
        '<em>' + escapeHtml(fmtDate(a.date) || a.date) + '</em>' +
        '<button class="ann-del" data-i="' + i + '" title="删掉这个">' + ic('x') + '</button>' +
      '</div>'
    ).join('');
    box.querySelectorAll('.ann-del').forEach((btn) => {
      btn.addEventListener('click', () => {
        annDraft.splice(Number(btn.dataset.i), 1);
        renderAnn();
      });
    });
  }
  renderAnn();

  q('#sAnnAdd').addEventListener('click', () => {
    const form = q('#sAnnForm');
    form.hidden = !form.hidden;
    if (!form.hidden) q('#sAnnName').focus();
  });
  q('#sAnnOk').addEventListener('click', () => {
    const date = q('#sAnnDate').value;
    if (!date) { toast('先选个日子', 'bad'); return; }
    annDraft.push({ name: q('#sAnnName').value.trim() || '纪念日', date });
    q('#sAnnName').value = '';
    q('#sAnnDate').value = '';
    renderAnn();
  });

  q('[data-save]').addEventListener('click', async () => {
    s.coupleNames = [q('#sNameA').value.trim() || '我', q('#sNameB').value.trim() || '你'];
    s.startDate = q('#sStart').value;
    s.motto = q('#sMotto').value.trim() || '把每一次心动，都钉在地图上。';
    s.anniversaries = annDraft.slice();
    try {
      await saveState(state);
      toast('设置好了');
      handle.close();
      if (onChanged) onChanged();
    } catch (e) {
      toast('保存失败：' + e.message, 'bad');
    }
  });

  q('#sReveal').addEventListener('click', async () => {
    try { const r = await reveal(); toast('已打开：' + r.path, 'good', 3200); }
    catch (e) { toast('打不开：' + e.message, 'bad'); }
  });

  q('#sBackup').addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = '备份中…';
    try {
      const r = await backup();
      toast('备份好了：' + r.path, 'good', 4200);
    } catch (err) {
      toast('备份失败：' + err.message, 'bad');
    } finally {
      e.target.disabled = false;
      e.target.textContent = '立即备份';
    }
  });

  q('#sExport').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    a.href = URL.createObjectURL(blob);
    a.download = '我们的足迹-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast('已导出，媒体文件记得一起复制 data/media 目录');
  });

  q('#sImport').addEventListener('click', () => q('#sImportFile').click());
  q('#sImportFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const txt = await f.text();
      const data = JSON.parse(txt);
      if (!data || !Array.isArray(data.records)) throw new Error('文件格式不对');
      if (!confirm('导入会覆盖当前的全部记录（共 ' + state.records.length + ' 段），确定吗？')) return;
      state.records = data.records;
      if (data.settings) state.settings = { ...state.settings, ...data.settings };
      await saveState(state);
      toast('导入完成，共 ' + state.records.length + ' 段回忆');
      handle.close();
      if (onChanged) onChanged();
    } catch (err) {
      toast('导入失败：' + err.message, 'bad', 4000);
    }
  });

  q('#sWipe').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (!confirm('真的要清空全部 ' + state.records.length + ' 段回忆吗？这一步不可恢复。')) return;
    if (!confirm('再确认一次：照片视频文件不会自动删除，但记录会全部消失。继续？')) return;
    state.records = [];
    btn.disabled = true;
    try {
      await saveState(state);
      toast('已清空');
      handle.close();
      if (onChanged) onChanged();
    } catch (err) {
      toast('清空失败：' + err.message, 'bad');
    } finally {
      btn.disabled = false;
    }
  });

  // 初始化：全部恢复成刚装好的样子。服务端动手前会自己先备份，
  // 所以这里的确认要说清楚「会删什么」，而不是只喊一句不可恢复。
  q('#sReset').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const n = state.records.length;
    if (!confirm(
      '这会把一切恢复成刚装好的样子：\n\n' +
      '· ' + n + ' 段回忆记录\n' +
      '· 你们的名字、在一起的日期、签名、纪念日\n' +
      '· 照片和视频文件\n' +
      '· 两个头像\n' +
      '· 上传的歌曲\n\n' +
      '真的要继续吗？'
    )) return;
    if (!confirm(
      '最后确认一次。\n\n' +
      '会先自动备份到 backups/ 目录，但备份也可能丢 ——\n' +
      '真正重要的东西，请自己另外存一份。\n\n' +
      '点「确定」就动手了。'
    )) return;

    btn.disabled = true;
    btn.textContent = '初始化中…';
    try {
      const r = await reset();
      const where = r && r.backup ? r.backup : 'backups/';
      toast('初始化完成，备份在 ' + where, 'good', 6000);
      // 页面上的状态全是旧的，与其一块块抹，不如整页重来
      setTimeout(() => location.reload(), 1000);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = '初始化';
      toast('初始化失败：' + err.message, 'bad');
    }
  });
}
