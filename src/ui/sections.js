/**
 * src/ui/sections.js —— 结果区的段落列表、专注态与折叠
 *
 * @file      src/ui/sections.js
 * @version   1.6.16
 * @build     2026-11-13
 * @license   MIT
 *
 * 从 panel.js 摘出来的那一段（1,674 → 见 CHANGELOG）。摘的标准不是行数，
 * 而是"谁管这一块"：面板管**壳**（挂载、开合、标题栏、状态、进度、用户下拉），
 * 段落区管**稿子**（怎么排、怎么折、怎么专注、字多大）。
 *
 * 以前这两件事混在一起，于是 panel.js 里每个函数都得读 1,600 行才能确定
 * 自己碰的是壳还是稿子；而"重绘会换掉所有 textarea，专注手里攥着的那个就失效"
 * 这类约束，写在 enterFocus 里，看不到它的人照样会踩。
 *
 * 边界的实质变化与 editor.js 同一条路：状态归模块自己。
 * 这里持有的是 focusItem（当前专注于哪一段），外面只经
 * render / enterFocus / exitFocus / applyFont / isFocus 进出，
 * 不再有人能直接摸到那根指针。
 *
 * 依赖全部显式传入（见 HT.mountSections 的参数表），不回头读 panel.js 的闭包：
 * chrome 扩展没有模块系统，跨文件回指就是新的隐式耦合。
 *
 * 依赖：src/ui/feedback.js（HT.flashBtn）、src/lib/util.js 的 HT.el，不碰存储。
 */
