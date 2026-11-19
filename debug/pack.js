/**
 * debug/pack.js —— 把成品目录打成安装包（本地发布与 CI 共用这一份实现）
 *
 * @file      debug/pack.js
 * @license   MIT
 * @usage     require('./pack').buildZip(ver, distDir, outFile)
 *
 * 为什么要单独一个文件：安装包现在有两个地方会打——本机的 `发布脚本`
 * （推分发源）和 GitHub Actions（挂到 Release 附件）。两边各写一份，
 * 出来的字节必然不同，于是清单里的 sha256 和附件里的包对不上，
 * 而"同一个版本号对应同一个包"这件事就没人能核了。
 *
 * 所以打包容器的三件事一起钉死：
 *   ① 条目名统一 `/`、带 UTF-8 标志（见 debug/zip.js）；
 *   ② **时间戳固定**（MTIME），不取文件 mtime、不取当前时间；
 *   ③ 包内 `安装说明.txt` **不写构建日期**——写了的话，隔天重打同一个版本
 *      就会得到不同的字节，等于同一个版本号有两个包。
 * 于是同样的文件内容，在任何机器、任何时区、任何一天，都得到同一串字节。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { zipDir } = require('./zip');

/**
 * 包内所有条目的时间戳。取 DOS 时间的纪元（1980-01-01 UTC）。
 * 它不是"文件的修改时间"，只是为了可复现；真实构建时间在 version.json 的 `build`。
 */
const MTIME = new Date(Date.UTC(1980, 0, 1, 0, 0, 0));

/**
 * 包根上的「安装说明.txt」。
 *
 * 为什么必须有：「加载已解压的扩展程序」只吃文件夹——把 zip 直接选给它，报的是
 * `Could not unzip extension for install`，看着像包坏了。以前包里只有
 * `文稿助手/` 一个目录，解压完没有一句话，第一次装的人必然踩这一脚。
 *
 * 所以说明放在 **zip 根**、和 `FARS-Assistant/` 并排（不是塞进去），
 * 解压后第一眼就能看到。三条要点缺一不可：
 *   ① 解压到固定目录，别放「下载」（清下载目录会把扩展删掉）；
 *   ② 路径不许改（扩展 ID 由绝对路径决定，换路径 = 换扩展，配置不跟）
 *   ③ 升级是覆盖原目录，不是新建 `FARS-Assistant-<版本>`
 *
 * 不含日期、不含时间：见文件头 ③。换行用 CRLF、开头带 BOM，记事本打开不乱码。
 */
function readmeText(ver) {
  const nl = '\r\n';
  const L = [
    'FARS-Assistant ' + ver,
    '',
    '这是一个 Chrome / Edge 扩展，浏览器扩展列表里显示的名字是「简报助手」。',
    '压缩包里的「FARS-Assistant」文件夹就是扩展本体，Chrome 不能直接安装 zip——必须先解压。',
    '',
    '【第一次装】',
    '1. 把里面的「FARS-Assistant」文件夹解压到一个固定位置，例如 C:\\FARS-Assistant',
    '   不要放在「下载」文件夹：清一次下载目录，扩展文件就没了。',
    '   路径以后不要改——扩展 ID 由绝对路径决定，换个路径等于换了一个扩展，',
    '   原来的配置和档案不会跟过来（看起来像"配置丢了"）。',
    '2. 打开 chrome://extensions（Edge 是 edge://extensions），右上角打开「开发者模式」。',
    '3. 点「加载已解压的扩展程序」，选中刚解压出来的「FARS-Assistant」文件夹。',
    '   注意是选**文件夹**，而且要选到含 manifest.json 的那一层。',
    '4. 如果直接把 zip、或里面的某个文件选给 Chrome，会报',
    '   "Could not unzip extension for install"——那是它不接受压缩包，不是包坏了。',
    '',
    '【已经装过，只是升级】',
    '1. 把「FARS-Assistant」文件夹里的内容**覆盖**到原来那个扩展目录（同名文件全部替换）。',
    '   目录名照原样保留即可：扩展 ID 跟的是"加载时选的那个路径"，不是文件夹叫什么。',
    '2. 回 chrome://extensions 点该扩展的「重新加载」。',
    '3. 不要新建「FARS-Assistant-' + ver + '」这种目录，原因同上：路径变了就是另一个扩展。',
    '   面板里「设置 → 版本 → 重新加载」也能完成第 2 步。',
    '',
    '【本机已经装过的情况】',
    '多数人不需要这个包：直接点面板里的「重新加载扩展」，或到 chrome://extensions 点刷新，',
    '文件已经在磁盘上换好了（构建脚本会同步到安装目录）。这个包只在换电脑、重装时用。',
    ''
  ];
  return '\uFEFF' + L.join(nl);   // BOM：记事本打开中文不乱码
}

