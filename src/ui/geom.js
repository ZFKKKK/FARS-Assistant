/**
 * src/ui/geom.js —— 面板落位的几何口径
 *
 * @file      src/ui/geom.js
 * @version   见 src/data/release.js（此处不再写具体号，写了就会过期）
 * @license   MIT
 *
 * 1.7 之前这里还管着"悬浮钮"：SIZE / MARGIN / SNAP / DOCK_SHIFT，
 * 以及"面板底边相对钮底边上移 52"（PNEL_GAP = 44 + 8）。入口搬进顶部导航之后
 * 那一整套都作废了——入口不再能被拖动、不再靠边收纳、也不再能从屏幕底部冒出来。
 * 现在只剩两件事：**面板落位**与**面板高度**。
 *
 * 另一半价值在"纯函数"上：位置怎么算不再依赖 DOM 或模块内状态，
 * 传进去的是数字与 rect，出来的是要写进 style 的值。这样 自检脚本 能直接
 * 用假 rect 验算，不用起浏览器，也不用读源码文本猜行为。
 *
 * 依赖：只依赖 lib/util.js 建立的 __HT 命名空间，不碰 DOM、不碰存储。
 */
(function (g) {
  'use strict';
  const HT = (g.__HT = g.__HT || {});

  /* ── 度量 ───────────────────────────────────────────────── */

  /* 顶部入口与面板之间那道缝。入口是站点的导航项，高度由它自己定（30~40），
     这里只控制"面板顶边离它多远"——太贴会把入口的 hover 底色压住一半。 */
  const NAV = {
    GAP: 8
  };

  const PANEL = {
    EDGE: 18,          // 面板贴边留白
    SNAP: 10,          // 离视口边多少像素内松手才贴边
    MIN: 300,          // 再挤也要放得下标题栏 + 一行内容
    PAD: 10,           // 面板与视口上下的呼吸
    GRID: 8,           // 未贴边时对齐的网格
    GRAB: 8,           // 拖拽时距视口边的最小留白
    /* 高度上限分两种：列表态是"一眼结论"，设置/问答是"一页清单"。
       后者要能连续滚几十条，卡在 700px 就变成一屏只见三行。 */
    CAP: { list: 700, tall: 900 },
    RATIO: { list: 0.78, tall: 0.9 },
    /* 下限与上限打架时浏览器取 min-height，照样把面板撑出视口，调用方必须夹一次。
       列表态的下限**不能是一屏高**：以前给 440，四段全收起后内容只剩四个标题，
       面板却仍占 440，底部空出一大片（用户 2026-11-15 反馈）。改成 200——
       刚好放得下标题栏加四五个段标题，再少就该塌了。

       `empty` 是另一件事：还没取过数时正文只有一行提示，按 200 撑出来就是
       "点开只有一条缝"，而拖动一下又变成另一个高度，看着像界面在抽。
       空态按 440——与 CSS 里那条 min() 同值，是一块能干活的面板该有的样子。 */
    FLOOR: { list: 200, tall: 520, empty: 440 }
  };

  /* ── 视口 ───────────────────────────────────────────────── */

  const viewW = () => g.innerWidth || document.documentElement.clientWidth || 1280;
  const viewH = () => g.innerHeight || document.documentElement.clientHeight || 720;
  const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  /* ── 面板高度 ───────────────────────────────────────────── */

  /**
   * 面板的最大/最小高度。
   *
   * 只写死 78vh 是不够的：面板贴着顶边往下长，一旦被拖到屏幕中部或者窗口被
   * 缩矮，78vh 就会把底部顶到视口外——状态栏、输入区一起消失，
   * 人只会看到半块面板挂在屏幕上，还以为界面"无限伸缩"了。
   *
   * @param {{vh:number, tall:boolean, pos:?{anchor:string, bottom?:number, top?:number},
   *          anchor:string, styleTop:number, focus:boolean, empty:boolean}} o
   *   tall      设置/问答浮层开着（换成"一页清单"的上限）
   *   pos       当前落位；不存在表示还没定位过
   *   anchor    生长方向（pos 没有 bottom 时靠它算可用空间）
   *   styleTop  当前 style.top 的数值，NaN 表示 "auto"
   *   focus     专注态：外框跟着字号走，不要下限
   *   empty     正文里一段都没有（还没取过数）：下限换成空态那一档
   * @returns {{max:number, floor:number}}
   */
  function fitBox(o) {
    const vh = o.vh;
    const tall = !!o.tall;
    const cap = Math.min(tall ? PANEL.CAP.tall : PANEL.CAP.list,
      Math.round(vh * (tall ? PANEL.RATIO.tall : PANEL.RATIO.list)));
    /* 可用高度按**实际生效的锚**算，不是按存下来的那一份。
       layout 可能刚把落位翻到另一条边，这时 pos.anchor 还是旧值，
       照它量空间等于拿一条已经作废的边去算——面板被压扁，拖一下变一个高度。 */
    const anchor = o.anchor || (o.pos && o.pos.anchor) || 'bottom';
    let avail;
    if (anchor === 'top') {
      const top = Number.isFinite(o.styleTop) ? o.styleTop
        : (o.pos && Number.isFinite(Number(o.pos.top)) ? Number(o.pos.top) : PANEL.PAD);
      avail = vh - top - PANEL.PAD;
    } else {
      const bottom = o.pos && o.pos.bottom != null ? Number(o.pos.bottom) : PANEL.EDGE;
      avail = vh - bottom - PANEL.PAD;
    }
    const max = Math.min(vh - PANEL.PAD * 2,
      Math.max(PANEL.MIN, Math.min(cap, avail)));
    /* 专注态干脆不要下限：A+ 放大后文字变多、框却停在原来那么高，
       看起来就是"只有字变了、界面没变"。 */
    const want = o.empty ? PANEL.FLOOR.empty : (tall ? PANEL.FLOOR.tall : PANEL.FLOOR.list);
    const floor = o.focus ? 0 : Math.min(want, max);
    return { max: Math.round(max), floor: Math.round(floor) };
  }

  /* ── 面板落位 ───────────────────────────────────────────── */

  /**
   * 由 {anchor, bottom|top} 推出该写的 style.top / style.bottom。
   * null 表示 "auto"。
   *
   * 两种锚法是同一件事的两种情形：吸顶时**上沿**钉住 top、往下长；
   * 贴底时**下沿**钉住 bottom、往上长。后者不是"top 取个大值"能表达的——
   * 面板高度会随内容变，靠 top 反推的话每加一行字，底边就往下飘一点。
   *
   * @returns {{anchor:string, top:?number, bottom:?number}}
   */
  function layout(o) {
    const vh = o.vh;
    const pos = o.pos;
    if (pos.anchor === 'top') {
      const t = Number.isFinite(Number(pos.top)) ? Number(pos.top) : PANEL.EDGE;
      /* 锚上沿不等于"一定往下长"：上沿被拖到视口底部附近时下方只剩几十像素，
         再往下长就整块挂到视口外面去了。这时翻成贴底往上长——
         同一件事的对称面，和下面那条"上方装不下就翻到顶上"是一对。 */
      if (vh - t - PANEL.PAD >= PANEL.MIN) return { anchor: 'top', top: Math.round(t), bottom: null };
      return { anchor: 'bottom', top: null, bottom: PANEL.EDGE };
    }
    /* 上方能不能装下一个最小面板？装不下就翻到上面去，像下拉菜单在底部翻上去 */
    const upRoom = vh - pos.bottom - PANEL.PAD;
    if (upRoom >= PANEL.MIN) return { anchor: 'bottom', top: null, bottom: Math.round(pos.bottom) };
    return { anchor: 'top', top: PANEL.PAD, bottom: null };
  }

  /**
   * 松手后落在哪儿。**四边都只吸 10px**，吸不到就停在松手的地方（横向照 8px 网格对齐）。
   *
   * 横向以前按"中轴在左半还是右半"直接把面板钉到某一条边——拖到屏幕中间也会
   * 被拽回去，等于这个面板只能贴边走（用户 2026-11-15 反馈"不要放哪都吸附"）。
   * 面板是看稿子的地方，停在网页中间对照资料是正常用法。
   *
   * 阈值只有 10px：早先 24/28 时隔着老远松手就把面板吸到最近那条边上，
   * 人只是想往下挪一点，面板却整体跳一下。贴边是"帮你对一下"，
   * 不是"替你决定放哪儿"。
   *
   * @returns {{x:number, anchor:string, top?:number, bottom?:number}}
   */
  function snapPanel(o) {
    const r = o.rect;
    const vw = o.vw;
    const vh = o.vh;
    let x;
    if (r.left <= PANEL.SNAP) x = PANEL.EDGE;                       // 贴左边
    else if (vw - r.right <= PANEL.SNAP) x = vw - r.width - PANEL.EDGE;  // 贴右边
    else x = Math.round(r.left / PANEL.GRID) * PANEL.GRID;         // 停中间：对齐网格
    x = clampN(x, PANEL.GRAB, Math.max(PANEL.GRAB, vw - r.width - PANEL.GRAB));
    if (r.top <= PANEL.SNAP) return { x: x, anchor: 'top', top: PANEL.EDGE };
    if (vh - r.bottom <= PANEL.SNAP) return { x: x, anchor: 'bottom', bottom: PANEL.EDGE };
    /* 两边都不贴时，锚在**空间大的那一侧**。
       以前一律锚下沿，拖到屏幕中间就等于把可用高度砍成"下沿以上那半截"：
       同一块面板，贴上沿能占 587，拖到中间只剩 326——位置一换高度就变，
       看着像界面自己抽了一下。锚在空间大的那边，高度就不随位置跳。 */
    const topPx = Math.round(r.top / PANEL.GRID) * PANEL.GRID;
    const bottomPx = Math.round((vh - r.bottom) / PANEL.GRID) * PANEL.GRID;
    const room = Math.max(PANEL.GRAB, vh - r.height - PANEL.GRAB);
    if (topPx <= bottomPx) {
      return { x: x, anchor: 'top', top: clampN(topPx, PANEL.GRAB, room) };
    }
    return {
      x: x, anchor: 'bottom',
      bottom: clampN(bottomPx, PANEL.GRAB, room)
    };
  }

  /**
   * 入口按钮的位置 → 面板的默认落位（人还没拖过面板时用它）。
   *
   * 三条规则，按顺序：
   *   1. 横向右边缘与入口右边缘齐平；入口贴着页面右边，「数据」就在「待办」左边，
   *      面板从入口下沿往左铺开——不会越过视口右边。
   *   2. 下方放得下最小面板就往下长（顶部导航的正常情形）。
   *   3. 放不下就向上长（兜底入口在右下角时就是这一条）。
   *
   * @param {{rect:?{left:number,right:number,top:number,bottom:number},
   *          width:number, vw?:number, vh?:number}} o
   * @returns {{x:number, anchor:string, top?:number, bottom?:number}}
   */
  function panelPosFromAnchor(o) {
    const vw = o.vw || viewW();
    const vh = o.vh || viewH();
    const w = Number(o.width) > 0 ? Number(o.width) : 0;
    const r = o.rect;
    let x = Math.max(PANEL.EDGE, vw - w - PANEL.EDGE);
    if (r) x = clampN(Math.round(r.right) - w, PANEL.GRAB, Math.max(PANEL.GRAB, vw - w - PANEL.GRAB));
    if (!r) return { x: Math.round(x), anchor: 'top', top: PANEL.EDGE };

    const below = Math.round(r.bottom) + NAV.GAP;
    if (vh - below - PANEL.PAD >= PANEL.MIN) {
      return { x: Math.round(x), anchor: 'top', top: below };
    }
    return {
      x: Math.round(x), anchor: 'bottom',
      bottom: Math.max(PANEL.GRAB, Math.round(vh - r.top + NAV.GAP))
    };
  }

  HT.geom = {
    NAV: NAV,
    PANEL: PANEL,
    viewW: viewW,
    viewH: viewH,
    clampN: clampN,
    fitBox: fitBox,
    layout: layout,
    snapPanel: snapPanel,
    panelPosFromAnchor: panelPosFromAnchor
  };
})(typeof window !== 'undefined' ? window : globalThis);
