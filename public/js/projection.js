// 地图投影：Albers 等积圆锥投影（中国常用参数）
// 只用了一个全国范围的投影，放大靠动画改 viewBox，这样层级切换时几何完全连续。

const RAD = Math.PI / 180;

/** 生成 Albers 投影函数，输入 [经度, 纬度]，输出投影平面坐标（y 轴向下，适配 SVG） */
export function makeAlbers({ lon0 = 105, lat0 = 35, lat1 = 25, lat2 = 47 } = {}) {
  const s1 = Math.sin(lat1 * RAD);
  const s2 = Math.sin(lat2 * RAD);
  const n = (s1 + s2) / 2;
  const C = Math.cos(lat1 * RAD) ** 2 + 2 * n * s1;
  const rho0 = Math.sqrt(Math.max(0, C - 2 * n * Math.sin(lat0 * RAD))) / n;

  return function project([lon, lat]) {
    const theta = n * (lon - lon0) * RAD;
    const rho = Math.sqrt(Math.max(0, C - 2 * n * Math.sin(lat * RAD))) / n;
    return [rho * Math.sin(theta), rho * Math.cos(theta)];
  };
}

/** 遍历一个几何体的所有环（Polygon 的外环 + 内环，MultiPolygon 展开） */
export function eachRing(geometry, cb) {
  if (!geometry) return;
  const c = geometry.coordinates;
  if (!c) return;
  if (geometry.type === 'Polygon') {
    for (const ring of c) cb(ring);
  } else if (geometry.type === 'MultiPolygon') {
    for (const poly of c) for (const ring of poly) cb(ring);
  }
}

/**
 * 用一批 feature 建立一个「装进指定画布」的投影。
 * 返回 { project, bounds, scale }，bounds 是投影后包围盒。
 */
export function createProjection(features, { width, height, padding = 26 } = {}) {
  const base = makeAlbers();

  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const f of features) {
    eachRing(f.geometry, (ring) => {
      for (let i = 0; i < ring.length; i++) {
        const [x, y] = base(ring[i]);
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    });
  }
  if (!Number.isFinite(x0)) { x0 = 0; y0 = 0; x1 = 1; y1 = 1; }

  const w = x1 - x0 || 1;
  const h = y1 - y0 || 1;
  const pad = Math.min(padding, width / 6, height / 6);
  const s = Math.min((width - pad * 2) / w, (height - pad * 2) / h);
  const tx = (width - w * s) / 2 - x0 * s;
  const ty = (height - h * s) / 2 - y0 * s;

  const project = (pt) => {
    const [x, y] = base(pt);
    return [x * s + tx, y * s + ty];
  };

  return {
    project,
    scale: s,
    bounds: { x0: tx + x0 * s, y0: ty + y0 * s, x1: tx + x1 * s, y1: ty + y1 * s },
  };
}

/** 几何体 → SVG path 的 d 字符串 */
export function geoToPath(geometry, project, precision = 2) {
  let d = '';
  eachRing(geometry, (ring) => {
    if (!ring || ring.length < 3) return;
    for (let i = 0; i < ring.length; i++) {
      const p = project(ring[i]);
      if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
      d += (i === 0 ? 'M' : 'L') + p[0].toFixed(precision) + ' ' + p[1].toFixed(precision);
    }
    d += 'Z';
  });
  return d;
}

/** feature 的投影后包围盒 */
export function featureBounds(feature, project) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  eachRing(feature.geometry, (ring) => {
    for (let i = 0; i < ring.length; i++) {
      const [x, y] = project(ring[i]);
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  });
  if (!Number.isFinite(x0)) return { x0: 0, y0: 0, x1: 0, y1: 0, w: 0, h: 0 };
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

/** feature 的代表点：优先用数据自带的 centroid，其次 center，最后退回包围盒中心 */
export function featureCenter(feature, project) {
  const props = feature.properties || {};
  const c = props.centroid || props.center;
  if (Array.isArray(c) && c.length >= 2 && Number.isFinite(+c[0]) && Number.isFinite(+c[1])) {
    const p = project([+c[0], +c[1]]);
    if (Number.isFinite(p[0]) && Number.isFinite(p[1])) return p;
  }
  const b = featureBounds(feature, project);
  return [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2];
}

/** 两点球面距离（公里） */
export function haversine(a, b) {
  const R = 6371;
  const dLat = (b[1] - a[1]) * RAD;
  const dLon = (b[0] - a[0]) * RAD;
  const la1 = a[1] * RAD;
  const la2 = b[1] * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 取出 feature 上能用的经纬度点（记录用的锚点） */
export function featureLngLat(feature) {
  const props = feature.properties || {};
  const c = props.centroid || props.center;
  if (Array.isArray(c) && c.length >= 2) return [+c[0], +c[1]];
  return null;
}