/** 递归数文件：只数 `FARS-Assistant/` 那一层里的，不含根上的说明 */
function countFiles(dir) {
  let n = 0;
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (e.isFile()) n++;
    }
  })(dir);
  return n;
}

const sha256 = file =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/**
 * 打一个安装包。
 *
 * @param {string} ver      版本号（写进包内说明）
 * @param {string} distDir  成品目录（`FARS-Assistant/` 那一层来自它）
 * @param {string} outFile  输出 zip 路径
 * @returns {{file:string, bytes:number, sha256:string, shaShort:string, files:number}}
 */
function buildZip(ver, distDir, outFile) {
  if (!fs.existsSync(path.join(distDir, 'manifest.json'))) {
    throw new Error(`成品目录里没有 manifest.json：${distDir}\n先跑 node debug/dist.js`);
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  if (fs.existsSync(outFile)) fs.unlinkSync(outFile);

  /* root 给包加一层 `FARS-Assistant/`：资源管理器「全部解压缩」默认按 **zip 文件名**
     建目录，包里不带固定目录名的话，解压目标会随包名变——与上一版目录不同名，
     Chrome 就当成另一个扩展，两个版本并存；而 chrome.storage 按扩展 ID 存，
     ID 又由目录路径决定，于是配置一起丢。带了固定目录名之后，解压目标永远是
     `文稿助手`，同名目录会被问"是否替换"，这才是用户以为的"覆盖安装"。 */
  zipDir(distDir, outFile, {
    root: 'FARS-Assistant',
    mtime: MTIME,
    extra: [{ name: '安装说明.txt', data: readmeText(ver) }]
  });

  const b = fs.readFileSync(outFile);
  const full = sha256(outFile);
  return {
    file: outFile,
    bytes: b.length,
    sha256: full,
    shaShort: full.slice(0, 16),
    files: countFiles(distDir)
  };
}

module.exports = { readmeText, buildZip, countFiles, sha256, MTIME };

/* ── 命令行入口：node debug/pack.js ──────────────────────────────
   本机发布走 发布脚本（它连打包带推送）；这个入口是给 CI 用的——
   GitHub Actions 只需要"按当前 manifest 版本打一个包"，
   不该为了打一个包把 ssh/scp 那半条链路也拖进去。 */
if (require.main === module) {
  const ROOT = path.resolve(__dirname, '..');
  const ver = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).version;
  /* 成品路径只有一个来源：dist.js 说在哪就在哪。写死第二份的下场是搬一次家要改
     三个文件，漏一个就静默打出空包——CI 上尤其看不出来。 */
  const dist = process.env.HT_DIST || require('./dist').DEST;
  const outDir = process.env.HT_OUT || path.join(ROOT, 'release');
  const r = buildZip(ver, dist, path.join(outDir, `FARS-Assistant-${ver}.zip`));
  console.log(`${path.relative(ROOT, r.file)}｜${r.files} 个条目｜${(r.bytes / 1024).toFixed(0)} KB｜sha256 ${r.shaShort}`);
}

