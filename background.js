/**
 * background.js —— 文稿助手 · Service Worker（扩展入口）
 *
 * @file        background.js
 * @version     （见 manifest.json 与 src/data/release.js，本文件不再写一份）
 * @build       （同上）
 * @license     MIT
 * @description 工具栏图标打开设置页；版本检查的唯一请求出口；下载安装包与重载扩展
 * @requires    Chrome 111+（MV3 service worker）
 *
 * 这一层只有三件事：
 *   1. 点工具栏图标 → 打开设置页（MV3 没有 default_popup 时必须自己接 onClicked）
 *   2. 版本检查的**唯一请求出口**（content script 的 fetch 走页面 origin，会被站点 CSP 拦掉）
 *   3. 替设置页做两件它做不了的事：下载安装包、重新加载扩展
 *
 * 不发系统通知（0.25.9 起）：上一版会定时轮询清单、有新版本就弹一条通知。删掉的理由
 * 不是"做不了"，是**不需要**——它替人决定什么时候被打断，而使用当天本来就在盯面板。
 * 版本号在设置页抬头随时看得见，「检查更新」也是手动点。
 * 于是 notifications 权限一并去掉；alarms 只留给「自动重载」当定时器（默认关）。
 *
 * 注意：MV3 的 service worker 随时会被回收，别用模块级变量保存跨事件的状态。
 */

/* 版本与更新策略只有一份，SW 也用它，不在宿主层再抄一遍。
   req.js 是它的依赖（版本检查用它发请求），必须一起进来。
   顶层 try：这一行要是崩了，连"点图标打开设置"都会失效——宁可少一个功能，
   不能整个扩展变砖。 */
try { importScripts('src/lib/req.js', 'src/data/release.js'); } catch (e) { }

const ALARM = 'ht-upd-check';

/* 这几个键不进 cfg：cfg 是按**用户档案**存的（每人一份模板），
   而"这台机器要不要自动重载"是整台机器的事，跟谁在用无关。 */
const K_LAST = 'updLast';         // 上一次检查的时间、结果与原因
const K_AUTO = 'updAutoReload';   // 文件已换掉时要不要自己重载；未设过 = 默认关
const K_TRIED = 'updTriedReload'; // 每个版本试过几次自动重载，防止每 6 小时白闪一次
/* 自动重载的检查周期。以前它是"通知轮询周期"，写在 release.js 里可调；
   通知删掉后只剩自动重载这一个用途，固定 6 小时就够，不再多一个设置项。 */
const AUTO_MIN = 360;

/**
 * 记一笔"上次检查"。
 *
 * 后台查失败是静默的（没网、服务器没开都不该弹框），但"静默"不等于"不可查"：
 * 设置页那一行「上次检查」读的就是这里。否则用户只会看到通知一直不来，
 * 却分不清是"没有新版本"还是"根本没连上"。
 */
function markTried(v) {
  return stSet(K_LAST, {
    at: Date.now(),
    ok: !!v && v.reason === '',
    /* local 必须一起记：设置页那一行要能分清"清单更新"和"清单比本机旧"。
       不记它，读回来的记录只有 latest，「上次检查」就永远退化成"已是最新"——
       和「本机」那一行正好互相打架。 */
    local: (v && v.local) || '',
    latest: (v && v.latest) || '',
    hasNew: !!(v && v.hasNew),
    /* ahead 也一起记：「设置页」读到的是这条记录，不是 checkUpdate 的返回值。
       只记 local 的话，旧记录回来还要现场算一遍，算不出来又退回"已是最新"。 */
    ahead: !!(v && v.ahead),
    /* reason 是短码（unreach / timeout / http / format …），detail 只留排障用。
       措辞在 errors.js 的 UPD 表里——这里一个字的提示都不写，否则同一件事
       又会有后台、面板、文档三个版本。旧版存的 why 已废，读的时候兼容一次。 */
    reason: (v && v.reason) || '',
    detail: (v && v.detail) || ''
  });
}

function UPD() {
  const HT = self.__HT || {};
  return (HT.RELEASE && HT.RELEASE.update) || null;
}

/* chrome.storage 的回调式包装：SW 里到处 await 容易忘 catch，
   Promise 化之后至少能用 try/catch 兜住"读不到"这一种失败。 */
function stGet(key) {
  return new Promise(res => {
    try {
      chrome.storage.local.get(key, o => res(o ? o[key] : undefined));
    } catch (e) { res(undefined); }
  });
}
function stSet(key, val) {
  return new Promise(res => {
    try { chrome.storage.local.set({ [key]: val }, () => res(true)); }
    catch (e) { res(false); }
  });
}

