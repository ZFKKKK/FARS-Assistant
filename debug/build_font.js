/**
 * debug/build_font.js —— 从系统字体裁出「界面用字」子集（一次性构建）
 *
 * @file      debug/build_font.js
 * @version   1.0.0
 * @build     2026-11-18
 * @license   MIT
 * @usage     node debug/build_font.js [--dry] [--src <字体路径>]
 *
 * 为什么要有这一步
 * ---------------
 * 界面要的是 Noto Sans SC 那种可变字重（550 / 650 才真能画出来），但这套字体
 * 装了 17.7MB。整包塞进扩展，安装体积从 370KB 变成 18MB——为一个界面字体不值。
 * 界面里出现的汉字是**有限集合**（标签、提示、状态、模板里的固定措辞），
 * 按这个集合裁一遍，通常只剩一两百 KB。
 *
 * 只裁界面，不裁内容：使用者手打的字、站点返回的站名不在集合里，渲染时逐字
 * 回退到系统字体（`--ht-font` 后面那一串）。回退是浏览器行为，不是缺字方块。
 *
 * 什么时候要重跑
 * -------------
 * 往界面文案里加了新字之后。不重跑也不会坏——新字回退到系统字体而已，
 * 只是那一两处观感不齐。`--dry` 能看出当前集合有多少字。
 *
 * 依赖（仓库里不带 node_modules，只有构建这个字体时才需要）
 * ---------------------------------------------------------
 *   npm i subset-font@2.9.0
 * 脚本按 require 解析找它：先找仓库内 node_modules，再找 $SUBSET_FONT_PATH
 * 指向的目录（例如临时目录里装的那一份）。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'fonts', 'ht-sans.woff2');
const DEFAULT_SRC = 'C:/Windows/Fonts/NotoSansSC-VF.ttf';

/* ── 收字 ─────────────────────────────────────────────────────────── */

/** 只取字符串字面量里的字：注释里的中文是最多的，跟着算进去白白撑大子集 */
function harvestJs(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
    if (c === '/' && d === '/') { const e = src.indexOf('\n', i); i = e < 0 ? src.length : e; continue; }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c) break;
        j++;
      }
      out += src.slice(i + 1, j);
      i = j + 1;
      continue;
    }
    i++;
  }
  return out;
}

/** CSS 只有 content:"…" 里会有中文，注释之外全收即可 */
const harvestCss = src => src.replace(/\/\*[\s\S]*?\*\//g, '');

/** HTML 只去注释：标签骨架是 ASCII，留着也只是重复字符，不影响体积 */
const harvestHtml = src => src.replace(/<!--[\s\S]*?-->/g, '');

const RANGES = [
  [0x0020, 0x007e], // ASCII 可打印
  [0x00b0, 0x00b7], // ° ± ² ³
  [0x2000, 0x206f], // 破折号、引号、省略号、间隔号
  [0x20a0, 0x20bf], // 货币
  [0x2100, 0x214f], // ℃ №
  [0x2190, 0x21ff], // 箭头
  [0x2460, 0x24ff], // 带圈数字
  [0x25a0, 0x27bf], // 几何图形、对勾、叉、星
  [0x3000, 0x303f], // 中文标点
  [0x4e00, 0x9fff], // 汉字
  [0xf900, 0xfaff], // 兼容汉字
  [0xff00, 0xff65], // 全角
];

const inRange = cp => RANGES.some(([a, b]) => cp >= a && cp <= b);

function harvest() {
  const mf = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const files = new Set(['panel.css', 'options.css', 'options.html', mf.background.service_worker]);
  if (mf.options_ui) files.add(mf.options_ui.page);
  (mf.content_scripts || []).forEach(cs => (cs.js || []).forEach(f => files.add(f)));

  /* src/ 全收一遍：清单里漏列的文件也不至于把字漏掉 */
  const walk = dir => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).forEach(d => {
    const rel = dir + '/' + d.name;
    if (d.isDirectory()) return walk(rel);
    if (/\.(js|css|html)$/.test(d.name)) files.add(rel);
  });
  walk('src');

  let text = '';
  [...files].sort().forEach(f => {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) return;
    const src = fs.readFileSync(p, 'utf8');
    if (/\.js$/.test(f)) text += harvestJs(src);
    else if (/\.css$/.test(f)) text += harvestCss(src);
    else text += harvestHtml(src);
  });

  const set = new Set();
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (inRange(cp)) set.add(ch);
  }
  /* 界面上一定会出现、但代码里可能只以变量拼出来的几个 */
  '0123456789:：·、，。；！？（）【】—…%/％+-×÷≤≥→←↑↓✓✕✔✗●○◆◇■□▲△'.split('').forEach(c => set.add(c));

  return { chars: [...set].sort(), files: [...files].length };
}

/* ── 裁剪 ─────────────────────────────────────────────────────────── */

function loadSubsetFont() {
  const tries = [
    () => require('subset-font'),
    () => require(path.join(process.env.SUBSET_FONT_PATH || '', 'node_modules', 'subset-font')),
  ];
  for (const t of tries) {
    try { return t(); } catch (e) { /* 下一个 */ }
  }
  throw new Error('找不到 subset-font。先 `npm i subset-font@2.9.0`，'
    + '或把它装在临时目录并设 $env:SUBSET_FONT_PATH 指过去。');
}

async function main() {
  const argv = process.argv.slice(2);
  const dry = argv.includes('--dry');
  const si = argv.indexOf('--src');
  const srcPath = si > -1 ? argv[si + 1] : DEFAULT_SRC;
  /* 界面上只用 400 / 550 / 650 三档（--ht-w-reg / med / bold）与一两个 bolder。
     把轴夹到 320–720：三个字重都落在里面，gvar 里超出这段的增量数据就不用带了。 */
  const ai = argv.indexOf('--axes');
  const axes = ai > -1 ? argv[ai + 1] : '320-720';
  const noHint = argv.includes('--nohint');

  const { chars, files } = harvest();
  const text = chars.join('');
  console.log(`扫描 ${files} 个文件，界面用字 ${chars.length} 个（去重）`);
  console.log(`来源字体：${srcPath}`);

  if (dry) return;

  const font = fs.readFileSync(srcPath);
  const subsetFont = loadSubsetFont();
  const opts = { targetFormat: 'woff2' };
  if (axes && axes !== 'full') {
    const [min, max] = axes.split('-').map(Number);
    opts.variationAxes = { wght: { min, max } };
  }
  if (noHint) opts.noHinting = true;

  const buf = await subsetFont(font, text, opts);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, buf);

  const kb = n => (n / 1024).toFixed(1) + ' KB';
  console.log(`原字体 ${kb(font.length)} → 子集 ${kb(buf.length)}（wght ${axes}${noHint ? '，去 hinting' : ''}）`);
  console.log(`已写入 ${path.relative(ROOT, OUT).replace(/\\/g, '/')}`);
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
