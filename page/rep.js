/**
 * page/rep.js —— 在**页面上下文**里跑的一小段（MAIN world）
 *
 * @file        page/rep.js
 * @version     （见 manifest.json 与 src/data/release.js）
 * @build       （同上）
 * @license     MIT
 * @description 统计报表那张 xlsx，交给页面自己的导出模块生成
 *
 * 为什么有这么一个文件：
 *   统计报表（分原因分等级表）的 xlsx 是**网页前端**拼的——服务端只回单元格、
 *   合并区与左对齐列，文件由站点那个 `export-2-excel` 模块写成。扩展要做的是
 *   「用原版能力」，所以不复制那份逻辑、不自己拼表，只把模块 import 进来，
 *   把接口回来的表格结构原样喂给它。
 *
 * 为什么必须放在页面里跑：
 *   内容脚本属于扩展上下文，MV3 不允许它动态 import 站点资源；页面上下文可以
 *   （同源，受站点 CSP 的 'self' 覆盖）。所以由后台用 scripting 注入到 MAIN world。
 *
 * 通信（两个 world 之间只有字符串能安全穿过）：
 *   内容脚本 → 本文件：window.dispatchEvent(new CustomEvent('ht-rep-req', {detail: JSON}))
 *   本文件 → 内容脚本：window.dispatchEvent(new CustomEvent('ht-rep-res', {detail: JSON}))
 */