/* ── 自动重载（默认关）────────────────────────────────────────────
   它不下载任何东西，也不替换文件——扩展没有任意路径写文件的权限，
   "把包放到位"这一步永远得有人（或同步盘）做。这里只做最后一下：
   让 Chrome 重新从磁盘读一遍，等于替你点「重新加载扩展」。

   三条护栏，缺一条就会在人家写稿时把面板打断：
     1. 有 目标站点 的标签页开着 → 不动。面板就在那儿，
        重载会让它的 chrome.runtime 失效，正打的稿子跟着丢。
     2. 有扩展自己的页面开着（设置页）→ 不动。人正看着这一屏，
        这里本来就是手动点最合适的地方。
     3. 同一版本最多试 3 次、间隔 30 分钟 → 文件还没到位时，
        不至于每 6 小时白闪一次；三次都没变新，说明文件根本没换。 */

/** 默认关。 */
async function wantAuto() {
  const v = await stGet(K_AUTO);
  if (v === undefined) { const u = UPD(); return !!(u && u.autoReload); }
  return v === true;
}

/**
 * 统计页是否开着。
 * 不用 tabs 权限，靠 host_permissions 才读得到 url——所以"一个 url 都读不到"
 * 时按"有人在用"处理：分不清就别动，宁可这次不重载。
 */
function statTabsOpen() {
  return new Promise(res => {
    try {
      chrome.tabs.query({}, ts => {
        if (chrome.runtime.lastError || !ts) return res(true);
        if (!ts.length) return res(false);   // 一个标签页都没开：肯定没人在用
        const withUrl = ts.filter(t => t && t.url);
        if (!withUrl.length) return res(true);   // 有页面但读不到 url：分不清，别动
        res(withUrl.some(t => String(t.url).indexOf('__SITE_ORIGIN__') >= 0));
      });
    } catch (e) { res(true); }
  });
}

/** 扩展自己的页面（设置标签页、浮层宿主）。Chrome 116+ 才有 getContexts，没有就当作没有。 */
function extPageOpen() {
  const rt = chrome.runtime;
  if (!rt || typeof rt.getContexts !== 'function') return Promise.resolve(false);
  try {
    return rt.getContexts({ contextTypes: ['TAB', 'POPUP'] })
      .then(cs => !!(cs && cs.length), () => false);
  } catch (e) { return Promise.resolve(false); }
}

async function maybeAutoReload(v) {
  if (!(await wantAuto())) return;
  const t = (await stGet(K_TRIED)) || {};
  const same = t.ver === v.latest;
  const n = same ? (t.n || 0) : 0;
  if (same && (n >= 3 || Date.now() - (t.at || 0) < 30 * 60 * 1000)) return;
  if (await statTabsOpen()) return;
  if (await extPageOpen()) return;

  await stSet(K_TRIED, { ver: v.latest, at: Date.now(), n: n + 1 });
  /* 先把账记完再重载：reload 会把这个 SW 一起拆掉，晚一步写就写不进去了。 */
  setTimeout(() => { try { chrome.runtime.reload(); } catch (e) { } }, 800);
}

/**
 * 建闹钟：**无条件**，一天一次。
 *
 * 以前的写法是"不开自动重载就不建闹钟"，于是默认配置下后台从不查版本，
 * 唯一入口是打开设置页——而没人会天天打开设置页。证据就在诊断上报里：
 * 近两版发出去之后，现场机器仍停在更早的那一版。
 *
 * 现在"查"与"替人重载"分开：
 *   · 查：无条件，一天一次，结果写 updLast（设置页与入口的小红点都读它）；
 *   · 重载：仍要 wantAuto，且要过 maybeAutoReload 的三条护栏。
 * 关掉自动重载不应该连带关掉"知不知道有新版本"。
 */
async function syncAlarm() {
  const u = UPD();
  const every = AUTO_MIN;
  const want = !!(u && u.enabled && u.feedUrl && every);
  try {
    const cur = await new Promise(res => chrome.alarms.get(ALARM, a => res(a || null)));
    if (!want) { if (cur) chrome.alarms.clear(ALARM); return; }
    /* 已经有闹钟就不重建：重建会把下一次触发时间推后，
       结果是"每打开一次设置页，检查就被推迟一轮"，永远查不到。 */
    if (cur && cur.periodInMinutes === every) return;
    chrome.alarms.create(ALARM, { periodInMinutes: every, delayInMinutes: 5 });
  } catch (e) { /* 没有 alarms 权限时静默降级为"只能手动检查" */ }
}

/**
 * 后台查一次：结果为两件事服务——「自动重载」与「有没有新版本」这个事实本身。
 * 查不到一律静默：没网、服务器没开、JSON 写错都不是错误，不弹通知也不写界面。
 * 唯一的动作是 maybeAutoReload（且它自己会再判一次 wantAuto）。
 */
