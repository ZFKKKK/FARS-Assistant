/**
 * src/ui/checks.js —— 面板里的校验栏（列表 + 摘要行 + 全通过/待核切换）
 *
 * @file      src/ui/checks.js
 * @version   1.6.16
 * @build     2026-11-13
 * @license   MIT
 *
 * 从 panel.js 摘出来（0.25.0）。这一块以前有三种状态（`ckCache` / `ckMode` /
 * `ckOpen`）散在面板闭包里，而它们只在"校验栏自己"这一块有意义：
 * 缓存的是上一次生成的校验结果，筛选的是"只看问题项 / 全部"，
 * 开关的是列表展不展开。面板关心的问题只有一个——**这一栏现在露不露**。
 *
 * 于是边界是：
 *   面板 → CK.render(checks, summary) ／ CK.clear() ／ CK.hide()
 *   CK   → 点校验行时回调 onAsk(key)，由面板转给问答浮层（它不知道该跳哪）
 *
 * 一条**共用**的说明：每条校验行是一个 `<button>`，点它跳到 FAQ 里对应的
 * 说明（在核什么 / 为什么红 / 怎么办）。说明只写一份（data/faq.js 的
 * CHECK_DOCS），校验栏与问答共用，不各写一套。
 *
 * 依赖：HT.el 不用，只用 esc 与 DOM；不碰存储、不碰网络、不认识校验规则。
 */