(function () {
  'use strict';
  if (window.__htRep) return;
  window.__htRep = 1;

  var REQ = 'ht-rep-req';
  var RES = 'ht-rep-res';
  var CHUNK = /export-2-excel-[A-Za-z0-9_-]+\.js/;
  /* 缓存的是**拼表模块自己的地址**，不是"哪个入口引用过它"。
     1.12.8 之前存的是入口：站点一改打包分层（入口 → _report-generate → 模块），
     旧缓存里的入口还在、却再也解析不出模块名，缓存反而拖慢失败。 */
  var CACHE_KEY = 'ht-rep-chunk';
  /* 翻页面文本的上限，分两档用：
       SCAN_SMALL —— 页面自己的 chunk（几十 KB）。报表页一进来这些就在，
                     命中就在这一轮，正常 1 秒内出结果；
       SCAN_MAX   —— 主包。**懒加载表写在主包里**（2026-11-24 实测：1.7 MB 的
                     @castle 里写着 _report-generate-<hash>.js），只翻小文件永远
                     找不到它，所以第一轮不中还要再翻一遍大的。
                     3 MB 足够盖住主包；再大的（echarts/antd）读了也没用。 */
  var SCAN_SMALL = 250 * 1024;
  var SCAN_MAX = 3 * 1024 * 1024;
  var SCAN_LIMIT = 80;
  var SCAN_WORKERS = 6;
  /* 站点 2026-11-24 起多出来的中间层：入口 → _report-generate → export-2-excel。
     它本身只导出报表页组件，拿不到拼表函数；但它的 import 里写着模块名。 */
  var MID = /_report-generate-[A-Za-z0-9_-]+\.js/;
  /* 入参是解构写法，压缩后属性名不变。缺一个就说明站点改了入参，
     宁可不出文件报错，也不要喂一份错位的参数让它悄悄出错表。 */
  var ARGS = ['filename', 'multiHeader', 'data', 'merges', 'leftNums',
    'rangeStartRow', 'rangeStartCol'];

  function back(obj) {
    try {
      window.dispatchEvent(new CustomEvent(RES, { detail: JSON.stringify(obj) }));
    } catch (e) { }
  }

  /** 页面已加载的脚本地址（导出过一次之后，模块本身也会在列 */
  function loaded() {
    var out = [];
    try {
      performance.getEntriesByType('resource').forEach(function (e) {
        var u = e.name || '';
        if (/\.js(\?|$)/i.test(u)) out.push(u);
      });
    } catch (e) { }
    return out;
  }

  /** 这段文本里引用的是哪个拼表模块；相对路径按引用者所在目录补成绝对地址 */
  function refIn(text, baseUrl) {
    var m = String(text || '').match(CHUNK);
    if (!m) return '';
    try { return new URL(m[0], baseUrl || location.href).href; } catch (e) { return ''; }
  }

  /** 这个地址现在还能不能取到（站点发版后旧 hash 会被删） */
  async function reachable(url) {
    try {
      var r = await fetch(url, { credentials: 'same-origin' });
      return !!r.ok;
    } catch (e) { return false; }
  }

  /** 读一个脚本的文本，超过本轮上限的直接跳过 */
  async function textOf(url, cap) {
    try {
      var r = await fetch(url, { credentials: 'same-origin' });
      if (!r.ok) return '';
      var t = await r.text();
      return t.length > (cap || SCAN_SMALL) ? '' : t;
    } catch (e) { return ''; }
  }

  /**
   * 翻已加载的页面 chunk，找谁 import 了拼表模块。
   *
   * 为什么要翻，而不是只翻入口：站点 2026-11-24 那次发版把报表页拆出了中间层
   *   `_report-generate-<hash>.js`，入口 index-*.js 里已经没有
   *   `export-2-excel-<hash>.js` 这行 import 了——引用关系变成
   *   入口 → 主包（懒加载表）→ _report-generate → export-2-excel
   * 只读入口等于永远读不到。而模块本身没删也没改名（实测 200、3,054 B、
   * 七个入参一字未变），所以缺的不是能力，是"上哪找"。
   *
   * 两档体积：先翻页面自己的 chunk（快），不中再翻主包（慢但只有一次）。
   * 命中直接返回；只翻到中间层就把它记下来，交给 findChunk 进去读一行。
   *
   * @returns {{hit:string, mid:string}} hit = 拼表模块地址，mid = 中间层地址
   */
  async function scanRefs() {
    var all = loaded().filter(function (u) { return /\/assets\//.test(u); }).slice(0, SCAN_LIMIT);
    if (!all.length) return { hit: '', mid: '' };

    async function pass(cap) {
      var next = 0, hit = '', mid = '';
      async function worker() {
        while (!hit && next < all.length) {
          var url = all[next++];
          var t = await textOf(url, cap);
          if (!t) continue;
          var found = refIn(t, url);
          if (found) { hit = found; return; }
          if (!mid) {
            var m = t.match(MID);
            if (m) { try { mid = new URL(m[0], url).href; } catch (e) { } }
          }
        }
      }
      var pool = [];
      for (var i = 0; i < SCAN_WORKERS; i++) pool.push(worker());
      await Promise.all(pool);
      return { hit: hit, mid: mid };
    }

    var small = await pass(SCAN_SMALL);
    if (small.hit) return small;
    var big = await pass(SCAN_MAX);
    return { hit: big.hit, mid: small.mid || big.mid };
  }

  /**
   * 找拼表模块的地址。按"代价从小到大"排：
   *   1. 页面已经加载了它 → 直接拿现成的
   *   2. 上次找到的地址还在（站点没发版）→ 用它，一次 HEAD 级请求就够
   *   3. 翻已加载页面 chunk 的 import（**1.12.8 起的主要路径**）
   *   4. 兜底：翻入口脚本（老站点的形态：入口直接 import 它）
   */
  async function findChunk() {
    var all = loaded();
    var i;
    for (i = 0; i < all.length; i++) if (CHUNK.test(all[i])) return all[i];

    var saved = '';
    try { saved = sessionStorage.getItem(CACHE_KEY) || ''; } catch (e) { }
    if (saved && CHUNK.test(saved) && await reachable(saved)) return saved;

    var scanned = await scanRefs();
    if (scanned.hit) {
      try { sessionStorage.setItem(CACHE_KEY, scanned.hit); } catch (e) { }
      return scanned.hit;
    }
    /* 二级跳：主包只告诉我们"报表页组件在哪"，没有再往下写模块名。
       进去读一行 import 就有了——它是 27 KB，读起来比再翻一遍主包便宜得多。 */
    if (scanned.mid) {
      var midText = await textOf(scanned.mid, SCAN_MAX);
      var inside = refIn(midText, scanned.mid);
      if (inside) {
        try { sessionStorage.setItem(CACHE_KEY, inside); } catch (e) { }
        return inside;
      }
    }

    var entries = all.filter(function (u) { return /\/assets\//.test(u); });
    for (i = 0; i < entries.length && i < 8; i++) {
      var t = await textOf(entries[i]);
      var alt = refIn(t, entries[i]);
      if (!alt) continue;
      try { sessionStorage.setItem(CACHE_KEY, alt); } catch (e) { }
      return alt;
    }
    return '';
  }

  /** 模块里那个导出函数：认「源码里出现 multiHeader」的那个，不认压缩后的符号名 */
  function pickFn(mod) {
    var keys = Object.keys(mod || {});
    for (var i = 0; i < keys.length; i++) {
      var v = mod[keys[i]];
      if (typeof v !== 'function') continue;
      if (String(v).indexOf('multiHeader') >= 0) return v;
    }
    return null;
  }

  async function run(p) {
    var url = await findChunk();
    if (!url) return back({ ok: false, msg: '没找到页面导出模块，请在站点任意页面重试一次' });

    var mod;
    try {
      mod = await import(url);
    } catch (e) {
      return back({ ok: false, msg: '页面导出模块加载失败：' + (e && e.message || e) });
    }
    var fn = pickFn(mod);
    if (!fn) return back({ ok: false, msg: '页面导出模块里没有导出函数' });

    var src = String(fn);
    var miss = ARGS.filter(function (a) { return src.indexOf(a) < 0; });
    if (miss.length) return back({ ok: false, msg: '站点导出模块入参已变更（缺 ' + miss.join('、') + '）' });

    try {
      await fn({
        filename: p.title,
        multiHeader: p.head,
        data: p.result,
        merges: p.merges,
        sheetName: '',
        autoWidth: true,
        bookType: 'xlsx',
        leftNums: p.leftLine,
        rangeStartRow: p.rangeStartRow,
        rangeStartCol: p.rangeStartCol
      });
    } catch (e) {
      return back({ ok: false, msg: '页面导出模块报错：' + (e && e.message || e) });
    }
    back({ ok: true, name: p.title });
  }

  var running = false;
  window.addEventListener(REQ, function (ev) {
    if (running) return back({ ok: false, msg: '上一次导出还没结束' });
    var p;
    try { p = JSON.parse(String(ev.detail || '')); } catch (e) { return back({ ok: false, msg: '参数不完整' }); }
    running = true;
    run(p).catch(function (e) {
      back({ ok: false, msg: String(e && e.message || e) });
    }).then(function () { running = false; });
  });
})();
