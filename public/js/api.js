// 与本地服务通信。所有数据都落在本机，不经过任何第三方。

async function req(url, opts = {}) {
  const res = await fetch(url, opts);
  const type = res.headers.get('content-type') || '';
  if (!res.ok) {
    let msg = res.status + ' ' + res.statusText;
    if (type.includes('json')) {
      try { msg = (await res.json()).error || msg; } catch { /* 忽略 */ }
    }
    throw new Error(msg);
  }
  return type.includes('json') ? res.json() : res.text();
}

/** 读取全部记录与设置 */
export const loadState = () => req('/api/state');

/** 覆盖写入全部记录与设置 —— 是**整体覆盖**，不是合并。
 *  state.records 少一条，服务上就少一条。只拿完整、刚从 loadState 改过的对象来调。 */
export const saveState = (state) =>
  req('/api/state', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(state),
  });

/**
 * 上传一个文件（原始二进制流），onProgress(0~1)
 * 返回 { mediaId, name, type, ext, size, url }
 */
export function uploadMedia(recordId, mediaId, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/media/' + encodeURIComponent(recordId) + '/' + encodeURIComponent(mediaId));
    xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name || ''));
    xhr.setRequestHeader('x-file-type', file.type || 'application/octet-stream');
    if (file.type) xhr.setRequestHeader('content-type', file.type);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); }
        catch { reject(new Error('服务器返回异常')); }
      } else {
        let msg = '上传失败（' + xhr.status + '）';
        try { msg = JSON.parse(xhr.responseText).error || msg; } catch { /* 忽略 */ }
        reject(new Error(msg));
      }
    };
    xhr.onerror = () => reject(new Error('上传中断，检查服务是否还在运行'));
    xhr.ontimeout = () => reject(new Error('上传超时'));
    xhr.send(file);
  });
}

export const deleteMedia = (recordId, mediaId) =>
  req('/api/media/' + encodeURIComponent(recordId) + '/' + encodeURIComponent(mediaId), { method: 'DELETE' });

export const deleteRecordFiles = (recordId) =>
  req('/api/records/' + encodeURIComponent(recordId), { method: 'DELETE' });

/* ---------------- 头像（一对） ---------------- */

/** 取两个头像位置 { avatars: [{ slot, url, name }] } */
export const loadAvatars = () => req('/api/avatar');

/**
 * 上传 / 覆盖一个头像（slot 只能是 0 或 1）
 * 返回 { slot, url, name, size }
 */
export function uploadAvatar(slot, file) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/avatar/' + encodeURIComponent(slot));
    xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name || ''));
    xhr.setRequestHeader('x-file-type', file.type || 'application/octet-stream');
    if (file.type) xhr.setRequestHeader('content-type', file.type);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); }
        catch { reject(new Error('服务器返回异常')); }
      } else {
        let msg = '上传失败（' + xhr.status + '）';
        try { msg = JSON.parse(xhr.responseText).error || msg; } catch { /* 忽略 */ }
        reject(new Error(msg));
      }
    };
    xhr.onerror = () => reject(new Error('上传中断，检查服务是否还在运行'));
    xhr.send(file);
  });
}

export const deleteAvatar = (slot) =>
  req('/api/avatar/' + encodeURIComponent(slot), { method: 'DELETE' });

/* ---------------- 歌单 ---------------- */

/** 取歌单 { tracks: [...] } */
export const loadMusic = () => req('/api/music');

/**
 * 上传一首歌（原始二进制流），onProgress(0~1)
 * 返回 { track, count }
 */
export function uploadTrack(trackId, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/music/' + encodeURIComponent(trackId));
    xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name || ''));
    xhr.setRequestHeader('x-file-type', file.type || 'audio/mpeg');
    if (file.type) xhr.setRequestHeader('content-type', file.type);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); }
        catch { reject(new Error('服务器返回异常')); }
      } else {
        let msg = '上传失败（' + xhr.status + '）';
        try { msg = JSON.parse(xhr.responseText).error || msg; } catch { /* 忽略 */ }
        reject(new Error(msg));
      }
    };
    xhr.onerror = () => reject(new Error('上传中断，检查服务是否还在运行'));
    xhr.ontimeout = () => reject(new Error('上传超时'));
    xhr.send(file);
  });
}

export const deleteTrack = (trackId) =>
  req('/api/music/' + encodeURIComponent(trackId), { method: 'DELETE' });

/** 把整个 data/ 复制一份到 backups/ */
export const backup = () => req('/api/backup', { method: 'POST' });

/** 初始化：恢复成刚装好的样子（回忆、设置、照片视频、头像、歌曲全清）。
 *  服务端动手前会自己先备份一份，返回 { ok, backup, counts }。 */
export const reset = () =>
  req('/api/reset', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirm: 'reset' }),
  });

/** 在资源管理器里打开照片视频所在目录 */
export const reveal = () => req('/api/reveal', { method: 'POST' });

/** 地图数据地址 */
export const geoUrl = (level, adcode) => {
  if (level === 'country') return '/geo/china.json';
  if (level === 'province') return '/geo/prov/' + adcode + '.json';
  return '/geo/city/' + adcode + '.json';
};

const geoCache = new Map();

/** 拉取某级地图数据（带内存缓存） */
export async function loadGeo(level, adcode) {
  const url = geoUrl(level, adcode);
  if (geoCache.has(url)) return geoCache.get(url);
  const p = fetch(url)
    .then((r) => {
      if (!r.ok) throw new Error('地图数据缺失：' + url);
      return r.json();
    })
    .catch((e) => { geoCache.delete(url); throw e; });
  geoCache.set(url, p);
  return p;
}
