/**
 * src/ui/nav.js —— 顶部导航入口「数据」与挂载入口
 *
 * @layer  ui（表现层）
 * @file   原 src/ui/fab.js（1.7 改名）
 * @since  0.22.0（0.21.0 及以前是 fab.js / entry.js 两个文件）
 *
 * 为什么改名：0.x 到 1.6 这里一直是"右下角那颗悬浮球"（Floating Action Button），
 * 名字、动画、拖拽、靠边收纳全围绕那颗球写。1.7 起它不进屏幕了，而是作为
 * 「数据」和站点的「待办」「信息」并排长在顶部导航里——再叫 fab 就是骗人，
 * 后来的人会照着这个名字去猜一堆不存在的浮动行为。
 *
 * 两条设计约束，缺一不可：
 *
 *   1. **样式必须是站点自己的，不是我们仿的。**
 *      站点那两项靠一堆嵌套 class 与 scoped 指纹（`data-v-xxxx`）才长成那样：
 *      行高、内边距、hover 底色、图标与文字之间那道缝，任何一条都在我们猜不到的地方。
 *      所以这里不"写一个长得像它的按钮"，而是**克隆「待办」那一项**，
 *      再改文字与图标——同一个父容器、同一批 class、同一个 `data-v-` 指纹，
 *      样式天然一致；站点哪天换了主题，它也跟着变，不用我们再跟。
 *
 *   2. **找不到就不硬来，但入口不能没。**
 *      克隆依赖"页面上有「待办」"这条事实。站点改版、账号权限不同、菜单被裁掉，
 *      这条都可能不成立。三级降级：待办 → 信息 → 固定在右下角的文字按钮。
 *      降级不是"丑就完了"：它至少保证入口还在，而不是整个扩展在页面上凭空消失。
 *      用了哪一级写进 obs（NAV-INJECT），装完能在诊断里看到，不用凭猜。
 *
 * 与页面的事件边界：注入的节点是**站点的兄弟节点**，站点的点击很可能挂在父容器
 * 的委托上。所以 pointerdown / pointerup / click 全在捕获阶段拦下来并 stopPropagation
 * ——否则点「数据」会顺手把「待办」的抽屉也打开。键盘 Enter/空格同理。
 *
 * 加载位置：本文件必须排在 UI 层最后，因为末尾那段会立即执行挂载。
 *
 * 组内顺序：nav（定义 mountNav）→ entry（调用它）。
 */
