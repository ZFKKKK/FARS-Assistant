/**
 * src/lib/obs.js —— 观测记录的本地环形缓冲
 *
 * @layer  lib（纯工具）
 * @file   src/lib/obs.js
 * @since  0.21.0
 *
 * 只做三件事：装监听、往缓冲里放一条、把缓冲读出来。
 * 不拼文案、不判业务、不联网、不读别的层的任何东西——连版本号都不读，
 * 因为 lib 不能依赖 data（那是反方向的箭头）。
 *
 * 边界不在这个文件里守，在调用方守。每条只允许带五个短字段：
 *   code  稳定短码（九类错误码 / CHK-FAIL / ERR-UNCAUGHT / ERR-REJECT / GEN-OK）
 *   mod   哪个模块报的（checks / panel / settings / http）
 *   fact  一句话事实。**校验类只许写校验项的 key**（det.town），
 *         不许写"区域加总 123，有效 551"。
 *   kind  这一类事件是什么：err 出错 / use 用了一次 / perf 耗时 / beat 心跳。
 *         行业里叫 event type，服务端按它分流（Sentry 的 level、Crashlytics 的
 *         fatal/non-fatal 是同一件事）。默认 err，不写就是出错。
 *   dur   毫秒数，只给 perf 用。**只记时长不记内容**——一分钟取完数和一秒取完数
 *         都可能对，差别在于要翻几页、网快不快。
 *
 * 为什么这条规矩要写死在注释里：
 *   这份记录唯一的用途是"发给维护的人看"，而最方便的发送方式是截图。
 *   一旦 fact 里出现起数、同比、区域名，这张截图就不能往外发了，功能也就废了。
 *   所以宁可少记信息，也不让数字进来——
 *   verify 有一条断言：CHK-* 的 fact 只允许小写字母和点。
 *
 * 为什么落 storage 而不是只在内存里：
 *   出错的多半是"面板挂了"，内存里的东西跟着一起没；而人往往是关掉面板
 *   之后才想起来要报障的。storage.local 落盘，关浏览器也还在。
 *
 * 为什么不自己发网络请求：
 *   这个扩展跑在政务统计站上，页面里每一个数字都是记录数据。
 *   所以这一层只写本机，**永远不联网**；发不发由 ui/feedback.js 那一侧决定，
 *   而且发出去的只有"短码 + 模块名 + 校验项名 + 版本 + 环境"这几样，
 *   一条起数、一个区域名、半句模板正文都不会离开这台机器。
 *   分层的意义就在这里：能联网的那一层不认识业务，认识业务的那一层不联网。
 */