(function (g) {
  'use strict';
  const HT = (g.__HT = g.__HT || {});

  /** 普通态文本框的高度上限：超过就内部滚动，免得一段正文把面板顶穿 */
  const TA_MAX = 208;

  /**
   * @param {object}   d
   * @param {Element}  d.box        结果容器 #ht-out
   * @param {Element}  d.panel      #ht-panel（专注字号写成它身上的 CSS 变量）
   * @param {Element}  d.body       .ht-body（重绘与进专注后回到顶部）
   * @param {object}   d.icon       panel.js 的 ICON 表（copy/minus/plus/focusIn/focusOut/foldOpen/foldClose）
   * @param {Function} d.fontOf     () => number 当前字号（cfg.focusFont，默认 15）
   * @param {Function} d.saveFont   (n) => void  记住字号；写失败不该打扰人
   * @param {object}   d.throttled  HT.createThrottle() 实例（防连点）
   * @param {Function} d.onEdit     () => void   正文被人改过（导出时要在文件末尾注明）
   * @param {Function} d.refreshGates () => void 正文变了，外部状态跟着变（字数、按钮可用）
   * @param {Function} d.fitBox     () => void   面板高度重算（字变行变，外框得跟着）
   * @param {Function} d.suppressed () => bool   刚拖过面板的那一下不算"点标题"
   * @returns {{render:Function, enterFocus:Function, exitFocus:Function,
   *            applyFont:Function, isFocus:Function, TA_MAX:number}}
   */
  HT.mountSections = function (d) {
    const box = d.box;
    const panel = d.panel;
    const body = d.body;
    const ICON = d.icon;
    const fontOf = d.fontOf;
    const saveFont = d.saveFont;
    const throttled = d.throttled;
    const onEdit = d.onEdit;
    const refreshGates = d.refreshGates;
    const fitPanelBox = d.fitBox;
    const suppressed = d.suppressed;

    /* 同一时刻只允许一段专注。这根指针是**本模块的状态**：以前它在 panel.js 的
       闭包里，谁都能读能写，于是"重绘前要先退出专注"这条约束散在六个地方。 */
    let focusItem = null;

    /* ── 专注（Focus）────────────────────────────────────────
       行业里这一招叫 Focus Mode；落到这个面板上，它是**原地展开**而不是浮窗：
       面板自己不动、不加阴影、不盖住网页，只是把其余段落收起来、把这一段放大。
       手风琴的 single-expand 就是这个行为——用户不必再学"窗口管理"这套新概念。

       为什么不浮窗（上一版试过）：一浮起来就变成"另一个窗口"，于是要管位置、
       管遮挡、管鼠标离开变淡，还得让两处 textarea 同步；屏幕上同时有两处能打字，
       改的还不是同一份，是最容易出错的状态。原地展开没有这些代价，
       而且"我刚改的是哪一段"天生不用解释。
       ─────────────────────────────────────────────────────── */

    /** 专注时文本框能长多高：跟着视口走，别把面板顶穿 */
    function focusMax() {
      return Math.max(220, Math.min(Math.round(window.innerHeight * 0.5), 640));
    }

    /** 标题行右侧那颗按钮画成当前形态：图标、标题、aria 一起改，免得漏一处 */
    function paintFocusBtn(item, on) {
      const b = item && item.querySelector('.pin');
      if (!b) return;
      b.innerHTML = on ? ICON.focusOut : ICON.focusIn;
      b.title = on ? '恢复' : '专注';
      b.setAttribute('aria-label',
        on ? '恢复全部段落' : '专注「' + (item.dataset.label || '') + '」');
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }

    /** 专注态字号：存在 cfg.focusFont，落成 CSS 变量 --ht-fa（12–22px） */
    function applyFont(v) {
      const n = Math.max(12, Math.min(22, Math.round(Number(v) || fontOf())));
      panel.style.setProperty('--ht-fa', n + 'px');
      return n;
    }

    /** A− / A+：调的是"这一段我能看清多大"，顺手记住，下次进专注还是这个字号 */
    function zoom(delta, ta) {
      const cur = fontOf();
      const next = applyFont(cur + delta);
      /* 字号只是顺手记住，写不进去不该打扰人；但也不能留一个未处理的 Promise */
      if (next !== cur) saveFont(next);
      if (ta) autoGrow(ta, focusMax());
      /* 字变了行就变了：外框得跟着重算，否则只有文字在变、框不动 */
      fitPanelBox();
    }

    function enterFocus(item, ta) {
      if (focusItem === item) return;
      if (focusItem) exitFocus();
      focusItem = item;
      panel.classList.remove('is-dim');     // 进专注不该是淡的
      panel.classList.add('is-focus');
      box.classList.add('is-focus');
      item.classList.add('is-focus');
      /* 进专注才把 textarea 换上来：列表态是只读的（见 render 里 .ro 的说明） */
      item.classList.add('is-editing');
      /* 进来一定先展开：上次退出时若停在收窄态，这会让人以为"点了没反应" */
      item.classList.remove('is-folded');
      const hd = item.querySelector('.hd');
      if (hd) hd.setAttribute('aria-expanded', 'true');
      paintFold(item, false);
      paintFocusBtn(item, true);
      applyFont(fontOf());
      body.scrollTop = 0;
      /* 先归零下限再算高度：顺序反了的话 autoGrow 量到的是被旧下限撑着的旧高度 */
      fitPanelBox();
      autoGrow(ta, focusMax());
      fitPanelBox();
      /* 光标落回末尾：多数时候人是接着改，不是从头读 */
      try {
        ta.focus({ preventScroll: true });
        ta.setSelectionRange(ta.value.length, ta.value.length);
      } catch (e) { }
    }

    function exitFocus() {
      const item = focusItem;
      if (!item) return;
      focusItem = null;
      panel.classList.remove('is-focus', 'is-dim');
      box.classList.remove('is-focus');
      item.classList.remove('is-focus', 'is-editing');
      paintFocusBtn(item, false);
      const ta = item.querySelector('textarea');
      /* 编辑完把只读视图重画一遍：不重画的话，改过的字在列表态看不见，
         退出专注的瞬间会像"改动丢了"——真实原因是只有 textarea 变了。 */
      const ro = item.querySelector('.ro');
      if (ro && ta) ro.innerHTML = HT.markNums(ta.value);
      if (ta) autoGrow(ta);
      fitPanelBox();                        // 下限回到列表态（geom.FLOOR.list）
    }

    /* 点标题 = 收起 / 展开正文。普通态和专注态走同一个函数，
       否则"专注时点标题会收窄"就成了第二套要记的操作。 */
    /** 收起/展开按钮的图标与文案必须跟状态一起变，否则它就是块装饰 */
    function paintFold(item, folded) {
      const b = item && item.querySelector('.fold');
      if (!b) return;
      b.innerHTML = folded ? ICON.foldClose : ICON.foldOpen;
      b.title = folded ? '展开这一段' : '收起这一段';
      b.setAttribute('aria-label',
        (folded ? '展开「' : '收起「') + (item.dataset.label || '') + '」');
      b.setAttribute('aria-pressed', folded ? 'true' : 'false');
    }

    function toggleFold(item) {
      const on = !item.classList.contains('is-folded');
      item.classList.toggle('is-folded', on);
      const hd = item.querySelector('.hd');
      if (hd) hd.setAttribute('aria-expanded', on ? 'false' : 'true');
      paintFold(item, on);
      const ta = item.querySelector('textarea');
      const pv = item.querySelector('.pv');
      if (on && pv && ta) {
        const t = ta.value.replace(/\s+/g, ' ').trim();
        pv.textContent = t.length > 52 ? t.slice(0, 52) + '…' : t;
      }
      if (!on && ta) {
        autoGrow(ta, focusItem === item ? focusMax() : TA_MAX);
        try { ta.focus({ preventScroll: true }); } catch (e) { }
      }
    }

    /* ── 结果区 ───────────────────────────────────────────── */
    /** @param {HTMLTextAreaElement} ta @param {number} [max] 专注态传更大的上限 */
    function autoGrow(ta, max) {
      const cap = max || TA_MAX;
      ta.style.height = 'auto';
      const h = ta.scrollHeight + 2;
      ta.style.height = Math.min(h, cap) + 'px';
      ta.style.overflowY = h > cap ? 'auto' : 'hidden';
    }

    function render(items) {
      /* 重绘会换掉所有 textarea，专注手里攥着的那个就失效了，先退出来 */
      if (focusItem) exitFocus();
      box.innerHTML = '';
      items.forEach(it => {
        const d = HT.el('div', 'ht-item');
        d.dataset.label = it.label;
        /* 这一段属于哪一套（'day' / 'week'）。一期只出一份组合，正常情况下
           一屏里只有一种值；这个属性不显示，是给自检用的——出了两套就说明
           某处又按组拼了一回（1.13.0 起组合是唯一真源）。 */
        if (it.set) d.dataset.set = it.set;
        const lb = HT.el('div', 'lb');

        /* 标题整行可点：只做收起/展开。
           不再挂 ①②③④：序号说的是"第几段"，可段落本来就在人眼前排着，
           编号只是把顺序又说一遍；左端改成一道竖条，只当分段标记。 */
        /* 用 div + role=button 而不是 <button>：收起/展开那个小箭头在**框里面**，
           按钮不能套按钮（读屏会念出两个控件，点击也会打架）。语义仍是一个按钮，
           回车与空格自己接住。 */
        const hd = HT.el('div', 'hd');
        hd.setAttribute('role', 'button');
        hd.tabIndex = 0;
        hd.setAttribute('aria-expanded', 'true');
        const hbar = HT.el('i', 'bar');
        hbar.setAttribute('aria-hidden', 'true');

        const ta = document.createElement('textarea');
        ta.value = it.text;
        ta.rows = 2;
        ta.spellcheck = false;
        ta.setAttribute('aria-label', it.label);
        /* 正文可改，但改了之后校验结论就只对生成时的文字成立。
           这里只记一个标记，不拦着改——导出时把它写进文件末尾。 */
        ta.addEventListener('input', () => { onEdit(); });

        /* 专注态右侧三个动作：复制 / A− / A+。
           这里原来摆的是「115 字」——字数是**看的信息**，不是要点的动作；
           专注时人真正要的是"把这段拿走"和"字太小了放大点"。 */
        /* 复制常驻在标题框**外面**、箭头右侧：箭头管"这一段露不露"，
           复制管"把这一段拿走"——开合与动作不是一类事，不该挤进同一个框。
           专注态那两个 A− / A+ 排在它右边，字号只在这一段被放大时才有意义。 */
        const cpBtn = HT.el('button', 'cp');
        cpBtn.type = 'button';
        cpBtn.innerHTML = ICON.copy;
        cpBtn.title = '复制这一段';
        cpBtn.setAttribute('aria-label', '复制这一段');

        const ft = HT.el('div', 'ft');
        const mkBtn = (icon, title) => {
          const b = HT.el('button', 'ftb');
          b.type = 'button';
          b.innerHTML = icon;
          b.title = title;
          b.setAttribute('aria-label', title);
          return b;
        };
        const minBtn = mkBtn(ICON.minus, '缩小字号');
        const maxBtn = mkBtn(ICON.plus, '放大字号');
        ft.append(minBtn, maxBtn);

        const pinBtn = HT.el('button', 'pin');
        pinBtn.type = 'button';
        pinBtn.innerHTML = ICON.focusIn;
        pinBtn.title = '专注';
        pinBtn.setAttribute('aria-label', `专注「${it.label}」`);
        pinBtn.setAttribute('aria-pressed', 'false');

        /* 收起/展开：紧贴标题的**第一个**图标，列表态与专注态同一个位置。
           上一版一度把它挪到行尾，结果专注态里它跑到「复制 / A− / A+」右边去了——
           那三个是"对这一段做什么"，箭头是"这一段露不露"，后者该在更前面。
           固定次序：标题 → 箭头 → 动作 → 专注/恢复。
           （1.12.13）不给 title：它坐在标题框里，鼠标划过标题框时箭头自己会亮，
           再冒一个黑框出来只是在说"这也是个按钮"——而它本来就长在按钮里面。 */
        const foldBtn = HT.el('button', 'fold');
        foldBtn.type = 'button';
        foldBtn.innerHTML = ICON.foldOpen;
        foldBtn.setAttribute('aria-label', `收起「${it.label}」`);
        foldBtn.setAttribute('aria-pressed', 'false');

        hd.append(hbar, HT.el('b', null, it.label), foldBtn);

        lb.append(hd, cpBtn, ft, pinBtn);

        /* 收起后留一行预览，免得只剩标题认不出是哪段 */
        const pv = HT.el('div', 'pv');

        /* 只读视图（2026-11-15）：
           初始界面**不能编辑**——段落的用途是"读一遍、复制走"，textarea 摆在
           那里会让人以为随时要改，而且它做不到局部着色（数字高亮）。
           所以列表态用 div 渲染正文，数字包成 <b>；双击这里进专注，
           那时才换成 textarea。编辑完退出专注，div 用新文本重画。 */
        const ro = HT.el('div', 'ro');
        ro.innerHTML = HT.markNums(it.text);
        ro.title = '双击进入专注，可编辑';

        const grow = () => autoGrow(ta, focusItem === d ? focusMax() : TA_MAX);

        /* 刚用它拖过面板的那一下不算"点标题"：两者都是在这条横条上按下再松开，
           唯一区别是有没有移动，靠 endPanelDrag 留的抑制窗口区分。 */
        hd.addEventListener('click', () => { if (!suppressed()) toggleFold(d); });
        hd.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleFold(d); }
        });
        ta.addEventListener('input', () => {
          grow();
          refreshGates();
        });
        cpBtn.addEventListener('click', async e => {
          e.stopPropagation();
          if (throttled('fcopy', 700)) return;
          const ok = await HT.copyText(ta.value);
          HT.flashBtn(cpBtn, ok ? '已复制' : '复制失败', ok);
        });
        minBtn.addEventListener('click', e => { e.stopPropagation(); zoom(-1, ta); });
        maxBtn.addEventListener('click', e => { e.stopPropagation(); zoom(1, ta); });
        foldBtn.addEventListener('click', e => {
          e.stopPropagation();
          toggleFold(d);
        });
        pinBtn.addEventListener('click', e => {
          e.stopPropagation();
          if (throttled('focus:' + it.i, 220)) return;
          if (focusItem === d) exitFocus();
          else enterFocus(d, ta);
        });
        /* 双击只读区 = 进专注并开始编辑。这是"想改字"最自然的动作：
           单击已经在标题上管收起，正文区空着不接事件反而浪费。
           收起态的预览行也接同一件事——收起时正文只剩那一行，
           人在那儿双击的意图与展开态完全一样。 */
        const toFocus = () => {
          if (throttled('ro:' + it.i, 220)) return;
          /* 收起态要先展开：enterFocus 里虽然会 remove('is-folded')，
             但预览行的折叠状态与按钮图标得一起改，否则图标还停在"展开" */
          if (d.classList.contains('is-folded')) toggleFold(d);
          enterFocus(d, ta);
        };
        ro.addEventListener('dblclick', toFocus);
        pv.addEventListener('dblclick', toFocus);

        d.append(lb, pv, ro, ta);
        box.appendChild(d);
        grow();
      });
      refreshGates();
      body.scrollTop = 0;
    }

    return {
      render,
      enterFocus,
      exitFocus,
      applyFont,
      /** 供 fitPanelBox 判断高度下限：专注态无下限，列表态见 geom.FLOOR.list */
      isFocus: () => !!focusItem,
      TA_MAX
    };
  };
})(typeof window !== 'undefined' ? window : globalThis);
