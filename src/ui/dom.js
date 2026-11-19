/**
 * src/ui/dom.js —— 样式令牌与 DOM 小工具
 *
 * @layer  ui（表现层）
 * @since  0.22.0（0.21.0 及以前是 tokens.js / dom.js 两个文件）
 *
 * 为什么合成一个：tokens 是 40 行的状态与动效常量，dom 是 54 行的 el/on/inPath。
 * 两者都只被 ui 层别处引用，谁也不会单独改动其中一半。
 *
 * 组内顺序：tokens → dom。
 */

/**
 * src/ui/tokens.js —— UI 状态表与动效令牌
 *
 * @layer  ui（表现层）
 * @file   原 src/ui/tokens.js（0.22.0 并入 dom.js）
 * @since  5.0.0
 *
 * 状态文案与灯色集中一处：面板的胶囊、标题栏那三个字、状态点的颜色都从这里取，
 * 避免"状态改了但提示没改"这类不同步问题。
 */
(function (g) {
  'use strict';
  const HT = (g.__HT = g.__HT || {});

  /**
   * 七态。label=面板胶囊与状态栏共用的**唯一短名**（三字以内），
   * tip=入口的原生提示（长句，允许与短名不同说法），pill=胶囊配色，dot=状态点色。
   *
   * why 两处共用一个 label：以前胶囊写「未登录」、状态栏写「请登录」，
   * 同一件事两个词，文档里又是第三种写法。短名只能有一份，长句才分场合。
   * 「未到点」有两个 tip 不是笔误：一个是"时间还没到"，一个是"过了点但取上一周期"，
   * 短名相同、原因不同——原因本来就该由 tip 说。
   */
  const UI_STATE = {
    checking: { label: '检测中', tip: '检测中', pill: '', dot: 'mute' },
    nologin: { label: '请登录', tip: '未登录，点开看提示', pill: 'warn', dot: 'mute' },
    pending: { label: '未到点', tip: '未到截点', pill: 'warn', dot: 'wait' },
    ready: { label: '已就绪', tip: '已就绪，可生成', pill: 'ok', dot: 'ready' },
    running: { label: '取数中', tip: '取数中', pill: 'warn', dot: 'wait' },
    done: { label: '已生成', tip: '已生成', pill: 'ok', dot: 'done' },
    error: { label: '出错', tip: '出错，点开看原因', pill: 'bad', dot: 'bad' }
  };

  /**
   * 灯色只给语义名，色号由 panel.css 的 --ht-dot-* 决定：
   * JS 里写 #D97706 会让同一块颜色有两份真源（改主题要改两处）。
   *
   * 「未登录」用灰不用琥珀：它不是一个"即将开始"的等待，而是"这条路现在走不了"，
   * 与「未到点」的等不是一回事。使用说明里那张灯色表写的是「灰 + 图标变淡」，
   * CSS 也确实在 s-nologin 上把图标压到 48%——灯色跟着对齐，文档与界面才不会两说。
   */
  const DOT_VAR = d => ({
    mute: 'var(--ht-gray-400)',
    wait: 'var(--ht-wa-b)',
    ready: 'var(--ht-brand-600)',
    done: 'var(--ht-ok-b)',
    bad: 'var(--ht-ba-b)'
  })[d] || 'var(--ht-gray-400)';


  /**
   * 不在七态里、但同样会出现在状态栏的两个结果词。
   * 「校验未过」是"稿子有了但数字互相矛盾"，不是 error 态（灯是琥珀不是红），
   * 所以不占一个 state；但它必须只有一份写法——以前 `setFoot` 里手写两遍。
   */
  const UI_WORD = { chkFail: '校验未过' };

  /**
   * 图标表。**全项目只有这一份**，面板、编辑器、动作回执都从这里取。
   *
   * 为什么收在一处：以前 panel.js 一张 ICON、editor.js 一张 OP_ICON、
   * feedback.js 另有两个内联常量——同一个动作的图标能在两处长得不一样，
   * 而它们的 viewBox 与 aria 属性本来必须一致：尺寸、颜色、线宽由 CSS 的
   * `.ht-ico svg` 决定，`aria-hidden` 少写一个，读屏就会念一串图形名。
   *
   * 几何取自 Tabler Icons Outline（24×24，stroke 描边，无 fill）；
   * 命名按**动作**，不按形状：foldOpen/foldClose 分别是展开与收起，
   * focusIn/focusOut 分别是进入与退出专注，fileDown 是"导出成文件"，
   * 与 arrowDown（列表里往下挪一行）不是一件事。
   *
   * **width/height 写在属性上是有意的**：正常情况 CSS 的 `.ht-ico svg`
   * 会盖掉这两个值（CSS 优先于表现属性），但样式表没加载成功时，
   * 没有尺寸的 `<svg viewBox="0 0 24 24">` 会按替换元素默认尺寸摊开
   * （300×150 级别）——一屏图标全变成巨幅图形。属性上的 18px 是这条兜底。
   */
  const icon = d => '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' + d + '</svg>';
  const ICON = {
    gear: icon('<path d="M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065"></path>' +
      '<path d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0"></path>'),
    x: icon('<path d="M18 6l-12 12"></path><path d="M6 6l12 12"></path>'),
    copy: icon('<path d="M7 7m0 2.667a2.667 2.667 0 0 1 2.667 -2.667h8.666a2.667 2.667 0 0 1 2.667 2.667v8.666a2.667 2.667 0 0 1 -2.667 2.667h-8.666a2.667 2.667 0 0 1 -2.667 -2.667z"></path>' +
      '<path d="M4.012 16.737a2.005 2.005 0 0 1 -1.012 -1.737v-10c0 -1.1 .9 -2 2 -2h10c.75 0 1.158 .385 1.5 1"></path>'),
    /* 导出：文件 + 下箭头（file-download）。与「复制」分开：复制进剪贴板，
       导出落成本地 txt，两个动作的落点不同。 */
    fileDown: icon('<path d="M14 3v4a1 1 0 0 0 1 1h4"></path>' +
      '<path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z"></path>' +
      '<path d="M12 17v-6"></path><path d="M9.5 14.5l2.5 2.5l2.5 -2.5"></path>'),
    /* 专注：四角向外 = 只保留这一段。与上一行的 chevron 分属两条轴，
       不会让人误读成同一个动作。 */
    focusIn: icon('<path d="M4 8v-2a2 2 0 0 1 2 -2h2"></path><path d="M4 16v2a2 2 0 0 0 2 2h2"></path>' +
      '<path d="M16 4h2a2 2 0 0 1 2 2v2"></path><path d="M16 20h2a2 2 0 0 0 2 -2v-2"></path>'),
    focusOut: icon('<path d="M15 19v-2a2 2 0 0 1 2 -2h2"></path><path d="M15 5v2a2 2 0 0 0 2 2h2"></path>' +
      '<path d="M5 15h2a2 2 0 0 1 2 2v2"></path><path d="M5 9h2a2 2 0 0 0 2 -2v-2"></path>'),
    /* 展开/收起：单个 chevron。方向即动作——朝上表示可以往上收，
       朝下表示可以放下来；不需要第二个箭头陪衬。 */
    foldOpen: icon('<path d="M6 15l6 -6l6 6"></path>'),
    foldClose: icon('<path d="M6 9l6 6l6 -6"></path>'),
    help: icon('<path d="M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0"></path>' +
      '<path d="M12 17l0 .01"></path>' +
      '<path d="M12 13.5a1.5 1.5 0 0 1 1 -1.5a2.6 2.6 0 1 0 -3 -4"></path>'),
    back: icon('<path d="M15 6l-6 6l6 6"></path>'),
    /* 刷新：标题栏主按钮。动作是重新取数并重新成稿，
       绕圈箭头比"生成"两个字更短，也不占标题栏高度。 */
    refresh: icon('<path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4"></path>' +
      '<path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"></path>'),
    minus: icon('<path d="M5 12l14 0"></path>'),
    plus: icon('<path d="M12 5l0 14"></path><path d="M5 12l14 0"></path>'),
    /* ── 编辑器段落操作：上移 / 下移 / 删掉这一段 ── */
    arrowUp: icon('<path d="M12 5l0 14"></path>' +
      '<path d="M18 11l-6 -6"></path><path d="M6 11l6 -6"></path>'),
    arrowDown: icon('<path d="M12 5l0 14"></path>' +
      '<path d="M13 13l6 6"></path><path d="M5 13l6 6"></path>'),
    trash: icon('<path d="M4 7l16 0"></path>' +
      '<path d="M10 11l0 6"></path><path d="M14 11l0 6"></path>' +
      '<path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12"></path>' +
      '<path d="M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3"></path>'),
    /* ── 动作回执：复制/导出点完当场变样，不靠悬停才出来的原生 tooltip ── */
    tick: icon('<path d="m5 12.6 4.5 4.5L19 6.9"></path>'),
    bang: icon('<path d="M12 6.8v6.4"></path>' +
      '<circle cx="12" cy="17" r="1.05" fill="currentColor" stroke="none"></circle>'),
    /* ── 校验栏四态：对勾 / 三角 / 叉 / 信息 ──
       形状固定，只有颜色随 .ok/.warn/.bad/.note 变；note 是附注，不是待核项。 */
    ckOk: icon('<path d="M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0"></path>' +
      '<path d="M9 12l2 2l4 -4"></path>'),
    ckWarn: icon('<path d="M12 9v4"></path>' +
      '<path d="M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636 -2.87l-8.106 -13.536a1.914 1.914 0 0 0 -3.274 0z"></path>' +
      '<path d="M12 16h.01"></path>'),
    ckBad: icon('<path d="M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0"></path>' +
      '<path d="M10 10l4 4m0 -4l-4 4"></path>'),
    ckNote: icon('<path d="M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0"></path>' +
      '<path d="M12 9h.01"></path>' +
      '<path d="M11 12h1v4h1"></path>'),
    /* 空态那个小机器人：32 格画布，比 24 那批图标大一圈，单独给 viewBox */
    ghost: '<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">' +
      '<circle cx="16" cy="5.4" r="2.6" fill="currentColor"/>' +
      '<rect x="3.2" y="11" width="25.6" height="17.9" rx="7.2" fill="currentColor"/>' +
      '</svg>'
  };

  /** 动效时长（ms）。与 panel.css 的 --ht-d-* 保持一致 */
  const DUR = { press: 90, exit: 130, enter: 200, snap: 560, stagger: 24 };

  /**
   * UI 的等待时长（ms）。和 DUR 分开：DUR 是动画帧，这里等的是"人"。
   *
   * 以前这些数字散在 panel.js / fab.js / settings.js 的 setTimeout 里
   * （1500、2500、30000、3000、900…），改一个节奏要在三处找。
   * 只收"决定界面行为"的那几个；纯装饰性的（一次 320ms 的收尾）留在原地，
   * 收到了反而让人以为它可调。
   */
  const UI_MS = {
    hint: 1500,        // 按钮下的瞬时提示停留
    loginPoll: 2500,   // 登录态轮询
    anchorPoll: 30000, // 截点轮询（跨整点要自己变状态）
    cssWait: 900       // 样式加载兜底：再慢也要能用
  };

  /** 弹簧曲线：过冲小、收尾快，用于吸附与弹入 */
  const EASE = { out: 'cubic-bezier(.22,1,.36,1)', in: 'cubic-bezier(.4,0,1,1)', spring: 'cubic-bezier(.22,1.35,.36,1)' };

  const prefersReduced = () => {
    try { return g.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  };

  Object.assign(HT, { UI_STATE, UI_WORD, DUR, UI_MS, EASE, prefersReduced, DOT_VAR, ICON });
})(typeof window !== 'undefined' ? window : globalThis);

/**
 * src/ui/dom.js —— DOM 与事件原语
 *
 * @layer  ui（表现层）
 * @file   原 src/ui/dom.js（0.22.0 并入 dom.js）
 * @since  5.0.0
 *
 * 只放"每个模块都会用一次"的东西。跟业务无关，但能显著减少面板与入口里的重复代码。
 */
(function (g) {
  'use strict';
  const HT = (g.__HT = g.__HT || {});

  /** ShadowRoot 里没有 document.getElementById，统一走这里 */
  const byId = (root, id) => root.getElementById(id);

  /** 建元素：el('div', 'a b', '文字') */
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  const on = (node, type, fn, opt) => node.addEventListener(type, fn, opt);
  const off = (node, type, fn, opt) => node.removeEventListener(type, fn, opt);

  /** 事件是否发生在 node 内（穿透 Shadow DOM 的唯一可靠判断） */
  function inPath(e, node) {
    const path = e.composedPath ? e.composedPath() : [];
    return path.includes(node);
  }

  /** 防连点：同一 key 在 ms 内只放行一次 */
  function createThrottle() {
    const last = Object.create(null);
    return (key, ms) => {
      const t = Date.now();
      if (t - (last[key] || 0) < ms) return true;
      last[key] = t;
      return false;
    };
  }

  /** 重新触发一次 CSS 动画（移除类 → 强制重排 → 加回类） */
  function replay(node, cls, ms) {
    node.classList.remove(cls);
    void node.offsetWidth;
    node.classList.add(cls);
    setTimeout(() => node.classList.remove(cls), ms || 400);
  }

  /* ── 界面字体 ─────────────────────────────────────────────────────
     界面文字用 Noto Sans SC：它是可变字体，550 / 650 这两个字重才是**真的**
     画出来（雅黑只有 400 / 700 两档，中间值要么吸附要么合成，层级就糊了）。
     整套 17.7MB，所以只取界面用到的字裁成子集 `fonts/ht-sans.woff2`
     （约 290KB，`debug/build_font.js` 生成）。界面上没出现的字——使用者手打
     的、站点返回的站名——逐字回退到 `--ht-font` 后面那串系统字体，
     不是缺字方块。

     为什么用 FontFace 而不是 CSS 里的 @font-face：面板样式是 fetch 回来
     `new CSSStyleSheet()` 塞进 Shadow DOM 的，**构造式样式表里的相对 url()
     按页面地址解析**——写 url("fonts/…") 会去目标站域名下找，404 还会留在
     人家的访问日志里。FontFace 拿的是 chrome.runtime.getURL 的绝对地址，
     内容脚本与设置页两条路都对。

     又为什么不把地址直接交给 FontFace、而是先 fetch 成 ArrayBuffer：
     字体请求在 CSS 与 FontFace 里都是 CORS 语义，跨源取扩展内文件要多赌一层；
     fetch 走的是内容脚本自己的扩展上下文（panel.css 就是这么取的，稳），
     拿到字节后本地解码，那一层就没了。293KB，一次。

     失败不抛、只 resolve(false)：字体是观感不是功能，拿不到就用系统字体。
     同一次会话只试一次（结果缓存），省得每次开面板都赌一把。 */
  let fontP = null;
  function loadFont() {
    if (fontP) return fontP;
    fontP = (async () => {
      try {
        const url = g.chrome.runtime.getURL('fonts/ht-sans.woff2');
        const res = await fetch(url);
        if (!res.ok) return false;
        const buf = await res.arrayBuffer();
        /* 权重区间 320 720 与裁字体时夹的那段一致：声明得比字体宽，
           请求 800 时浏览器会去合成，反而更丑 */
        const face = new FontFace('HT Sans', buf,
          { weight: '320 720', style: 'normal', display: 'swap' });
        document.fonts.add(face);
        await face.load();
        return true;
      } catch (e) { return false; }
    })();
    return fontP;
  }

  Object.assign(HT, { byId, el, on, off, inPath, createThrottle, replay, loadFont });
})(typeof window !== 'undefined' ? window : globalThis);