(function (g) {
  'use strict';
  const HT = (g.__HT = g.__HT || {});

  /**
   * @param {object}   d
   * @param {Element}  d.sec     整栏 #ht-cksec
   * @param {Element}  d.tog     标题行折叠按钮 #ht-cktog
   * @param {Element}  d.ic      标题行状态图标 #ht-ckic
   * @param {Element}  d.box     列表容器 #ht-checks
   * @param {Element}  d.rt      右侧摘要 #ht-ckrt
   * @param {Element}  d.segRoot 含分段器的那层（ShadowRoot 或面板根），用 #ht-ckseg 找按钮
   * @param {Function} d.esc     转义
   * @param {object}   d.throttled HT.createThrottle() 实例
   * @param {Function} d.onAsk   点某一行的「?」：把 key 交给问答浮层
   */
  HT.mountChecks = function (d) {
    const sec = d.sec;
    const tog = d.tog;
    const ic = d.ic;
    const box = d.box;
    const rt = d.rt;
    const esc = d.esc;
    const throttled = d.throttled;
    const onAsk = d.onAsk;

    /* 三种状态都是本模块的：上一次的结果、筛选口径、列表展不展开 */
    let cache = null;
    /* 校验结果四态：circle-check / alert-triangle / circle-x / info-circle。
       形状在 src/ui/dom.js 的 HT.ICON 里（ckOk/ckWarn/ckBad/ckNote），
       这里只做「状态 → 图标」的映射：这是本模块的语义，几何不属于它。
       note 是附注：陈述口径事实（本期有几条待填报），不是待核项。 */
    const CK_ICON = {
      ok: HT.ICON.ckOk, warn: HT.ICON.ckWarn,
      bad: HT.ICON.ckBad, note: HT.ICON.ckNote
    };
    let mode = 'all';
    let open = false;

    const segBtns = () => [...d.segRoot.querySelectorAll('#ht-ckseg button')];

    function draw() {
      if (!cache) return;
      /* 「仅问题」不出附注：附注说的是口径事实，不是要处理的问题 */
      const list = mode === 'issue' ? cache.filter(c => !c.ok) : cache;
      /* 一行包在 .ck-in 里：折叠靠 CSS 的 grid-template-rows 0fr → 1fr，
         这一层是"能隐藏溢出"的那一层（见 panel.css 的 .ht-checks）。
         没有它，0fr 塌下去的子元素照样撑出高度。 */
      box.innerHTML = '<div class="ck-in">' + (list.length ? list.map(c => {
        const cls = c.note ? 'note' : (c.ok ? 'ok' : (c.level === 'warn' ? 'warn' : 'bad'));
        const ic = CK_ICON[cls];
        /* 不给整行挂 title：说明段落有十几行，浮出来会盖住半块面板，
           而这一行本来就是按钮——点它直接跳到 FAQ 里那一条。 */
        return `<button type="button" class="ht-ck ${cls}" data-key="${esc(c.key || '')}">` +
          `<em>${ic}</em><b>${esc(c.name)}</b>` +
          (c.detail ? `<span class="d">${esc(c.detail)}</span>` : '') +
          `<span class="q" aria-hidden="true">?</span></button>`;
      }).join('') : '<div class="ht-ck-none">没有发现问题项</div>') + '</div>';
    }

    function setOpen(on) {
      open = !!on;
      sec.classList.toggle('open', open);
      tog.setAttribute('aria-expanded', open ? 'true' : 'false');
      box.classList.toggle('show', open);
    }

    function syncSeg() {
      segBtns().forEach(btn => {
        btn.classList.toggle('on', btn.dataset.mode === mode);
      });
    }

    /**
     * @param {Array}  checks  校验结果
     * @param {object} summary {failed, total}
     */
    function render(checks, summary) {
      cache = checks;
      sec.hidden = false;
      const bad = summary.failed;
      /* 这一行说的是"几项待核"，图标只是把同一句话又说一遍；
         状态由标题栏那颗圆点的颜色说，字还是字。 */
      sec.dataset.tone = bad ? 'bad' : 'ok';
      /* 折叠按钮回落的颜色也要跟着换：它就是标题栏那行状态，
         绿/橙说的正是"全部通过 / 有几项待核"。 */
      tog.dataset.tone = bad ? 'bad' : 'ok';
      /* 下拉里三样东西：一个说状态，一个说数量，一个筛选口径。
         "全部通过 / 项待核"这些字撤掉了——图标与数字已经说完，
         再配一句是同一件事说两遍；取数时刻退进 title。 */
      if (ic) ic.innerHTML = bad ? CK_ICON.warn : CK_ICON.ok;
      rt.textContent = (bad ? bad : summary.total) + ' 项';
      rt.className = 'rt ' + (bad ? 'bad' : 'ok');
      tog.setAttribute('aria-label', '数据校验：' +
        (bad ? bad + ' 项待核' : summary.total + ' 项全部通过'));
      tog.title = (bad ? `${bad} 项需要核对` : `${summary.total} 项全部通过`) +
        (summary.at ? ` · 查询 ${summary.at}` : '');
      mode = bad ? 'issue' : 'all';
      syncSeg();
      /* 结果到了也**不自动展开**：这一层是下拉，常驻展开就又是占版面的一行。
         要看得自己点状态那一行。 */
      setOpen(false);
      draw();
    }

    /** 换人/重来时连缓存一起丢掉：留着上一位的结果比空着更危险 */
    function clear() {
      cache = null;
      hide();
    }

    /** 只是先收起来（查询中），缓存留着——回来还要按同一份结果重画 */
    function hide() {
      sec.hidden = true;
      setOpen(false);
    }

    /* 只有「已校验」那一行点得开：其余状态的 aria-disabled 是 true，
       点了什么都不发生——不弹提示、不闪一下，状态本身已经说明现在没东西可看。 */
    const toggle = () => {
      if (tog.getAttribute('aria-disabled') === 'true') return;
      setOpen(!open);
    };

    /* ── 事件 ─────────────────────────────────────────────────
       三处：整栏折叠、分段器（只看问题 / 全部）、列表里的一行。
       以前它们散在面板事件区，和生成、导出、Esc 混在一段。 */
    tog.addEventListener('click', toggle);
    segBtns().forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.classList.contains('on')) return;
        mode = btn.dataset.mode;
        syncSeg();
        draw();
      });
    });
    box.addEventListener('click', e => {
      const b = e.target.closest('.ht-ck');
      if (!b || !b.dataset.key) return;
      if (throttled('ckq', 260)) return;
      onAsk(b.dataset.key);
    });

    return { render, clear, hide, toggle, isOpen: () => open };
  };
})(typeof window !== 'undefined' ? window : globalThis);
