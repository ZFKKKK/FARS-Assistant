/**
 * debug/zip.js —— 把一个目录打成 zip（零依赖，只用 Node 内置 zlib）
 *
 * @file      debug/zip.js
 * @license   MIT
 *
 * 为什么不调 PowerShell 的 Compress-Archive，也不用 .NET 的 ZipFile：
 *   两者在 Windows PowerShell 5.1（.NET Framework）上都会把条目名写成
 *   `src\data\config.js`。这不符合 zip 规范（规范要求 `/`），
 *   Windows 资源管理器解压看着没事，Linux/macOS 解出来是一个名叫
 *   `src\data\config.js` 的**单个文件**，目录结构全丢。
 *   发布包给别人的东西，不能只在一台 Windows 上"看着没问题"。
 *
 * 所以这里手写最小的 zip 写入器：store / deflate 两种都支持，
 * 条目名统一用 `/`，设 UTF-8 标志位（bit 11），中文文件名不会乱码。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* CRC32 查表：zip 每个条目都要一个，Node 没有内置实现 */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * DOS 时间：秒只存偶数位，精度 2 秒。
 *
 * **一律按 UTC 取**，不用本地时区。打包这一环要的是「同一份文件内容 →
 * 同一串字节」：用本地时间的话，同一台机器改一下时区、或者换到 CI（UTC）上打，
 * 同一个版本就会得到两个不同的 sha256，而清单里只写了一个。
 * 传进来的 mtime 由调用方决定（见 debug/pack.js 的 MTIME）。
 */
function dosTime(d) {
  const time = ((d.getUTCHours() & 31) << 11) | ((d.getUTCMinutes() & 63) << 5) | ((d.getUTCSeconds() / 2) & 31);
  const date = (((d.getUTCFullYear() - 1980) & 127) << 9) | (((d.getUTCMonth() + 1) & 15) << 5) | (d.getUTCDate() & 31);
  return { time, date };
}

/** 递归收集文件，返回相对路径（用 / 分隔） */
function walk(root, dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    const rel = dir === root ? e.name : path.relative(root, abs);
    if (e.isDirectory()) walk(root, abs, out);
    else if (e.isFile()) out.push({ abs, name: rel.split(path.sep).join('/') });
  }
  return out;
}

/**
 * @param {string} src   源目录（其**内容**成为 zip 根，不含这一层目录名）
 * @param {string} dest  输出 zip 路径
 * @param {{level?:number, mtime?:Date}} [opt]
 * @returns {{count:number, raw:number, packed:number}}
 */
/**
 * @param {string} src   要打包的目录
 * @param {string} dest  输出 zip 路径
 * @param {{level?:number, mtime?:Date, root?:string}} [opt]
 *   root 给条目加一层固定目录名（如 `文稿助手`）。**安装包必须给**：
 *   Windows 资源管理器「全部解压缩」默认按 zip 文件名建文件夹，
 *   于是 ht-0.24.0.zip 解出来是 ht-0.24.0\，与上一版的目录不同名 →
 *   Chrome 认为是一个新扩展 → 两个版本并存，而配置是按扩展 ID 存的，跟着丢。
 *   带一层固定目录名之后，解压目标永远是"文稿助手"，同名会被问要不要替换，
 *   这才是用户以为的"覆盖安装"。
 */
function zipDir(src, dest, opt) {
  const o = opt || {};
  const level = o.level === undefined ? 9 : o.level;
  const mtime = o.mtime || new Date();
  const root = o.root ? String(o.root).replace(/[\/]+$/, '') + '/' : '';
  const { time, date } = dosTime(mtime);

  const list = walk(src, src, []).sort((a, b) => (a.name < b.name ? -1 : 1));

  /* 条目 = 目录里的文件（带 root 前缀）+ 额外塞进去的几份文本（**不带**前缀）。
     后者是给人解压第一眼看到的东西，比如「安装说明.txt」：它必须落在 zip 根上，
     和 `文稿助手/` 并排；塞进 `文稿助手/` 里等于藏起来了——
     而 Chrome 恰恰不许把 zip 或压缩包里的文件直接"安装"，说明必须放在外面。 */
  const extras = Array.isArray(o.extra) ? o.extra : [];
  const entries = list.map(f => ({
    name: root + f.name,
    data: fs.readFileSync(f.abs)
  })).concat(extras.map(e => ({
    name: String(e.name || '').replace(/^[\/]+/, ''),
    data: Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data || ''), 'utf8')
  })).filter(e => e.name));

  const locals = [];
  const centrals = [];
  let offset = 0;
  let raw = 0;
  let packed = 0;

  for (const en of entries) {
    const data = en.data;
    const deflated = zlib.deflateRawSync(data, { level });
    /* 压不小就用 store：小文件压完反而更大是常事 */
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const nameBuf = Buffer.from(en.name, 'utf8');
    const crc = crc32(data);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);          // version needed
    lh.writeUInt16LE(0x0800, 6);      // bit 11 = 文件名是 UTF-8
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);

    locals.push(lh, nameBuf, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);          // version made by
    ch.writeUInt16LE(20, 6);          // version needed
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);          // extra
    ch.writeUInt16LE(0, 32);          // comment
    ch.writeUInt16LE(0, 34);          // disk
    ch.writeUInt16LE(0, 36);          // internal attr
    ch.writeUInt32LE(0, 38);          // external attr（普通文件）
    ch.writeUInt32LE(offset, 42);     // 本地头偏移

    centrals.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + body.length;
    raw += data.length;
    packed += body.length;
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  fs.writeFileSync(dest, Buffer.concat([Buffer.concat(locals), cd, eocd]));
  return { count: entries.length, raw, packed };
}

module.exports = { zipDir, crc32 };
