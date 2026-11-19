/**
 * debug/dist.js —— 生成「成品」目录（Chrome / Edge 实际加载的那份）
 *
 * @file      debug/dist.js
 * @version   1.4.1
 * @build     2026-11-15
 * @license   MIT
 * @usage     node debug/dist.js
 *
 * 成品放在项目内的 `dist/`，不再放桌面。两个原因：
 *
 *   1. **扩展目录里有硬性禁忌**：Chrome / Edge 拒绝加载任何含 `_` 开头文件的目录
 *      （`_locales` / `_metadata` 除外），报 "Filenames starting with _ are reserved"。
 *      仓库里有 `报文目录`（真实报文）、`量版页`（量版页），直接加载根目录
 *      一定失败。与其把这类临时文件的名字一次次改成不带下划线，不如让浏览器只看
 *      一个干净的副本。
 *   2. 桌面是个人文件区，构建产物躺在那里既碍眼，又容易和别的东西混。
 *
 * 所以成品目录的定位没变——**不是"项目的一份拷贝"，是"能装进浏览器的那一份"**：
 *   1. manifest.json 里点名的（background / options 页 / 图标 / content_scripts /
 *      web_accessible_resources）
 *   2. options.html 里本地引用到的 css / js（清单不管这些，容易漏）
 *   3. LICENSE（MIT 要求随分发走）
 * 多拷一个文件不算错，少拷一个就是白屏——所以 自检脚本 会双向核对
 * 「该有的都在」与「多出来的都没有」。
 *
 * `dist/` 被 .gitignore 排除：它是生成物，删了随时重建。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEST = path.join(ROOT, 'dist');

const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const LOCAL_REF = [/<script[^>]+src="([^"]+)"/g, /<link[^>]+href="([^"]+)"/g];

/** 成品该有哪些文件：全部从清单与 options.html 推导，不另存一份名单 */
function runtimeFiles() {
  const mf = JSON.parse(read('manifest.json'));
  /* 清单自己当然要在里面——它不是"被清单点名的文件"，所以单列 */
  const set = new Set(['LICENSE', 'manifest.json']);
  const add = f => { if (f && typeof f === 'string') set.add(f.replace(/^\.\//, '')); };

  if (mf.background) add(mf.background.service_worker);
  if (mf.options_ui) add(mf.options_ui.page);
  if (mf.action && mf.action.default_icon) Object.values(mf.action.default_icon).forEach(add);
  Object.values(mf.icons || {}).forEach(add);
  (mf.content_scripts || []).forEach(cs => (cs.js || []).forEach(add));
  (mf.web_accessible_resources || []).forEach(w => (w.resources || []).forEach(add));

  const html = mf.options_ui ? read(mf.options_ui.page) : '';
  LOCAL_REF.forEach(re => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(html))) if (!/^(https?:|\/\/)/i.test(m[1])) add(m[1]);
  });

  return [...set].filter(f => fs.existsSync(path.join(ROOT, f))).sort();
}

/** 目录下所有文件（相对路径，正斜杠） */
function walk(dir, base) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  fs.readdirSync(dir, { withFileTypes: true }).forEach(d => {
    const rel = base ? base + '/' + d.name : d.name;
    const abs = path.join(dir, d.name);
    if (d.isDirectory()) out.push(...walk(abs, rel));
    else out.push(rel);
  });
  return out;
}

/** 删空目录（自下而上），成品目录本身不删 */
function pruneEmpty(dir) {
  if (!fs.existsSync(dir)) return;
  fs.readdirSync(dir, { withFileTypes: true }).forEach(d => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) {
      pruneEmpty(p);
      if (!fs.readdirSync(p).length) fs.rmdirSync(p);
    }
  });
}

/** 分发源地址：环境变量优先（CI），其次本机 ops/host.json，都没有返回空串 */
function resolveOrigin() {
  const norm = v => String(v || '').trim().replace(/\/+$/, '');
  if (process.env.HT_ORIGIN) return norm(process.env.HT_ORIGIN);
  try {
    const h = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops', 'host.json'), 'utf8'));
    return norm(h && h.origin);
  } catch (e) { return ''; }
}

/** 目标站点根地址：同一套机制，键是 `site` / 环境变量 `SITE_ORIGIN` */
function resolveSite() {
  const norm = v => String(v || '').trim().replace(/\/+$/, '');
  if (process.env.SITE_ORIGIN) return norm(process.env.SITE_ORIGIN);
  try {
    const h = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops', 'host.json'), 'utf8'));
    return norm(h && h.site);
  } catch (e) { return ''; }
}

function build() {
  const want = runtimeFiles();
  fs.mkdirSync(DEST, { recursive: true });

  want.forEach(f => {
    const to = path.join(DEST, f);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f), to);
  });

  /* ── 注入两个构建期地址 ────────────────────────────────────────
     源码里写的是占位符，不是真地址：仓库要公开，不该把具体站点与分发服务器
     一起交出去。真值只在本机 `ops/host.json`（已 gitignore）或环境变量。

       __SITE_ORIGIN__  目标站点根地址：manifest 的 matches / host_permissions、
                        contract 的接口根、background 判断"站点标签页是否开着"
       __HT_ORIGIN__    分发源地址：版本清单、诊断上报、云端配置同步

     **成品必须是完整 URL**——`host_permissions` 里留占位符是非法的，
     Chrome 会直接拒绝加载，表现是"装不上"，不是"某个功能连不上"。 */
  const inject = (ph, val, files) => {
    files.forEach(f => {
      const p = path.join(DEST, f);
      if (!fs.existsSync(p)) return;
      const s = fs.readFileSync(p, 'utf8');
      if (s.indexOf(ph) < 0) return;
      fs.writeFileSync(p, s.split(ph).join(val || ph), 'utf8');
    });
  };

  const site = resolveSite();
  const origin = resolveOrigin();
  inject('__SITE_ORIGIN__', site, ['manifest.json', 'src/data/contract.js', 'background.js']);
  inject('__HT_ORIGIN__', origin, ['manifest.json', 'src/data/release.js']);

  if (!site) {
    console.warn('  ! 未配置目标站点地址：成品里仍是 __SITE_ORIGIN__，装上会失败');
    console.warn('    本机 → ops/host.json 写 {"site":"https://<目标站点>"}');
    console.warn('    CI   → 配仓库 Secret SITE_ORIGIN');
  }
  if (!origin) {
    console.warn('  ! 未配置分发源地址：成品里仍是 __HT_ORIGIN__，装上会失败');
    console.warn('    本机 → ops/host.json 写 {"origin":"http://<host>:<port>"}');
    console.warn('    CI   → 配仓库 Secret HT_ORIGIN');
  }

  /* 反向：成品目录里多出来的东西一律删掉。这是它作为「成品」的定义——
     不是"项目的一份拷贝"，是"能装进 Chrome 的那一份"。
     只动 DEST 内部，且逐条打印，删了什么看得见。 */
  const killed = walk(DEST, '').filter(f => !want.includes(f));
  killed.forEach(f => fs.unlinkSync(path.join(DEST, f)));
  pruneEmpty(DEST);

  return { want, killed };
}

module.exports = { runtimeFiles, walk, DEST, ROOT };

if (require.main === module) {
  const { want, killed } = build();
  console.log(`成品目录：${DEST}`);
  console.log(`运行文件 ${want.length} 个：${want.join('、')}`);
  console.log(killed.length
    ? `删除开发文件 ${killed.length} 个：\n  ${killed.join('\n  ')}`
    : '没有多余文件需要删');
  console.log('\n到 chrome://extensions 点该扩展的刷新按钮，浏览器里才是这一版。');
}