(function (g) {
  'use strict';
  const HT = (g.__HT = g.__HT || {});

  const LABEL = '数据';          // 与「待办」「信息」并排的那两个字
  const NAV_ID = 'ht-nav';
  const MARK = 'data-ht-nav';
  /* 克隆源的优先级，兼"同级还有别的菜单名"的证据词表。待办在左，优先它——
     用户要的位置就是待办左边，克隆它顺带继承了"那一项"的圆角与内边距。
     站点实际是「待办」「消息」（不是"信息"）。词表写错时，
     `navItemOf` 里那条"父容器出现另一个菜单名就收手"的判据会全部落空，
     结果一路爬到整条导航容器上，克隆出「数据 + 消息」两份插在页面左边。 */
  const SOURCE = ['待办', '消息', '信息'];
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const RETRY_MS = 400;          // 导航还没渲染出来时多久试一次
  const RETRY_MAX = 30;          // 试满 30 次（约 12 秒）就上兜底入口
  const OBS_MS = 700;            // 站点重渲染后的重新注入防抖
  const LOGIN_MS = 2500;         // 登录页上多久回来看一眼（与面板的登录轮询同节奏）

  /* 数据图标：三根柱 + 一条基线，16 网格、1.4 描边、currentColor 上色。
     换掉铃铛是因为语义不对；保留"线性单色 + 圆头"这两个特征，才和旁边的
     待办、信息看起来是一套。尺寸用 1em，跟着原图标字号走。 */
  const ICON =
    '<path d="M2.6 13.2h10.8"/>' +
    '<path d="M4.7 13.2V9.3"/>' +
    '<path d="M8 13.2V6.1"/>' +
    '<path d="M11.3 13.2V3.2"/>';

  const norm = s => String(s == null ? '' : s).replace(/\s+/g, '');
  const textOf = el => norm(el && el.textContent);

  function visible(el) {
    if (!el || !el.isConnected) return false;
    try { return el.getClientRects().length > 0; } catch (e) { return false; }
  }

  function depthOf(el) {
    let d = 0;
    for (let p = el; p; p = p.parentElement) d++;
    return d;
  }

  /** 一次 XPath 查询，返回数组。查询写错不该让整个注入挂掉。 */
  function xpath(q) {
    const out = [];
    try {
      const r = document.evaluate(q, document, null, 7 /* ORDERED_NODE_SNAPSHOT_TYPE */, null);
      for (let i = 0; i < r.snapshotLength; i++) out.push(r.snapshotItem(i));
    } catch (e) { }
    return out;
  }

  /** 归一化后的文字是否"就是这个菜单名"：允许后面跟 1~3 位未读数（「待办3」） */
  function isWord(t, word) {
    if (t === word) return true;
    if (t.indexOf(word) !== 0) return false;
    const rest = t.slice(word.length);
    return rest.length > 0 && rest.length <= 3 && /^\d+$/.test(rest);
  }

  /**
   * 找"文字是这个菜单名"的那个元素。
   *
   * 三层，从准到宽，**都要**：
   *
   *   ① `normalize-space(text())` 精确相等 —— 只看元素自己的文本节点，天然取到
   *      最里层那个；外层容器的 text() 混着别的菜单名，不会命中。这一条最快也最准。
   *   ② `starts-with` + 长度上限 —— 站点把未读数写进同一个文本节点时
   *      （「待办3」），① 就废了。
   *   ③ 按 JS 归一化文字 + **形状**遍历 —— 兜住 XPath 认不出的两种排版：
   *      用 `&nbsp;` 撑间距（XPath 的 normalize-space 只认普通空格，U+00A0 会留下），
   *      以及文字被拆成多个文本节点（`待<!-- -->办`）。形状约束不是装饰：
   *      只按文字找会命中正文里的同名标题，所以要求"高 ≤100、宽 ≤320、在页面上半部"。
   *
   * 为什么值得写三层：认不出来的后果不是"少一个口子"，是**降级成一颗白底按钮**
   * 贴在页面角落——位置和样式全不对。这三层里任何一层命中，外观就是站点自己的。
   */
  function findByText(word) {
    const esc = word.replace(/"/g, '');
    const exact = xpath('//*[not(self::script) and not(self::style) and normalize-space(text())="'
      + esc + '"]');
    for (let i = exact.length - 1; i >= 0; i--) {
      if (visible(exact[i])) return exact[i];
    }

    const loose = xpath('//*[not(self::script) and not(self::style) and starts-with(normalize-space(text()), "'
      + esc + '") and string-length(normalize-space(text())) <= ' + (word.length + 3) + ']');
    for (let i = loose.length - 1; i >= 0; i--) {
      if (visible(loose[i])) return loose[i];
    }

    const vh = g.innerHeight || 800;
    const all = document.querySelectorAll('a,button,span,li,div,i,em,p,b,strong,label');
    let best = null;
    let bestD = -1;
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (el.childElementCount > 3 || !isWord(textOf(el), word)) continue;
      let r;
      try { r = el.getBoundingClientRect(); } catch (e) { continue; }
      if (!r.width || !r.height || r.height > 100 || r.width > 320) continue;
      if (r.top < -20 || r.bottom > vh * 0.5) continue;
      const d = depthOf(el);
      if (d > bestD) { bestD = d; best = el; }
    }
    return best;
  }

  /**
   * 从"文字节点"往上找到"导航项"那一层。
   *
   * 判据用两条，任一成立即返回：
   *   · 父容器里出现了**另一个**同级菜单名 —— 那一层就是导航栏，再往上就是把整个
   *     头部包起来的壳，此时手上这个 el 才是"项"；
   *   · 手上已经是 A / BUTTON / LI，且父容器里不止它一个 —— 常见的列表结构。
   * 找不到就返回 null：宁可降级，也不要把整块头部克隆进来。
   */
  /** 两个元素是不是"同一类列表项"：标签一样、class 一样 */
  function sameKind(a, b) {
    if (!a || !b || a.tagName !== b.tagName) return false;
    return String(a.className || '') === String(b.className || '');
  }

  /**
   * 从"文字节点"往上找到"导航项"那一层。
   *
   * 判据三条，任一成立即返回：
   *   · 父容器里出现了**另一个**同级菜单名 —— 那一层就是导航栏，再往上就是把整个
   *     头部包起来的壳，此时手上这个 el 才是"项"；
   *   · 手上已经是 A / BUTTON / LI，且父容器里不止它一个 —— 常见的列表结构；
   *   · 父容器是一排**同类兄弟**（同标签、同 class，至少两个）—— Ant Design 的
   *     `.ant-space > .ant-space-item` 就是这种：菜单名在孙子层，父容器上看不到
   *     第二个菜单名，只能靠"兄弟长得一样"认出"到这里就是一格"。
   *     站点实况正是这一种：div.ant-space-item 里一个 button，两个 item 并列。
   *
   * 找不到就返回 null：宁可降级，也不要把整块头部克隆进来。
   */
  function navItemOf(node, word) {
    let el = node;
    for (let i = 0; i < 10; i++) {
      const p = el.parentElement;
      if (!p || p === document.body || p === document.documentElement) return null;
      const t = textOf(p);
      if (SOURCE.some(w => w !== word && t.indexOf(w) >= 0)) return el;
      if (/^(A|BUTTON|LI)$/.test(el.tagName) && p.childElementCount >= 2) return el;

      /* 一排同类兄弟。上限 8 是为了不把"卡片列表/表格行"当成导航——
         导航项就那么几格，几十行的表格交给下面的形状判据。 */
      if (p.childElementCount >= 2 && p.childElementCount <= 8) {
        const kids = p.children;
        let twin = 0;
        for (let k = 0; k < kids.length; k++) if (sameKind(kids[k], el)) twin++;
        if (twin >= 2) return el;
      }

      /* 爬到第 4 层还没见到同级证据，就按"像个导航项"收手。
         这是给"账号只看到待办、别的都没有"留的出路：那种情况下永远等不到
         第二个菜单名出现，旧逻辑会一路爬到 body 然后降级成白底按钮。
         形状卡得比 oversize 紧（高 ≤64、宽 ≤260、子元素 1~4 个），
         因为这个判断没有同级证据，靠形状兜着。 */
      if (i >= 3) {
        let r;
        try { r = el.getBoundingClientRect(); } catch (e) { r = null; }
        if (r && r.height > 0 && r.height <= 64 && r.width <= 260
          && el.childElementCount >= 1 && el.childElementCount <= 4) return el;
      }
      el = p;
    }
    return null;
  }

  /** 最近一次探测的失败原因，只用于诊断（`诊断日志` 里的 NAV-INJECT） */
  let LAST_MISS = '';

  function pickSource() {
    const miss = [];
    for (let i = 0; i < SOURCE.length; i++) {
      const word = SOURCE[i];
      const hit = findByText(word);
      if (!hit) { miss.push(word + '=文字未命中'); continue; }
      const item = navItemOf(hit, word);
      if (item && item.tagName !== 'BODY') {
        LAST_MISS = miss.join('; ');
        return { word: word, item: item };
      }
      miss.push(word + '=找到文字但没定位到导航项');
    }
    LAST_MISS = miss.join('; ');
    return null;
  }

  /**
   * 现在是不是停在登录页。
   *
   * 登录页不属于"能用扩展的页面"：没有「待办」「信息」，也没有数据可取。
   * 以前这里没有这道判断，登录页的表现是——重试 12 秒、然后降级挂出一颗
   * 固定在右下角的兜底按钮，浮在登录表单上。用户第一眼看到的就是"我还没登录，
   * 你先给我一个按钮"，而那个按钮点什么都没用。
   *
   * 两条判据，任一成立即算：
   *   1. URL 路径或 hash 里有 login —— 站点主入口就是这条，最快也最准
   *      （判据复用 http.js 的 loginInfo，面板的登录态用的是同一份，不会两说）。
   *   2. 页面上有**可见的密码框**，且**找不到站点导航项**。登录页偶尔换路径
   *      （/cas/auth、/portal#/signin）时 URL 认不出来；但只看密码框会把
   *      「修改密码」「账号安全」这类页面误判成登录页，所以"没有导航"是必要条件——
   *      有导航的页面本来就要正常注入，这条顺带把它排除了。
   */
  function isLoginPage() {
    try {
      const li = HT.loginInfo && HT.loginInfo();
      if (li && li.onLoginPage) return true;
    } catch (e) { }

    try {
      const pws = document.querySelectorAll('input[type="password"]');
      let anyPw = false;
      for (let i = 0; i < pws.length && !anyPw; i++) if (visible(pws[i])) anyPw = true;
      if (anyPw && !pickSource()) return true;
    } catch (e) { }
    return false;
  }

  /**
   * 克隆体的尺寸守门。
   *
   * 一个导航项再大也就三四十像素高、一百来像素宽。量出来像个"块"，
   * 说明 `navItemOf` 爬错了层——克隆到的其实是整块头部（导航被隐藏、
   * 或者菜单名出现在卡片标题里时都可能发生）。那种节点插进页面就是一大片，
   * 还可能带着站点的 `position:fixed`，直接糊住屏幕。
   *
   * 两条判据分开设阈值，是因为两种错法形状不同：克隆到整块内容时**很高**
   * （几百像素），克隆到页头时**很宽**（通栏、但只有几十像素高）。
   * 高度阈值给到 120 而不是 64：有些站点的导航项靠 `height:100%` 撑满页头，
   * 页头本身 64~80px 是正常的，卡 64 会把好节点一起杀掉。
   */
  function oversized(node) {
    let r;
    try { r = node.getBoundingClientRect(); } catch (e) { return false; }
    if (!r || !r.width) return false;          // 量不到就不判，宁可放过
    const vw = g.innerWidth || document.documentElement.clientWidth || 1280;
    return r.height > 120 || r.width > vw * 0.55;
  }

  /** 克隆体里"只是图标"的那个元素：没有文字、不是包着一坨内容的容器 */
  function findIcon(el) {
    const kids = el.querySelectorAll('svg, i, em, img');
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i];
      if (textOf(k) || !visible(k)) continue;
      if (k.tagName !== 'svg' && k.querySelector('svg')) continue;   // 取里面那个 svg
      return k;
    }
    return null;
  }

  /**
   * 从原图标里抠出它真正的"墨水"：颜色与整体不透明度。
   *
   * 站点图标是一张图片（`img.top-icon`），它**不受 `color` 影响**。换成我们的
   * svg 之后若直接用 currentColor，就会比旁边那一格亮一档或暗一档——
   * 截图里"数据比待办白"就是这么来的。图是同源图片，画到 canvas 上取平均色即可。
   *
   * 取不到（跨域污染、还没加载完、尺寸异常）返回 null，调用方退回 currentColor：
   * 猜一个颜色比沿用继承色更糟，那等于把"看起来一样"交给运气。
   */
  function inkOf(old) {
    if (!old || old.tagName !== 'IMG') return null;
    try {
      if (!old.complete || !old.naturalWidth) return null;
      const w = old.naturalWidth, h = old.naturalHeight;
      if (w < 2 || h < 2 || w > 256 || h > 256) return null;
      const cv = document.createElement('canvas');
      cv.width = w;
      cv.height = h;
      const cx = cv.getContext('2d');
      if (!cx) return null;
      cx.drawImage(old, 0, 0);
      const d = cx.getImageData(0, 0, w, h).data;
      let r = 0, gg = 0, b = 0, a = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 8) continue;          // 全透明像素不算，否则均值被空背景拉灰
        r += d[i]; gg += d[i + 1]; b += d[i + 2]; a += d[i + 3]; n++;
      }
      if (!n) return null;
      return {
        color: 'rgb(' + Math.round(r / n) + ',' + Math.round(gg / n) + ',' + Math.round(b / n) + ')',
        alpha: Math.round(a / n) / 255
      };
    } catch (e) { return null; }              // 跨域图片会让 canvas 变成污染状态
  }

  /**
   * 造我们的图标，**占住原图标的位置与盒模型**。
   * 直接 replaceWith 会把原 <i> 的 margin 一起丢掉，旁边的文字就会挪位；
   * 所以把内外边距、字号从原节点上抄过来，只换图形本身。
   */
  function makeIcon(old) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.4');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.innerHTML = ICON;
    svg.style.width = '1em';
    svg.style.height = '1em';
    svg.style.flex = 'none';
    try {
      const cs = g.getComputedStyle(old);
      svg.style.margin = cs.margin;
      svg.style.verticalAlign = cs.verticalAlign;
      /* 字号跟着原图标走（1em 就是它）。图标库把字号设成 0 的（靠 ::before 撑），
         抄过来会让我们的 svg 变成 0×0，这时退回 16px。 */
      const fs = parseFloat(cs.fontSize);
      svg.style.fontSize = fs > 4 ? cs.fontSize : '16px';
      /* 原图标是"色块"画出来的时候（`<i>` + background，比 iconfont 更常见），
         currentColor 会让我们的描边比旁边那块实心灰深一档，一眼能看出不是一套。
         取它的底色当描边色，两个图标才是同一个灰度。透明背景（iconfont、svg）
         不动——那时 currentColor 正是对的。 */
      const bg = cs.backgroundColor;
      if (bg && !/^(transparent|none)$/.test(bg) && !/rgba\(0,\s*0,\s*0,\s*0\)/.test(bg)) {
        svg.style.stroke = bg;
      }
      /* 有些导航项给图标写死 width/height（16×16 那种）。1em 在那种位置会偏小，
         量出来是正方就照抄——判据用"宽高相等且落在合理区间"，避免抄到 auto 或 100%。 */
      const w = parseFloat(cs.width);
      const h = parseFloat(cs.height);
      if (w > 4 && w <= 48 && Math.abs(w - h) < 1.5) {
        svg.style.width = w + 'px';
        svg.style.height = w + 'px';
      }
      /* 原图标的实际颜色与透明度（图片自带的，靠 CSS 问不出来）。
         最后赋，前面那几条只能算兜底。 */
      const ink = inkOf(old);
      if (ink) {
        svg.style.stroke = ink.color;
        if (ink.alpha < 0.97) {
          svg.style.opacity = String(Math.max(0.3, Math.min(1, ink.alpha)));
        }
      }
    } catch (e) {
      svg.style.fontSize = '16px';
    }
    return svg;
  }

  /**
   * 把「数据 → 待办」的空隙，调成「待办 → 消息」的那个空隙。
   *
   * 站点的间距不是克隆一次就自动对上的：它按 `.ant-space-item:not(:last-child)`、
   * `> :first-child` 这类**序号规则**给外边距，我们插到最前面就把这套序号顶歪了。
   * 表现就是"数据离待办比待办离消息更近"——比图标差半档还显眼，
   * 因为它让这一格看起来是被塞进去的。
   *
   * 与其猜它用的是哪条规则（每个站点、每次改版都不一样），不如**量出来再补差额**。
   * @returns {number} 补了多少像素（0 = 本来就齐）
   */
  function alignGap(el, src) {
    const next = src && src.nextElementSibling;
    if (!next) return 0;
    try {
      const a = el.getBoundingClientRect();
      const b = src.getBoundingClientRect();
      const c = next.getBoundingClientRect();
      if (!a.width || !b.width || !c.width || c.left <= b.right) return 0;
      const got = b.left - a.right;      // 数据 → 待办
      const want = c.left - b.right;     // 待办 → 消息
      const diff = Math.round(want - got);
      if (Math.abs(diff) < 1) return 0;
      const cur = parseFloat(g.getComputedStyle(el).marginRight) || 0;
      el.style.marginRight = Math.max(0, cur + diff) + 'px';
      return diff;
    } catch (e) { return 0; }
  }

  /**
   * 由导航项克隆出我们的入口。
   * @returns {?HTMLElement} 克隆失败（文字没能替换掉）时返回 null，交给下一级降级
   */
  function buildFrom(src, word) {
    const el = src.cloneNode(true);

    /* id 一定要清：同一份 DOM 里出现两个同名 id 时，站点的 #id 规则与
       getElementById 会拿到错的那个——表现是"点数据，待办的高亮闪了一下"。 */
    el.removeAttribute('id');
    const withId = el.querySelectorAll('[id]');
    for (let i = 0; i < withId.length; i++) withId[i].removeAttribute('id');

    /* 未读角标：Ant Design 的 `.ant-badge-count`（一个 `<sup>`）就是它。
       **不能按「class 里含 badge」一刀切删**——`.ant-badge` 是**图标容器**，
       一起删掉的话克隆出来的入口连图标都没有，只剩两个字。
       站点实况：<span class="ant-badge"><img class="top-icon"><sup class="ant-badge-count">0</sup></span> */
    const badges = el.querySelectorAll(
      'sup, [class*="badge-count"], [class*="badge-dot"], [class*="badge-status"]');
    for (let i = 0; i < badges.length; i++) badges[i].remove();

    /* 悬停/点击才展开的浮层：克隆过来是一坨隐藏 DOM，没有任何用处，
       但它里面的 id 与 aria 关联会和新入口缠在一起 */
    const flyouts = el.querySelectorAll(
      '[class*="popover"], [class*="dropdown"], [class*="popper"], [class*="drawer"], [class*="layer"]');
    for (let i = 0; i < flyouts.length; i++) flyouts[i].remove();

    /* 改文字。**不能按"原文替换"**，站点这三种排版都很常见：
         · `<span>待办</span>`         —— 一个文本节点正好是这两个字
         · `<span>待&nbsp;办</span>`   —— 中间是 U+00A0，归一化后相等，
                                        但 `nodeValue.replace('待办', …)` 找不到原文
         · `待<!-- -->办`              —— Vue 注释把词拆成两个文本节点，每个都不完整
       按原文 replace 时后两种都改不动，`changed` 保持 false，整个克隆被判失败，
       于是退到兜底——页面角落多出一颗白底按钮，位置和样式全不对。
       所以改成"按归一化匹配"：命中就把该节点整段写成新词，同属一个词的多余节点清空。 */
    const texts = [];
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    while (walk.nextNode()) texts.push(walk.currentNode);

    let changed = false;
    for (let i = 0; i < texts.length && !changed; i++) {
      if (norm(texts[i].nodeValue) === word) {
        texts[i].nodeValue = LABEL;
        changed = true;
      }
    }
    if (!changed) {
      /* 跨节点：连续几个文本节点拼起来正好是这个词（最多看 4 段，够 Vue 那种拆法） */
      for (let i = 0; i < texts.length && !changed; i++) {
        let acc = '';
        for (let j = i; j < texts.length && j < i + 4; j++) {
          acc += norm(texts[j].nodeValue);
          if (acc === word) {
            texts[i].nodeValue = LABEL;
            for (let k = i + 1; k <= j; k++) texts[k].nodeValue = '';
            changed = true;
            break;
          }
          if (acc.length >= word.length) break;
        }
      }
    }
    if (!changed) return null;

    el.id = NAV_ID;
    el.setAttribute(MARK, '1');
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.setAttribute('aria-haspopup', 'dialog');
    el.setAttribute('aria-expanded', 'false');
    el.setAttribute('aria-label', LABEL + ' · 打开简报助手');
    el.removeAttribute('target');
    el.removeAttribute('title');
    /* 原节点是 <a> 的话不能让它跳走。href 留着（删掉会让页面上 a[href] 那类
       选择器失效、颜色变淡），只把目标改成 #，点击我们自己拦。 */
    if (el.tagName === 'A') el.setAttribute('href', '#');
    el.style.cursor = 'pointer';
    return el;
  }

  /**
   * 换图标。**必须在节点插进文档之后调**——两步是分开的，原因只有一条：
   * `getComputedStyle` 与 `getClientRects` 对游离节点算不出真实值。
   * 克隆完立刻换图标的话，抄到的 margin 是空串、字号是 NaN，
   * 图标就会变成 16px 的一个"默认大小"，和旁边那两格对不齐。
   */
  function decorate(el) {
    const icon = findIcon(el);
    if (icon) icon.replaceWith(makeIcon(icon));
  }

  /** 三级降级里的最后一级：页面结构不认识了，至少留一个能点的东西 */
  function buildFallback() {
    const el = document.createElement('button');
    el.type = 'button';
    el.id = NAV_ID;
    el.setAttribute(MARK, 'fallback');
    el.setAttribute('aria-haspopup', 'dialog');
    el.setAttribute('aria-expanded', 'false');
    el.setAttribute('aria-label', LABEL + ' · 打开简报助手');

    /* 兜底按钮活在 light DOM 里，吃的是**站点的**样式表。
       后台类站点的全局规则（`button{width:100%}`、`button{height:auto}`、
       `*{box-sizing:border-box}`）足以把一颗胶囊撑成横贯整条底边的白条——
       用户看到的就是"页面上突然多出一大块，占住了"。
       所以先把继承与默认值全推平（all:initial），再把**决定大小与位置**的
       那几条用 !important 钉死：这是扩展自己画的东西，
       它的尺寸不该由别人的样式表决定。
       位置仍放右下角而不是右上角：右上角是站点的账号区，fixed 一定会压住它。 */
    el.style.setProperty('all', 'initial');
    const FIX = {
      position: 'fixed', right: '18px', bottom: '80px', top: 'auto', left: 'auto',
      'z-index': '2147483000',
      display: 'inline-flex', 'align-items': 'center', gap: '6px',
      width: 'auto', height: '32px', 'min-width': '0',
      'max-width': 'none', 'max-height': 'none',
      margin: '0', padding: '0 14px', 'box-sizing': 'border-box',
      border: '1px solid rgba(0,0,0,.12)', 'border-radius': '16px',
      background: '#fff', color: '#1f2329',
      font: '14px/1 system-ui,sans-serif', 'text-align': 'left', 'white-space': 'nowrap',
      cursor: 'pointer', 'box-shadow': '0 2px 8px rgba(0,0,0,.12)'
    };
    for (const k in FIX) el.style.setProperty(k, FIX[k], 'important');

    const ic = makeIcon(document.createElement('i'));
    /* makeIcon 写的是行内 1em/16px，站点一条 `svg{width:100%!important}` 就能顶掉，
       顶掉之后那颗图标会按容器宽高摊开——这就是"图标变得很大"的来路之一 */
    ic.style.setProperty('width', '16px', 'important');
    ic.style.setProperty('height', '16px', 'important');
    ic.style.setProperty('flex', 'none', 'important');
    el.appendChild(ic);
    el.appendChild(document.createTextNode(LABEL));
    return el;
  }

  /**
   * 挂载顶部入口。
   * @returns {{el:?HTMLElement, onClick:Function|null, setState:Function, setTip:Function,
   *            setActive:Function, setExpanded:Function, nudge:Function,
   *            rect:Function, isFallback:Function, retry:Function}}
   */
  HT.mountNav = function () {
    /* 先拿一个**没有插进页面**的兜底节点占位。
       为什么不让 el 初始为 null：面板在同一帧里就要拿它做
       `HT.inPath(e, nav.el)`、`nav.el.focus()`、`nav.el.setAttribute(...)`，
       而入口的注入是异步的（导航可能还没渲染完，要重试十几秒）。
       el 为 null 的那段时间里，任何一次点击外面都要先判断一次 null——
       与其散着判断，不如让"没有入口"这件事退化成一个不在文档里的按钮。 */
    let el = buildFallback();
    let kind = '';            // '待办' / '信息' / 'fallback' / 'login'
    let tries = 0;
    let timer = null;
    let obsTimer = null;
    let loginTimer = null;    // 登录页上的"回来看一眼"
    let busy = false;         // 防重入：定时重试与 MutationObserver 可能同时叫醒 ensure
    let state = 'checking';
    let tipOverride = '';

    const api = {
      el: el,
      onClick: null,
      setState,
      setTip,
      setActive,
      setExpanded,
      nudge,
      rect,
      isFallback: () => kind === 'fallback',
      retry: () => ensure(true)
    };

    /* 入口的读屏名是固定的「数据 · 打开文稿助手」，不随取数状态变。
       它是导航项，不是状态灯——把"未到截点""取数中"念进导航栏，
       读屏用户每按一次 Tab 就被灌一句与本页无关的话。状态在面板标题栏里说。 */
    function refreshTip() {
      if (!el) return;
      el.setAttribute('aria-label', LABEL + ' · ' + (tipOverride || '打开简报助手'));
    }

    /* 入口不显示取数状态：它是导航项，和「待办」「信息」长一样是唯一要求。
       状态值仍然记在元素上，诊断与预览要靠它判断现在挂的是哪一态。 */
    function setState(s) {
      state = (HT.UI_STATE && HT.UI_STATE[s]) ? s : 'checking';
      if (el) el.setAttribute('data-ht-state', state);
      refreshTip();
    }

    function setTip(t) {
      tipOverride = t || '';
      refreshTip();
    }

    /** 面板开着时给入口一个"选中"标记。不隐藏它——藏在导航栏里会让「信息」
        整个左移一格，看起来像导航抖了一下。 */
    function setActive(on) {
      if (!el) return;
      el.setAttribute('aria-expanded', on ? 'true' : 'false');
      if (on) el.setAttribute('data-ht-on', '1');
      else el.removeAttribute('data-ht-on');
    }

    function setExpanded(on) {
      if (el) el.setAttribute('aria-expanded', on ? 'true' : 'false');
    }

    /** 未登录被点：一次 320ms 的左右轻晃，说明"点了，但还不可以用" */
    function nudge() {
      if (!el || !el.animate || (HT.prefersReduced && HT.prefersReduced())) return;
      try {
        el.animate([
          { transform: 'translateX(0)' },
          { transform: 'translateX(-3px)' },
          { transform: 'translateX(3px)' },
          { transform: 'translateX(0)' }
        ], { duration: 320, easing: 'ease-out' });
      } catch (e) { }
    }

    /** 入口在视口里的矩形。面板默认落在它正下方——这是"跟着入口走"的唯一真相 */
    function rect() {
      try { return (el && el.isConnected) ? el.getBoundingClientRect() : null; } catch (e) { return null; }
    }

    function wire(node) {
      /* 捕获阶段全拦：站点的点击多半挂在上层容器的委托上，不拦就会顺带触发待办 */
      ['pointerdown', 'pointerup', 'mousedown', 'mouseup'].forEach(t => {
        node.addEventListener(t, e => e.stopPropagation(), true);
      });
      node.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        if (api.onClick) api.onClick();
      }, true);
      node.addEventListener('keydown', e => {
        if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
        e.preventDefault();
        e.stopPropagation();
        if (api.onClick) api.onClick();
      }, true);
      node.addEventListener('auxclick', e => e.stopPropagation(), true);
    }

    function note(fact) {
      try {
        HT.obs.note({ code: 'NAV-INJECT', mod: 'nav', fact: fact });
      } catch (e) { }
    }

    /**
     * 登录页上的状态：**一个节点都不挂**，只留一个"过一会儿回来看一眼"的定时器。
     *
     * 为什么不是"降级"：降级的前提是"这个页面本来该有入口，只是没认出来"。
     * 登录页不是——它没有待办也没有数据，挂上去的入口每个动作都走不通，
     * 而兜底那颗是 fixed 的，会正正浮在登录表单旁边。
     * 登录完成之后 URL 会变、导航会出现，那时 ensure(true) 自己就把它装上了，
     * 不需要用户刷新（这和面板的登录轮询是同一个承诺）。
     */
    function park() {
      const first = kind !== 'login';
      kind = 'login';
      clearTimeout(timer);
      timer = null;
      if (el && el.parentNode) { try { el.parentNode.removeChild(el); } catch (e) { } }
      /* el 不清空：面板在同一帧里可能正拿着它做 focus / setAttribute。
         让它继续是那个"不在文档里、点不到的按钮"最省事，rect() 会返回 null。 */
      el.setAttribute('aria-expanded', 'false');
      el.removeAttribute('data-ht-on');
      if (first) note('login-skip');
      clearTimeout(loginTimer);
      loginTimer = setTimeout(() => ensure(true), LOGIN_MS);
    }

    /**
     * 注入 / 重新注入。
     * @param {boolean} [force] 强制重建（站点把节点留在原地但改了内容时要走这条）
     */
    function ensure(force) {
      clearTimeout(timer);
      timer = null;
      if (busy) return false;
      if (el && el.isConnected && !force) return true;
      busy = true;
      try {
        clearTimeout(loginTimer);
        loginTimer = null;

        /* 登录页先判，连那 12 秒重试都不做：重试是为了等 Vue 把导航渲染出来，
           登录页再怎么等也不会有导航 */
        if (isLoginPage()) { park(); return false; }

        const hit = pickSource();
        let node = null;
        let big = false;
        if (hit) {
          node = buildFrom(hit.item, hit.word);
          if (node && hit.item.parentElement) {
            hit.item.parentElement.insertBefore(node, hit.item);
            decorate(node);         // 插进文档之后才换图标，见函数注释
            /* 图标换完再对间距：两者都要 getComputedStyle，都得在文档里 */
            const gd = alignGap(node, hit.item);
            if (gd) note('gap=' + gd);
            if (oversized(node)) {
              /* 爬错层：克隆到的不是"一个导航项"，而是整块头部/卡片。
                 撤掉重来——宁可退回兜底胶囊，也不要让一大块东西糊在页面上。 */
              try { node.remove(); } catch (e) { }
              node = null;
              big = true;
              note('clone=too-big');
            } else {
              kind = hit.word;
            }
          } else {
            node = null;
          }
        }
        if (!node && !force) {
          /* 尺寸守门没过就别重试了：同样的 DOM 再量一次还是那么大，
             而每 400ms 克隆一整块头部的代价不低 */
          if (big) tries = RETRY_MAX;
          /* 页面还没渲染出导航（Vue 是异步挂载的）。先等，别急着兜底——
             兜底一旦挂上就是 fixed 的按钮，等真导航出现了还得撤，人会看到闪一下。 */
          if (tries < RETRY_MAX) {
            tries++;
            timer = setTimeout(() => ensure(false), RETRY_MS);
            return false;
          }
          node = buildFallback();
          /* 挂到 <html> 而不是 <body>：body 上常见一条 transform
             （为了开合成层随手写的 `translateZ(0)`）会把 fixed 的定位基准
             从视口换成 body 的包含块，此时 `right:18px` 不再按视口算——
             表现就是“兜底按钮跑到页面左下角去了”。 */
          (document.documentElement || document.body).appendChild(node);
          kind = 'fallback';
        }
        if (!node) return false;

        const prev = el;
        el = node;
        api.el = el;
        if (prev && prev !== el) { try { prev.remove(); } catch (e) { } }
        wire(el);
        el.setAttribute('data-ht-state', state);
        refreshTip();
        note(kind === 'fallback' ? ('fallback：' + (LAST_MISS || '未找到导航项')) : ('clone=' + kind));
        return true;
      } finally {
        busy = false;
      }
    }

    /* 站点重渲染（换路由、头部整块重建）会把我们插的节点带走。
       只在"找不到自己了"时才重建，绝大多数回调进来第一行就返回了。 */
    function watch() {
      try {
        const mo = new MutationObserver(() => {
          if (el && el.isConnected) return;
          clearTimeout(obsTimer);
          obsTimer = setTimeout(() => ensure(false), OBS_MS);
        });
        mo.observe(document.documentElement, { childList: true, subtree: true });
      } catch (e) { }
    }

    ensure(false);
    watch();

    return api;
  };
})(typeof window !== 'undefined' ? window : globalThis);