(function (g) {
  'use strict';
  const HT = (g.__HT = g.__HT || {});

  const KEY = 'obsLog';
  /** 上限 60 条。原来是 20——那时只记错，20 条足够看出模式。
      现在还要记"用了几次、每次多久"，60 条才够攒到一次批量上报；
      再多也不会出现新模式，只会把最近的挤掉。 */
  const MAX = 60;

  let buf = null;          // null = 还没从存储里读出来
  let pending = [];        // 读出之前就产生的记录，先攒着，别覆盖存储
  let loading = null;
  let installed = false;

  /** storage 在某些上下文（离线预览、Node 测试）里不存在，一律当没有 */
  function store() {
    try { return (g.chrome && g.chrome.storage && g.chrome.storage.local) || null; }
    catch (e) { return null; }
  }

  /** 一条记录必须短。换行会破坏"一行一条"，一律压成空格 */
  function clean(s, n) {
    return String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').trim().slice(0, n || 160);
  }

  function push(e) {
    buf = (buf || []).concat([e]);
    if (buf.length > MAX) buf = buf.slice(buf.length - MAX);
  }

  function persist() {
    const s = store();
    if (!s) return;
    try {
      /* 用回调形式而不是 Promise：set 失败会 reject，而 reject 会触发
         unhandledrejection → 又调 note → 无限套娃。回调里读一次 lastError 吃掉它。 */
      s.set({ [KEY]: (buf || []).slice(-MAX) }, () => {
        try { void (g.chrome.runtime && g.chrome.runtime.lastError); } catch (e) { }
      });
    } catch (e) { }
  }

  /**
   * 从存储里读一次，把攒着的 pending 接在后面。
   *
   * 这里有个容易写错的地方：读之前如果已经 note 过（脚本刚加载就抛错），
   * 直接 persist 会用"只有新记录"的数组覆盖掉存储里的历史。
   * 所以读之前一律不写，攒在 pending 里，hydrate 完合并再写一次。
   */
  function ready() {
    if (loading) return loading;
    loading = new Promise(res => {
      const done = arr => {
        buf = (Array.isArray(arr) ? arr.slice(-MAX) : []).concat(pending).slice(-MAX);
        const had = pending.length;
        pending = [];
        if (had) persist();
        res(buf);
      };
      const s = store();
      if (!s) return done([]);
      try { s.get(KEY, r => done(r && r[KEY])); } catch (e) { done([]); }
    });
    return loading;
  }

  /** 事件类别只认这四个。认不出就当 err——宁可多报一次错，也别丢一条。 */
  const KINDS = { err: 1, use: 1, perf: 1, beat: 1 };

  /**
   * 折叠窗口：同一个 (code, mod, fact) 60 秒内只留一条。
   *
   * 一个错误一旦成环，一次出稿能记十几条一模一样的记录（线上抓到的一次
   * 批量里 17 条同一形状）。它们把 60 条的缓冲占满，把真正的首条和别的
   * 错误一起挤掉，服务端那边也是十几份同样的东西。
   * 折叠只在内存里做：同一秒内的重复本来就没有新信息；60 秒之后如果还在犯，
   * 说明是持续性问题，那时再记一条。
   */
  const FOLD_MS = 60000;
  /** 单元分隔符：短码/模块名/事实文字里不可能出现，拼键时不会串味 */
  const SEP = String.fromCharCode(31);
  let foldKey = '';
  let foldAt = 0;

  /**
   * 写一条。
   * @param {{code?:string, mod?:string, fact?:string, kind?:string, dur?:number}} o
   * @returns {object} 实际记下的那一条（已裁剪）；被折叠时返回的那条没有落库
   */
  function note(o) {
    const src = o || {};
    const e = {
      t: Date.now(),
      code: clean(src.code, 24) || 'ERR-UNKNOWN',
      mod: clean(src.mod, 16) || '-',
      fact: clean(src.fact, 160),
      kind: KINDS[src.kind] ? src.kind : 'err'
    };
    /* 时长只收正数、封顶一小时：一次取数超过一小时基本是卡死了，
       记成 3600000 够看出问题，不必存真实的天文数字。 */
    if (e.kind === 'perf') {
      const d = Math.round(Number(src.dur) || 0);
      e.dur = d > 0 ? Math.min(d, 3600000) : 0;
    }
    /* perf 的时长本身就是信息（3 秒和 40 秒是两回事），所以时长进键、不参与折叠 */
    const key = [e.code, e.mod, e.fact, e.kind, e.dur == null ? '' : e.dur]
      .join(SEP);
    if (key === foldKey && e.t - foldAt < FOLD_MS) return e;
    foldKey = key;
    foldAt = e.t;
    if (buf === null) pending.push(e);
    else { push(e); persist(); }
    return e;
  }

  /** @returns {Promise<Array<{t:number,code:string,mod:string,fact:string,kind:string,dur?:number}>>} */
  function list() { return ready().then(() => buf.slice()); }

  /** 清空。先等 hydrate 完，否则清完又被存储里的旧内容填回来 */
  function clear() {
    return ready().then(() => {
      buf = [];
      pending = [];
      /* 折叠记忆一起清：清空之后再有同样的错误，应当重新记一条，
         而不是被上一轮的记忆吃掉（"清空"就是从头看）。 */
      foldKey = '';
      foldAt = 0;
      const s = store();
      if (s) { try { s.remove(KEY, () => { }); } catch (e) { } }
      return buf;
    });
  }

  /**
   * 取堆栈里第一个"文件:行:列"。
   * 不要整段堆栈：五行堆栈占满一条记录，真正有用的只有"崩在哪一行"。
   */
  function shortStack(err) {
    try {
      const st = err && err.stack;
      if (!st) return '';
      const ls = String(st).split('\n');
      for (let i = 1; i < ls.length; i++) {
        const m = ls[i].match(/([^/\\()\s]+:\d+:\d+)/);
        if (m) return m[1];
      }
    } catch (e) { }
    return '';
  }

  /**
   * 装全局监听。
   *
   * 只有两处需要装：content script 的隔离世界（面板与 Shadow DOM 全在里面，
   * 同一个 realm，一个监听就够）和扩展页面（options.html）。
   * service worker 只有三十几行、唯一的监听还是 chrome.runtime.onMessage，
   * 装了也基本抓不到东西，所以不装。
   *
   * @param {string} where 'content' | 'options'
   */
  function install(where) {
    if (installed) return;
    installed = true;
    ready();
    const tag = where || 'ui';
    /* 浏览器自己发的一类"提示"，不是错误。
       最典型的是 ResizeObserver：回调里改了尺寸 → 又触发布局 → 提示
       「还有未投递的通知」。它不抛异常、不影响任何功能，却会以 error 事件
       冒出来，一条出稿能记十几次（线上抓到的日志里一次批量就有 17 条），
       把真错误淹了，也把「今天报了几次」弄脏。 */
    const BENIGN = [/ResizeObserver loop/i];
    const benign = m => BENIGN.some(re => re.test(String(m || '')));
    /* 内容脚本里的记录只有三条路能出去：打开面板、每日心跳、人点上报。
       **"面板打不开"这类故障恰好把第一条堵死**——（1.12.2 与 1.12.3）就是这样静默了
       两版：点了没反应，服务端一条日志都没有，只能靠使用者一句"不行啊"。
       所以出错时顺带催后台发一次；节流 20 秒，额度沿用 tgFlush 自己的口径
       （一天 20 条），不另开一套计数。 */
    let pingAt = 0;
    const ping = () => {
      const at = Date.now();
      if (at - pingAt < 20000) return;
      pingAt = at;
      try {
        const c = g.chrome;
        if (!c || !c.runtime || !c.runtime.sendMessage) return;
        c.runtime.sendMessage({ type: 'diagFlush' }, () => {
          try { void (c.runtime.lastError); } catch (e) { }
        });
      } catch (e) { }
    };
    try {
      g.addEventListener('error', ev => {
        const msg = (ev && ev.message) || '脚本错误';
        if (benign(msg)) return;
        const at = shortStack(ev && ev.error);
        note({ code: 'ERR-UNCAUGHT', mod: tag, fact: msg + (at ? ' @ ' + at : '') });
        ping();
      });
      g.addEventListener('unhandledrejection', ev => {
        const r = ev && ev.reason;
        const msg = (r && (r.message || r)) || '未处理的 Promise 拒绝';
        note({ code: 'ERR-REJECT', mod: tag, fact: msg });
        ping();
      });
    } catch (e) { }
  }

  Object.assign(HT, { obs: { note, list, clear, install, MAX, KEY } });
})(typeof window !== 'undefined' ? window : globalThis);
