// 拉取中国行政区划 GeoJSON（省 / 市 / 区县三级），全部落盘到 data/geo
// 数据源：阿里云 DataV.GeoAtlas
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const OUT = path.join(ROOT, 'data', 'geo');
const BASE = 'https://geo.datav.aliyun.com/areas_v3/bound';
const CONC = 10;

const ensure = (d) => fs.mkdirSync(d, { recursive: true });

async function get(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const t = await r.text();
      if (!t || t.length < 40) return null;
      JSON.parse(t); // 校验是不是合法 JSON
      return t;
    } catch (e) {
      if (i === tries - 1) { console.warn('  ! 失败', url, e.message); return null; }
      await new Promise((s) => setTimeout(s, 400 * (i + 1)));
    }
  }
}

async function pool(items, worker, conc = CONC) {
  let i = 0, done = 0;
  await Promise.all(Array.from({ length: conc }, async () => {
    while (i < items.length) {
      const item = items[i++];
      try { await worker(item); } catch (e) { console.warn('  !', item && item.adcode, e.message); }
      if (++done % 40 === 0) console.log('  进度 ' + done + '/' + items.length);
    }
  }));
}

const sizeOf = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
const mb = (b) => (b / 1048576).toFixed(1) + 'MB';

console.log('[1/3] 下载省级边界 ...');
ensure(OUT);
ensure(path.join(OUT, 'prov'));
ensure(path.join(OUT, 'city'));

const chinaTxt = await get(BASE + '/100000_full.json');
if (!chinaTxt) throw new Error('省级数据下载失败，请检查网络');
fs.writeFileSync(path.join(OUT, 'china.json'), chinaTxt);
const china = JSON.parse(chinaTxt);

const provs = china.features
  .map((f) => ({ adcode: String(f.properties.adcode), name: f.properties.name }))
  .filter((p) => p.adcode && p.adcode !== '100000');
console.log('  省级 ' + provs.length + ' 个，' + mb(sizeOf(path.join(OUT, 'china.json'))));

console.log('[2/3] 下载市级边界 ...');
const cities = [];
await pool(provs, async (p) => {
  const txt = await get(BASE + '/' + p.adcode + '_full.json');
  if (!txt) return;
  fs.writeFileSync(path.join(OUT, 'prov', p.adcode + '.json'), txt);
  const j = JSON.parse(txt);
  for (const f of j.features) {
    const ad = String(f.properties.adcode);
    if (ad && ad !== p.adcode) cities.push({ adcode: ad, name: f.properties.name, parent: p.adcode });
  }
});
console.log('  市级 ' + cities.length + ' 个');

console.log('[3/3] 下载区县级边界 ...');
await pool(cities, async (c) => {
  const dest = path.join(OUT, 'city', c.adcode + '.json');
  if (fs.existsSync(dest) && sizeOf(dest) > 40) return;
  const txt = await get(BASE + '/' + c.adcode + '_full.json');
  if (!txt) return;
  fs.writeFileSync(dest, txt);
});

const dirSize = (d) => fs.readdirSync(d).reduce((s, f) => s + sizeOf(path.join(d, f)), 0);
console.log('全部完成：');
console.log('  china.json  ' + mb(sizeOf(path.join(OUT, 'china.json'))));
console.log('  prov/       ' + fs.readdirSync(path.join(OUT, 'prov')).length + ' 个文件  ' + mb(dirSize(path.join(OUT, 'prov'))));
console.log('  city/       ' + fs.readdirSync(path.join(OUT, 'city')).length + ' 个文件  ' + mb(dirSize(path.join(OUT, 'city'))));