/**
 * entry —— 入口：挂载宿主、注入样式、装配顶部入口与面板
 *
 * @layer  ui（表现层）
 * @file   原 src/ui/entry.js（0.22.0 并入 fab.js，1.7 随 fab.js 一起改名 nav.js）
 * @since  5.0.0
 *
 * 装配顺序不能改：先挂宿主与样式 → 顶部入口 → 面板（面板要拿入口句柄）→ 消息通道。
 * 样式没到位时宿主保持 visibility:hidden，避免"裸 DOM 闪一下"。
 *
 * 为什么要 Shadow DOM：目标站点的全局样式（button{} / *{} / .el-xxx）会污染面板，
 * 之前出现过按钮变方、字号被改小、行高错乱。挂进 ShadowRoot 后宿主 CSS 完全碰不到。
 * **入口是唯一例外**：它是页面顶部导航里的一项，必须吃站点的样式才叫"一样"，
 * 所以它活在 light DOM，不进 shadow（见本文件顶部第 1 条约束）。
 *
 * 宿主节点：position:fixed; inset:0; pointer-events:none; z-index 最高。
 *   · 不改变页面布局 → 不会把官网的表格挤歪
 *   · 不拦点击 → 空白处照常点官网
 *   · 子元素必须显式 pointer-events:auto（pointer-events 会继承，漏了就整块点不到）
 *
 * 样式注入优先级：页面内联副本（离线预览）→ fetch 扩展资源 + constructed stylesheet
 *   → <link> → 900ms 兜底显示。用 constructed stylesheet 是为了绕开宿主页 CSP 的
 *   style-src 限制，同时没有 FOUC。
 */