async function tick() {
  const HT = self.__HT || {};
  if (!HT.checkUpdate) return;
  let v;
  try { v = await HT.checkUpdate(true); } catch (e) { return; }
  await markTried(v);
  if (!v || !v.hasNew) return;
  await maybeAutoReload(v);
}

/* 首次安装 / 浏览器启动时对齐一次闹钟。
   两个事件都要接：onInstalled 只在装的那一次来，onStartup 每次开浏览器都来。 */
chrome.runtime.onInstalled.addListener(() => { syncAlarm(); syncBeat(); });
chrome.runtime.onStartup.addListener(() => { syncAlarm(); syncBeat(); });

chrome.alarms.onAlarm.addListener(a => {
  if (!a) return;
  if (a.name === ALARM) tick();
  /* 心跳：一天一次。只报"这台机器还活着、跑的是哪个版本"，
     不翻 obs、不发事件（事件由面板在产生的那一次顺手发走）。
     有了它才分得清"没人报错"和"没人用了"。 */
  if (a.name === TG_ALARM) tgFlush('beat');
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

/** 只允许下载与清单同源的地址：清单被人改过也不能让它变成"任意 URL 下载器"。 */
function sameOrigin(u, base) {
  try {
    const a = new URL(u), b = new URL(base);
    return /^https?:$/.test(a.protocol) && a.origin === b.origin;
  } catch (e) { return false; }
}

/**
 * 是否落在某个前缀路径之下。给配置同步的代理用：
 * 只比字符串前缀会被 `/../` 绕出去（`…/bg-9f3a/../admin` 仍然以根开头），
 * URL 解析会把 pathname 规范化，再比就没这个洞。
 */
function underRoot(u, root) {
  try {
    const a = new URL(u), b = new URL(root);
    if (!/^https?:$/.test(a.protocol) || a.origin !== b.origin) return false;
    const base = b.pathname.replace(/\/+$/, '');
    return a.pathname === base || a.pathname.indexOf(base + '/') === 0;
  } catch (e) { return false; }
}

/* ── 安装包的指纹核对 ───────────────────────────────────────────────
   这个包是**手工下载、手工解压覆盖**的：中间任何一跳被换掉（公共网络劫持、
   镜像站被改、网盘链接指到别的文件），装进浏览器的就是别人的代码。
   清单里发布脚本本来就写了 size 与 sha256，此前没人读——核对放在下载之前，
   不一致就不下，而不是先下完再指望人去看一眼大小。

   代价是多取一次包（这个包 300 KB 上下），换来"看到的版本号"和"拿到的字节"
   是同一件事。取值取不到、清单没写指纹，都放行并说明，不假装校验过。 */
async function pkgSha256(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(d)).map(x => x.toString(16).padStart(2, '0')).join('');
}

async function verifyPkg(url, size, sha) {
  const ac = new AbortController();
  const tm = setTimeout(() => ac.abort(), 30000);
  try {
    const r = await fetch(url, { cache: 'no-store', signal: ac.signal });
    if (!r.ok) return { ok: false, why: '取不到安装包，没法核对', detail: 'HTTP ' + r.status };
    const buf = await r.arrayBuffer();
    const got = await pkgSha256(buf);
    if (size && buf.byteLength !== size) {
      return {
        ok: false, why: '安装包大小与清单不符',
        detail: `清单 ${size} 字节，实得 ${buf.byteLength} 字节`
      };
    }
    /* 清单里的 sha256 现在是整串 64 位；更早的清单是 16 位前缀。
       两种都用 startsWith 比：整串时等价于全比，前缀时仍能挡住"文件被换掉"
       这一类最常见的失误，也不至于让老清单下不了包。 */
    if (!got.startsWith(sha)) {
      return {
        ok: false, why: '安装包内容与清单不一致',
        detail: `清单 ${sha}，实得 ${got.slice(0, sha.length)}`
      };
    }
    return { ok: true, bytes: buf.byteLength };
  } catch (e) {
    const m = String((e && e.message) || e);
    if (/abort/i.test(m) || (e && e.name === 'AbortError')) {
      return { ok: false, why: '核对时取包超时', detail: '30 秒没有取完' };
    }
    return { ok: false, why: '取不到安装包，没法核对', detail: m };
  } finally { clearTimeout(tm); }
}

/* ── 诊断上报 ─────────────────────────────────────────────────────
   为什么从 SW 发而不是从 content script 发：content script 的 fetch 走页面
   origin，会被 目标站点 的 connect-src CSP 拦掉，失败信息只有一句
   `TypeError: Failed to fetch`——和"服务器没开"长得一模一样。SW 不受页面
   CSP 约束，只受 host_permissions 约束。

   发什么：版本号、环境、本机自检记录（短码 / 模块名 / 校验项名）。
   **没有任何记录数字**——这条边界由 obs.js 的 note() 守着，这里只负责传。
   obs 的调用点也从不往里写起数与区域名。

   为什么要日上限：如果某个错误在每次渲染时都触发，一天能发上千份，
   把自己那台小服务器刷满、把有用的记录挤掉。maxPerDay 见 release.js。 */
const K_DIAG = 'diagLast';        // 上一次上报的时间与结果，设置页只读这一条
const K_DIAGN = 'diagSent';       // { day:'2026-11-13', n:3 } 当天已发几份

function REPORT() {
  const HT = self.__HT || {};
  return (HT.RELEASE && HT.RELEASE.report) || null;
}

/** 文本压成一串：服务器按行存，换行会把一条拆成好几行 */
function diagClip(s) {
  return String(s == null ? '' : s).slice(0, 6000);
}

/**
 * 发一份诊断。
 * @param {string} text 已拼好的诊断文本
 * @param {string} [why] 'auto' 自动发 / 'manual' 人点的
 * @returns {Promise<{ok:boolean, why?:string, at:number, n?:number}>}
 */
async function diagSend(text, why) {
  const R = REPORT();
  const at = Date.now();
  const done = (ok, w) => {
    const rec = { at, ok, why: w || '', kind: why || 'auto' };
    stSet(K_DIAG, rec);
    return Object.assign({ ok }, rec);
  };

  if (!R || !R.enabled) return done(false, 'off');
  if (!R.url) return done(false, 'nourl');

  /* 日上限：过了就只记账不发，设置页会显示"今天已达上限" */
  const day = new Date(at).toISOString().slice(0, 10);
  const c = (await stGet(K_DIAGN)) || {};
  const n = c.day === day ? (Number(c.n) || 0) : 0;
  const cap = Number(R.maxPerDay) > 0 ? Number(R.maxPerDay) : 20;
  if (n >= cap) return done(false, 'quota');
  await stSet(K_DIAGN, { day, n: n + 1 });

  const HT = self.__HT || {};
  const body = JSON.stringify({
    v: (HT.localVer && HT.localVer()) || '',
    build: (HT.RELEASE && HT.RELEASE.build) || '',
    at: new Date(at).toISOString(),
    kind: why || 'auto',
    text: diagClip(text)
  });

  /* 8 秒：这是后台顺手做的事，不该比一次版本检查等得更久 */
  let signal;
  let timer = null;
  if (typeof AbortController === 'function') {
    const ab = new AbortController();
    signal = ab.signal;
    timer = setTimeout(() => { try { ab.abort(); } catch (e) { } }, 8000);
  }
  try {
    const r = await fetch(R.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json;charset=UTF-8' },
      body,
      cache: 'no-store',
      signal
    });
    if (!r.ok) return done(false, 'http' + r.status);
    return done(true, '');
  } catch (e) {
    const m = String((e && e.message) || e);
    return done(false, /abort/i.test(m) ? 'timeout' : 'unreach');
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ── SW 自己的错误出口 ──────────────────────────────────────────────
   service worker 没有界面。它崩了之后唯一的现象是「点图标没反应」：面板打不开，
   而面板那一侧的上报也随之停掉——服务端看到的是"这台机器不用了"，不是"这台机器坏了"。
   这一层必须自己留一个出口。

   记什么：错误码 + 出错文件名 + 行号。**不记 message 原文**：原文不可控，
   可能带 URL、页面标题或别的数据，而这一层不认识业务、判断不了该不该发。
   文件名而不是完整路径：路径里有 `C:\Users\<用户名>`，那是能定位到人的信息。

   单独存一把 `swErrLog`，不往面板那份 `obsLog` 里写：面板在内存里攒着 60 条、
   整份回写，两条通道各写各的必然互相覆盖。合并放在 tgFlush 那一侧做。

   防套娃：上报失败会抛 unhandledrejection，再触发这里——所以 3 秒内只记一条，
   错误风暴时宁可漏几条，也不能把 storage 写爆。 */
const K_SWERR = 'swErrLog';
const SW_ERR_MAX = 10;
let swErrAt = 0;
function swErrNote(code, file, line, ename) {
  const at = Date.now();
  if (at - swErrAt < 3000) return;
  swErrAt = at;
  const name = String(file || '').split(/[\/\\]/).pop() || '-';
  /* 只留错误的"姓"（TypeError / ReferenceError），不留 message 原文：
     message 不可控，可能带 URL 或页面数据；而姓 + 文件名 + 行号已经够定位，
     少了它，"line 37 出错了"这句话在任何一份代码里都成立，等于没说。 */
  const kind = String(ename || '').replace(/[^A-Za-z]/g, '').slice(0, 24);
  stGet(K_SWERR).then(old => {
    const list = (Array.isArray(old) ? old : []).slice(1 - SW_ERR_MAX);
    list.push({
      t: at, code: code, mod: name.slice(0, 16),
      fact: (kind ? kind + ' ' : '') + 'line ' + (Number(line) || 0), kind: 'err'
    });
    return stSet(K_SWERR, list);
  }).then(() => tgFlush('err')).catch(() => { });
}
/* 装上出口。沙箱（自检脚本 把这份文件当普通脚本跑）里没有 addEventListener，
   所以先问一句有没有——为跑测试去改测试环境，等于让被测代码永远不知道真实边界。 */
if (typeof self !== 'undefined' && self && typeof self.addEventListener === 'function') {
  self.addEventListener('error', e =>
    swErrNote('SW-ERR', e && e.filename, e && e.lineno, e && e.error && e.error.name));
  self.addEventListener('unhandledrejection', e =>
    swErrNote('SW-REJ', '', 0, e && e.reason && e.reason.name));
}

/* ── 运行统计：批量事件 ─────────────────────────────────────────────
   上一版只有"出错时发一段文本"。它的问题不是不好用，是**只有出错才有信号**：
   没人报错时，维护者不知道有多少台机器在用、跑的是哪个版本、取一次数要多久、
   有没有人在用某个数据源。这些都不需要问人，行业里都是自动收的
   （Sentry 的事件流、Crashlytics 的非致命事件 + 会话、OpenTelemetry 的 span）。

   所以这里补一条事件通道：客户端的 src/lib/obs.js 记事件（只记短码、模块名、
   类别、耗时），这一层负责把它们**攒成一批**发出去。为什么攒：
   一次取数会产生七八条事件，一条一个请求既慢又会把日上限吃光。

   发什么由 obs 那一侧决定，这里只搬运，不加工——能联网的这一层不认识业务，
   认识业务的那一层不联网。这是从 0.21 起就定的规矩，没变。

   日上限与 diagSend 共用一个计数（K_DIAGN）：两个通道加起来才算真实用量，
   各算一份的话，配上一个错误循环，一天能发两倍。 */
const K_SID = 'tgSid';        // 匿名安装 ID：一台机器一个，用来归并同一台机的多次事件
const K_SENT = 'tgSent';      // 上次发到哪条事件（毫秒），断点续传
const K_BEAT = 'tgBeat';      // 上次心跳的日期（YYYY-MM-DD），一天只发一次
const TG_ALARM = 'ht-beat';
const TG_MIN = 1440;          // 心跳周期：一天一次
const TG_MAX = 40;            // 单批最多几条，多了只发最近的

/* 这里曾经有一个 tgOn()：读 chrome.storage.local 的 'tgOn'，没设过按
   release.report.auto（默认关）算。已撤掉（1.8.0）——用户要的是
   「有错误就主动上传，没错误就不管，不用有开关」。
   **必须连读取一起去掉**：老机器存储里躺着 tgOn:false，留着判定就等于
   升级后从此一条都不发，而且界面上没有任何地方能看出来。 */

/**
 * 匿名安装 ID。
 * 不是用户 ID、不是机器指纹：随机 16 位、装的时候生成一次、卸载即消失。
 * 它唯一的用途是"这三条错误是不是同一台机器"，以及"这台机器还在不在用"。
 */
async function tgSid() {
  const cur = await stGet(K_SID);
  if (cur) return String(cur);
  let s = '';
  try {
    const a = new Uint8Array(8);
    crypto.getRandomValues(a);
    s = Array.from(a).map(x => ('0' + x.toString(16)).slice(-2)).join('');
  } catch (e) {
    s = Math.random().toString(16).slice(2, 18).padEnd(16, '0');
  }
  await stSet(K_SID, s);
  return s;
}

/**
 * 把攒着的事件发一批。
 * @param {string} why 'beat' 心跳 / 'panel' 面板里发生的事 / 'err' 出错 / 'manual' 人点的
 * @returns {Promise<{ok:boolean, why?:string, n?:number}>} 永远 resolve
 */
async function tgFlush(why) {
  const R = REPORT();
  const kind = why || 'panel';
  if (!R || !R.enabled || !R.url) return { ok: false, why: 'off' };

  /* 面板那份（obsLog）与 SW 自己那份（swErrLog）在这里合并。
     两份各写各的，是因为面板整份回写会覆盖 SW 写进去的条目；合并放在发送这一侧，
     取数的地方就不必知道有两个来源。按时间排一次，`slice(-TG_MAX)` 才是"最近几条"。 */
  const fromPanel = (await stGet('obsLog')) || [];
  const fromSw = (await stGet(K_SWERR)) || [];
  const since = Number(await stGet(K_SENT)) || 0;
  const fresh = (Array.isArray(fromPanel) ? fromPanel : [])
    .concat(Array.isArray(fromSw) ? fromSw : [])
    .sort((a, b) => (Number(a && a.t) || 0) - (Number(b && b.t) || 0))
    .filter(e => e && typeof e.t === 'number' && e.t > since)
    .slice(-TG_MAX);

  /* 心跳即使没有新事件也要发一条：否则"用户装了但从没出错"和"用户早就不用了"
     在服务端长得一模一样。这条只带版本与环境，不含任何事件。 */
  if (!fresh.length && kind !== 'beat') return { ok: true, n: 0 };

  /* 日上限：与 diagSend 共用 K_DIAGN。心跳不算额度（一天最多一条，
     不会因为心跳把额度吃光导致真正的错误发不出去）。 */
  const at = Date.now();
  const day = new Date(at).toISOString().slice(0, 10);
  if (kind !== 'beat') {
    const c = (await stGet(K_DIAGN)) || {};
    const n = c.day === day ? (Number(c.n) || 0) : 0;
    const cap = Number(R.maxPerDay) > 0 ? Number(R.maxPerDay) : 20;
    if (n >= cap) return { ok: false, why: 'quota' };
    await stSet(K_DIAGN, { day, n: n + 1 });
  }

  const HTb = self.__HT || {};
  const body = JSON.stringify({
    v: (HTb.localVer && HTb.localVer()) || '',
    build: (HTb.RELEASE && HTb.RELEASE.build) || '',
    at: new Date(at).toISOString(),
    kind: 'batch',
    why: kind,
    sid: await tgSid(),
    events: fresh.map(e => ({
      t: e.t,
      code: String(e.code || '').slice(0, 24),
      mod: String(e.mod || '').slice(0, 16),
      kind: String(e.kind || 'err').slice(0, 8),
      fact: String(e.fact || '').slice(0, 160),
      dur: Number(e.dur) || 0
    }))
  });

  /* 6 秒：这是后台顺手做的事，比一次版本检查还短——它不该拖住面板 */
  let signal;
  let timer = null;
  if (typeof AbortController === 'function') {
    const ab = new AbortController();
    signal = ab.signal;
    timer = setTimeout(() => { try { ab.abort(); } catch (e) { } }, 6000);
  }
  try {
    const r = await fetch(R.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json;charset=UTF-8' },
      body,
      cache: 'no-store',
      signal
    });
    if (!r.ok) {
      await stSet(K_DIAG, { at, ok: false, why: 'http' + r.status, kind });
      return { ok: false, why: 'http' + r.status };
    }
    /* 只有发成功才推进游标：失败了下次重发，不会把事件丢掉。
       用事件里最大的 t，不取 now——now 会把这段时间里新产生的事件一起跳过。 */
    if (fresh.length) await stSet(K_SENT, Math.max.apply(null, fresh.map(e => e.t)));
    else await stSet(K_SENT, at);
    if (kind === 'beat') await stSet(K_BEAT, day);
    await stSet(K_DIAG, { at, ok: true, why: '', kind, n: fresh.length });
    return { ok: true, n: fresh.length };
  } catch (e) {
    const m = String((e && e.message) || e);
    const w = /abort/i.test(m) ? 'timeout' : 'unreach';
    await stSet(K_DIAG, { at, ok: false, why: w, kind });
    return { ok: false, why: w };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 心跳闹钟：一天一次。装、启动、面板每次发完都会顺手对齐一次。 */
function syncBeat() {
  try {
    chrome.alarms.create(TG_ALARM, { periodInMinutes: TG_MIN, delayInMinutes: 3 });
  } catch (e) { }
}

/* ── 下载结果的回执 ───────────────────────────────────────────────
   downloads.download 的回调只说明"浏览器接下了这个任务"，不说明下载成功。
   被安全浏览拦下、服务器中途断开、磁盘写不进去，全都发生在回调之后。上一版
   拿到回调就报「已开始下载」，于是被拦下的下载表现成：下载气泡闪一下就没了，
   点的人只看到"弹了一下，然后什么都没有"。

   这里订阅 onChanged，等下载真正有了终态（complete / interrupted）再回报。
   id 存进 storage 而不只放内存：MV3 的 SW 会被回收，几十秒的下载足够它死一次，
   死了内存表就空了，回执永远发不出去——那又变回"点了没反应"。 */
const K_DL = 'dlIds';             // 我们自己发起的下载 id，用来过滤别人的下载
const dlIds = new Map();

async function dlRemember(id) {
  dlIds.set(id, Date.now());
  const arr = ((await stGet(K_DL)) || []).filter(o => o && o.id !== id);
  arr.push({ id, at: Date.now() });
  await stSet(K_DL, arr.slice(-8));
}

/* SW 每次醒来把没结算的 id 读回来。超过 30 分钟的一律丢掉：那是上一轮的残留。 */
(async () => {
  const arr = (await stGet(K_DL)) || [];
  const now = Date.now();
  arr.filter(o => o && o.id && now - o.at < 30 * 60 * 1000)
    .forEach(o => dlIds.set(o.id, o.at));
})();

function dlBroadcast(o) {
  try {
    chrome.runtime.sendMessage(Object.assign({ type: 'dlResult' }, o), () => {
      /* 没有页面在听时会报 lastError，读一下消掉，别在控制台留噪音 */
      void chrome.runtime.lastError;
    });
  } catch (e) { }
}

function dlSettle(id) {
  try {
    chrome.downloads.search({ id }, items => {
      const it = items && items[0];
      if (!it || it.state === 'in_progress') return;   // 还没结束，等下一次变化
      dlIds.delete(id);
      stGet(K_DL).then(arr => stSet(K_DL, (arr || []).filter(o => o && o.id !== id)));
      dlBroadcast({
        id,
        state: it.state,                  // complete | interrupted
        error: it.error || '',
        filename: it.filename || '',
        bytes: it.fileSize || 0
      });
    });
  } catch (e) { dlIds.delete(id); }
}

if (chrome.downloads && chrome.downloads.onChanged) {
  chrome.downloads.onChanged.addListener(d => {
    /* 只认自己发起的：浏览器里别的下载不归这里管，插嘴就是噪音 */
    if (!d || !dlIds.has(d.id)) return;
    if (d.state || d.error) dlSettle(d.id);
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  if (msg.type === 'openOptions') { chrome.runtime.openOptionsPage(); return; }

  /* 版本检查只能在这里发。
     content script 的 fetch 用的是页面 origin，会被目标站的 connect-src CSP 拦掉，
     而且失败信息只是一句 TypeError: Failed to fetch —— 在面板里点"检查更新"会
     永远是"这次没查到"，还看不出是 CSP 拦的。service worker 不受页面 CSP 约束，
     只受 host_permissions 约束。这是"诊断信息别从 content script 发"同一个道理。 */
  if (msg.type === 'checkUpdate') {
    const HT = self.__HT || {};
    const fail = d => sendResponse({
      /* nobg = 后台自己没答上话（模块没加载 / 通道断了）。
         不能报成"连不上服务器"——那是两回事，处置也不一样。 */
      reason: 'nobg', local: (HT.localVer && HT.localVer()) || '',
      latest: '', hasNew: false, notes: [], url: '', detail: d
    });
    if (!HT.checkUpdate) { fail('更新模块未加载'); return true; }
    HT.checkUpdate(!!msg.force).then(v => {
      markTried(v);                 // 手动查一次也记一笔，"上次检查"说的是最后一次
      sendResponse(v);
    }, e => fail(String((e && e.message) || e)));
    return true;    // 告诉 Chrome 会异步回应，别急着关通道
  }

  /* 配置同步的请求出口。
     与版本检查同一个理由（见上一条）：content script 的 fetch 走页面 origin，
     会被 目标站点 的 connect-src 拦掉。而设置页有一半时间是**在面板里**
     打开的（齿轮浮层挂的是同一份 settings.js），那一路就属于内容脚本环境，
     直连必然得到一句"连不上服务器"——看着像云端挂了，其实是被页面拦了。
     只代理"同步根地址"下的请求：不然这条通道就是一个任意 URL 代理
     （扩展带 host_permissions，能打到哪儿它都会答应）。 */
  if (msg.type === 'cfgReq') {
    const HT = self.__HT || {};
    const root = String((HT.RELEASE && HT.RELEASE.sync && HT.RELEASE.sync.url) || '');
    if (!HT.req || !HT.req.json) {
      sendResponse({ ok: false, reason: 'unreach', detail: '请求工具未加载' });
      return true;
    }
    if (!underRoot(String(msg.url || ''), root)) {
      sendResponse({ ok: false, reason: 'unreach', detail: '地址不在同步根下' });
      return true;
    }
    HT.req.json(String(msg.url || ''), {
      method: msg.method || 'GET', body: msg.body, timeout: 8000
    }).then(r => sendResponse(r), () => sendResponse({ ok: false, reason: 'unreach', detail: '后台出错' }));
    return true;
  }

  /* 自动重载开关：只存不算——下次闹钟到点才可能真的重载，不会立刻动。
     打开时顺手清掉"已试过"的记账，否则刚打开就赶上同版本试满三次，等于没开。
     闹钟必须在这里对齐：它现在**只**为自动重载而存在（通知已删），
     开关打开时不建闹钟，这个功能就永远不会触发。 */
  if (msg.type === 'updAuto') {
    const on = msg.on === true;
    stSet(K_AUTO, on)
      .then(() => (on ? stSet(K_TRIED, { ver: '', at: 0, n: 0 }) : null))
      .then(() => syncAlarm())
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  /* 获取安装包。
     .zip 走 downloads（能指定文件名、能进下载记录）；其余当说明页用新标签打开。 */
  if (msg.type === 'updGet') {
    const u = String(msg.url || '');
    const feed = (UPD() || {}).feedUrl || '';
    if (!u || !sameOrigin(u, feed)) { sendResponse({ ok: false, why: '地址不可信' }); return true; }
    if (/\.zip(\?|$)/i.test(u)) {
      const name = 'FARS-Assistant-' + String(msg.ver || 'new') + '.zip';
      const sha = String(msg.sha256 || '').trim().toLowerCase();
      const size = Number(msg.size) || 0;
      const start = () => {
        try {
          chrome.downloads.download({ url: u, filename: name, saveAs: false }, id => {
            /* lastError.message 是浏览器自己的英文原话，只留给 raw 排障；
               界面上说"没开始"和"为什么没开始"就够了。 */
            const le = chrome.runtime.lastError;
            if (le) {
              sendResponse({ ok: false, why: '浏览器拒绝了这次下载', raw: String(le.message || '') });
              return;
            }
            /* 回调没报错只代表任务被接下，不代表下载成功——记住 id，
               等 onChanged 的终态再回报，别在这儿就说"已下载"。 */
            if (typeof id === 'number' && id > 0) dlRemember(id);
            sendResponse({ ok: true, id, name, sha256: sha });
          });
        } catch (e) { sendResponse({ ok: false, why: '下载功能不可用' }); }
      };
      /* 清单没给指纹（老清单）就照旧直接下：少了这道核对，但不该因此下不了。 */
      if (!sha) { start(); return true; }
      verifyPkg(u, size, sha).then(r => {
        if (!r.ok) { sendResponse({ ok: false, why: r.why, raw: r.detail || '' }); return; }
        start();
      }, e => sendResponse({
        ok: false, why: '安装包没核对成', raw: String((e && e.message) || e)
      }));
      return true;
    }
    try { chrome.tabs.create({ url: u }); sendResponse({ ok: true, tab: true }); }
    catch (e) { sendResponse({ ok: false, why: '打不开' }); }
    return true;
  }

  /* 诊断上报。面板出错时自动发，设置页也能手动点一次。
     不设确认框：发出去的就是"可以随手截图"的那一份（短码 + 模块名），
     没有起数、没有区域、没有模板正文。 */
  /* 面板每产生一批事件（生成完成、出错）就交给这里发一次，不等也不问。
     回执只给设置页看一眼，不影响面板的任何流程。 */
  if (msg.type === 'tgFlush') {
    tgFlush(msg.why || 'panel')
      .then(r => { syncBeat(); sendResponse(r); })
      .catch(() => sendResponse({ ok: false, why: 'bg' }));
    return true;
  }

  /* 「运行统计」开关已撤（1.8.0）：默认就发，界面不给关。
     这里保留一个空的应答，是为了让还没重新加载的旧设置页
     （同一次会话里已经画出来的那一份）点了不会报"扩展没有响应"。 */
  if (msg.type === 'tgOn') {
    syncBeat();
    sendResponse({ ok: true, gone: true });
    return true;
  }

  if (msg.type === 'diagSend') {
    diagSend(msg.text, msg.kind)
      .then(r => sendResponse(r))
      .catch(() => sendResponse({ ok: false, why: 'sw' }));
    return true;
  }

  /* 设置页要显示"上次上报是什么时候、成不成"——只读，不发请求 */
  if (msg.type === 'diagStat') {
    Promise.all([stGet(K_DIAG), stGet(K_DIAGN)]).then(([last, cnt]) => {
      const day = new Date().toISOString().slice(0, 10);
      sendResponse({
        last: last || null,
        today: cnt && cnt.day === day ? (Number(cnt.n) || 0) : 0,
        cap: Number((REPORT() || {}).maxPerDay) || 20,
        enabled: !!(REPORT() || {}).enabled,
        url: (REPORT() || {}).url || ''
      });
    }).catch(() => sendResponse(null));
    return true;
  }

  /* （1.9.1）撤掉"让自己重载"那条应答：设置页那颗按钮已经删了。
     浏览器扩展页自带刷新，扩展里再开一条通道只是多一个不需要的权限面。
     老版本客户端不会再来问——它自带旧界面、旧后台，整包一起换，
     不存在"新后台被旧界面调用"的错配。 */
});