(function (g) {
  'use strict';
  const HT = g.__HT;
  if (!HT) {
    console.warn('[简报助手] 核心脚本未加载，UI 跳过挂载');
    return;
  }
  if (g.__HT_UI__) return;
  g.__HT_UI__ = true;

  /**
   * 依赖自检。
   *
   * content script 没有模块系统，二十来个文件靠 manifest.json 的数组顺序串联，
   * 用 window.__HT 共享。顺序一旦写错（把 report.js 挪到 fields.js 前面之类），
   * 后面的文件读到 undefined，表现是某个功能莫名其妙不工作，而且不报错。
   * 所以在挂载前先点一遍名：缺哪个、去改哪个文件。
   */
  const depsOk = (function checkDeps() {
    const NEED = [
      'num', 'numOrNull', 'fmtTime', 'buildWindows', 'normalizeCfg', 'fetchReport', 'fetchDetail',
      'detailTruncText', 'DETAIL_MAX_PAGES', 'requestCount',
      'RELEASE', 'API', 'REPORT_COLS', 'FIRE_TYPES',
      'err', 'errInfo', 'errHTML', 'errFact', 'ERR_CARD',
      'assertReport', 'assertDetail', 'FIELD_GROUPS', 'FIELD_INDEX', 'AUTO', 'buildSegments',
      'attachPhrases', 'yoyWord', 'yoyDirWord', 'dirOf', 'yoyPlain',
      'parse', 'render', 'prune', 'chipLabel', 'buildChecks', 'run',
      'SETTINGS',
      'mountEditor',
      'mountSections',
      'mountFaq',
      'mountChecks',
      'geom',
      'mountNav', 'mountPanel', 'siteHider',
      'obs', 'diagText', 'copyText', 'flashBtn', 'obsRows', 'diagSend'
    ];
    const miss = NEED.filter(k => !HT[k]);
    if (!miss.length) return true;

    const text = `简报助手加载不全，缺少 ${miss.length} 个模块接口：${miss.join('、')}。`
      + '多半是 manifest.json 的 content_scripts.js 顺序与 debug/files.js 不一致。';
    console.error('[简报助手] ' + text);

    /* 面板这时候挂不出来，所以这条提示不能靠 Shadow DOM 的样式。
       硬编码颜色是有意的：这是"扩展自己坏了"的兜底，不能再去依赖 extension 自己的令牌。 */
    try {
      const box = document.createElement('div');
      box.textContent = text;
      box.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:2147483647;'
        + 'max-width:420px;padding:10px 14px;border-radius:8px;background:#7f1d1d;color:#fff;'
        + 'font:13px/1.5 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.3)';
      document.body.appendChild(box);
    } catch (e) { }
    return false;
  })();

  /* 依赖不全就到此为止：**不装监听、不挂 UI**。
     以前这里只画一个红框就继续往下走，结果是半个面板在页面上跑——
     缺 mountChecks 就点不开校验，缺 run 就点生成没反应，而抛出来的错
     还会被 obs 当成业务错误上报，掩掉真正的原因。
     宁可什么都不挂，让人一眼看到那句"加载不全"，也不要挂一个坏掉的面板。 */
  if (!depsOk) return;
  if (['mountNav', 'mountPanel', 'siteHider'].some(k => !HT[k])) return;

  /* 观测监听先装，再挂 UI。
     顺序有讲究：挂 UI 的过程本身就可能抛错（样式、宿主、面板装配），
     晚装一步，恰恰漏掉最想抓的那一类"扩展自己崩了"。
     Shadow DOM 不用单独装——它不是一个独立的 JS 上下文，同一个 realm，
     window 上的 error 事件照样能收到。 */
  try { if (HT.obs && HT.obs.install) HT.obs.install('content'); } catch (e) { }

  const host = document.createElement('div');
  host.id = 'ht-root';
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;visibility:hidden';
  const shadow = host.attachShadow({ mode: 'open' });

  /* 入口句柄。样式加载是异步的，失败时需要用它把原因写到入口的提示里，
     而入口要到下面才挂 —— 所以留一个可写的引用，不用提前读 nav。 */
  let navApi = null;

  (function loadStyles() {
    let shown = false;
    /* 字体和样式一起等。字体比样式晚到的话，面板已经露着，换字体那一下字宽
       变化会让整段文字挪一次。最多等 400ms：拿不到就按系统字体露出来，
       反正在 --ht-font 后面接着一串退路，不能为了观感把面板扣住。 */
    const fontReady = (() => {
      try { return HT.loadFont(); } catch (e) { return Promise.resolve(false); }
    })();
    const show = () => {
      if (shown) return;
      shown = true;
      const reveal = () => {
        host.style.visibility = '';
        host.classList.add('ht-ready');
      };
      Promise.race([fontReady, new Promise(r => setTimeout(r, 400))]).then(reveal);
    };
    const adopt = css => {
      try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        shadow.adoptedStyleSheets = [sheet];
      } catch (e) {
        const st = document.createElement('style');
        st.textContent = css;
        shadow.appendChild(st);
      }
    };
    const viaLink = href => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      link.addEventListener('load', show);
      link.addEventListener('error', () => {
        /* 样式彻底拿不到：**不要露出裸 DOM**（见下面那段注释），
           记一条诊断，把原因写到入口的提示里，页面保持干净 */
        try { HT.obs.note({ code: 'CSS-FAIL', mod: 'nav', fact: 'panel.css 未能加载' }); } catch (e) { }
        try { if (navApi) navApi.setTip('面板样式没加载成功，重新加载扩展试试'); } catch (e) { }
      });
      shadow.appendChild(link);
    };

    const inline = document.getElementById('ht-css-inline');
    if (inline && inline.textContent) { adopt(inline.textContent); show(); return; }

    const href = g.__HT_CSS_HREF || (() => {
      try { return g.chrome.runtime.getURL('panel.css'); } catch (e) { return ''; }
    })();
    if (!href) { show(); return; }

    /* 这里以前是「900ms 一到就 show」——样式没到也把宿主露出来。
       后果是**裸 DOM 铺在页面上**：面板里所有图标都是 `<svg viewBox="0 0 24 24">`，
       尺寸全靠 CSS 的 `.ht-ico svg` 给，没有 CSS 时 SVG 会按默认尺寸摊开
       （宽 100%/300px 级别），一屏文字外加几个巨大图标，看着就像"扩展占住了整页"。
       冷启动的页面（登录页最典型：新开标签、样式表还没进缓存）恰好卡在这 900ms 上。
       改成：样式没到就补一条 <link>，load 了才显；彻底失败就保持隐藏并记诊断。
       入口在 light DOM 里，不受这条影响，扩展不会因此"什么都不做"。 */
    setTimeout(() => { if (!shown) viaLink(href); }, HT.UI_MS.cssWait);
    try {
      fetch(href)
        .then(r => (r.ok ? r.text() : Promise.reject(new Error('css ' + r.status))))
        .then(css => { adopt(css); show(); })
        .catch(() => viaLink(href));
    } catch (e) {
      viaLink(href);
    }
  })();

  document.body.appendChild(host);

  /* SPA 兜底：站点换路由时若整块替换了 body，宿主节点会跟着消失，
     而 content script 不会重跑——面板就再也不回来了，且没有任何报错。
     只在"路由变了 / 页面回到前台"这两种时刻查一次 isConnected，不做轮询：
     站点是 Vue 路由，popstate/hashchange 一定会有一次。 */
  const reattach = () => {
    try {
      if (host.isConnected) return;
      (document.body || document.documentElement).appendChild(host);
    } catch (e) { }
  };
  g.addEventListener('popstate', reattach);
  g.addEventListener('hashchange', reattach);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) reattach(); });

  const nav = HT.mountNav();
  navApi = nav;
  /* 面板装配失败不该让整个扩展变砖：入口已经挂上了，obs 也装好了，
     至少还能上报一条 UI-MOUNT，并把"打不开"写在入口的提示里。
     以前这里是裸调用——标记里漏一个 id，抛出的错误会连带丢掉入口与后续接线，
     而人看到的现象只是"图标在、点了没反应"，什么线索都没有。 */
  let panel = null;
  try {
    panel = HT.mountPanel(shadow, nav);
  } catch (e) {
    try {
      HT.obs.note({
        code: 'UI-MOUNT', mod: 'nav',
        fact: String((e && e.message) || e).slice(0, 120)
      });
    } catch (e2) { }
    try {
      nav.el.setAttribute('aria-disabled', 'true');
      nav.setTip('面板没有装配成功，请重新加载扩展');
    } catch (e3) { }
  }

  /* 设置页「在页面上点选」→ 这里进入点选模式，把选择器回传。
     必须是异步响应，所以返回 true 让消息通道保持打开。 */
  try {
    g.chrome.runtime.onMessage.addListener((msg, sender, respond) => {
      if (!msg || msg.type !== 'pickSiteFab') return;
      HT.siteHider.pick().then(sel => {
        /* 点完就把浮标藏掉，用户立刻能看到效果 */
        if (sel) HT.siteHider.setCfg({ hideSiteFab: true, siteFabSelectors: sel });
        respond({ ok: !!sel, selector: sel || '' });
      });
      return true;
    });
  } catch (e) { }

  /* 预览生成器（预览生成器）要拿宿主与面板做截图与状态注入。
     挂在 HT 上而不是 window 上：HT 是本项目约定的模块命名空间，
     再多一个 window.__HT_UI 只是让"有哪些全局"这件事没法一次说清。

     **必须合并，不能整份替换**：panel.js 已经把 `api`（open / debugBusy /
     debugPin / debugFaq）挂在 HT.__debug 上了，而 nav.js 是最后加载的一个，
     直接赋值会把那一半抹掉——预览页 ?gen=1 会当场报 "reading 'open'"，
     而正常使用看不出来（面板照开，因为 open 走的是入口的点击）。 */
  HT.__debug = Object.assign(HT.__debug || {}, {
    host, shadow, nav, panel, hider: HT.siteHider
  });
})(window);
