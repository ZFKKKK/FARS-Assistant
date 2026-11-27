/**
 * src/ui/panel.js —— 面板：结构、状态机、开合、生成与接线
 *
 * @layer  ui（表现层）
 * @file   src/ui/panel.js
 * @since  6.0.0
 *
 * 与业务的分界线：这里只管"把结果放上去、把操作接起来"，取数与成文全在 domain 层。
 * 样式在 panel.css，状态文案在 src/ui/tokens.js。
 *
 * 它管什么（0.25.0 起）：面板自己的模板与图标、状态机、开合/位置/拖拽、
 * 登录与截点、基准时间、生成编排、错误态、事件总机（data-act 分发与 Esc 层叠）。
 *
 * 它不管什么——这几块都搬出去单独成文件了，读的时候别在这儿找：
 *   段落列表 / 专注 / 折叠 / 字号      → ui/sections.js
 *   口径与常见问题浮层                  → ui/faq.js
 *   数据校验栏（缓存 / 筛选 / 展开）    → ui/checks.js
 *   标题栏左上「文稿助手 v1.x」          → 就在本文件（1.2 起没有切人菜单了）
 *   面板落位的坐标算术                    → ui/geom.js
 *   按钮回执 / 剪贴板 / 下载            → ui/feedback.js
 *   设置页（浮层与独立页共用同一份）    → ui/settings.js（编辑器在 ui/editor.js）
 *
 * 版式（自上而下只有四块，不再有提示条）
 *   1. 标题栏：左「你好，XX ▾」（切用户）＋ 刷新/复制/导出/设置/问答/关闭六个同规格图标按钮
 *   2. 进度线：紧贴标题栏下边缘的 2px 轨道。所有加载进度都走它，按钮自己**不画**进度
 *   3. 主体：基准时间 → 数据校验（可折叠）→ 分段文字（可折叠）
 *   4. 状态栏：左边三个字说状态（未到点/查询中/已校验），明细与请求数退进 title。
 *      到截点的倒计时 0.19 已撤——截点写在主体的「基准时间」里，说一遍就够
 *
 * 交互约定
 *   · 按钮只有两态：可用 / 置灰。置灰**仍可点**，点一下就在这个按钮下方浮出四个字
 *     （请先登录 / 正在取数 / 请稍候），1.6 秒自己消失——不弹框、不做全局固定位置
 *   · 查询中把查询按钮直接置灰，防止重复点；取数结束自动恢复
 *   · 关闭只有三个出口：× / Esc / 再点顶部「数据」；另外「点面板外空白处」按
 *     设置里的 closeOnOutside 决定要不要生效（默认开，查询中不响应）
 *
 * 专注（Focus，不是浮窗）
 *   每段标题行右侧只有一个按钮。点它，**面板里其他段落原地收起**，只剩这一段并放大，
 *   好在同一块地方安心改字；再点「恢复」全回来。它不动位置、不加阴影、不遮挡网页。
 *   进入专注时标题栏与状态栏一并收起——那两块在改字这件事上都是噪音，
 *   退出只剩三条路：段落标题行上的「恢复」、Esc、点标题收窄后再「恢复」。
 *   专注态右侧不给字数，给三个动作：复制这一段 / A− / A+（字号 12–22，记在配置里）。
 *   Esc 逐层退：菜单 → 问答 → 专注 → 面板。
 */
(function (g) {
  'use strict';
  const HT = (g.__HT = g.__HT || {});

  /* 错误分类、状态栏短名与处置语只在 src/data/errors.js 里定义一份。
     这里原来还有一张 ERROR_UI 表，六类各写各的措辞，与文档、与 data 层三方漂移；
     现在只调 HT.errInfo / HT.errHTML，面板不再持有任何错误文案。 */

  /* 图标表在 src/ui/dom.js 里（HT.ICON）。全项目只留一份：
     面板标题栏、段落上移/下移/删除、复制与导出的对勾/叹号回执，都从那里取。
     以前这里有一张、editor.js 有一张、feedback.js 还有两个内联常量，
     同一个动作的图标能在两处长得不一样，而它们的 viewBox 与 aria 属性
     本来必须一致（尺寸由 CSS 定，aria-hidden 少写一个读屏就念一串图形）。 */
  const PANEL_HTML = `
    <div id="ht-panel" role="dialog" aria-label="简报助手" tabindex="-1" inert>
      <div class="ht-head" id="ht-head">
        <!-- 标题栏只留两样：左边一个圆圈图标加三个字说状态，右边一串动作。
             产品名与版本号撤掉了——面板是从站点导航点进来的，名字已经写在入口上；
             版本号在设置页与更新提示里，占在这里只会把动作挤向两边。 -->
        <button class="stb" id="ht-st" type="button" aria-disabled="true"
                aria-expanded="false" aria-controls="ht-ckpop">
          <i class="dt" id="ht-sti" aria-hidden="true">${HT.ICON.ckDots}</i><b id="ht-stb">检测中</b><i class="ht-sts" id="ht-sts" hidden></i>
        </button>
        <!-- （1.12.8）：时间与拿走成品的动作全部并进标题栏。
             原来「统计周期 / 条件时间 / 查询时间」单独占主体顶部两行、复制导出再占一行，
             正文被压下去 60 多像素；现在按"读 → 定 → 取 → 拿"排成一条：
             条件时间与查询时间（仍是上下两行、仍是正文用的那两个值）→ 周期开关
             → 查询 → 复制 / 导出 → 设置 / 问答 / 关闭。
             除时间读数外一律不给文字：标题栏宽度只够图标，
             中文标签会把查询挤到中间去（见 panel.css 里 .ht-head 的注释）。
             内容由 showMeta() 现画：周期与条件时间都要跟着配置变，
             写在模板里就等于同时有两个地方定义同一件事。 -->
        <dl class="ht-range" id="ht-range"></dl>
        <!-- （1.12.17）起这一颗**不再带 .ht-seg**：那套旧样式自带 4px 内边距、
             格间 gap 与「选中块」白底，与新滑块的 2px 裁剪窗口对不上——
             两套 padding 一起生效时，滑块会比选中那一格高 4px、上移 2px。 -->
        <span class="ht-per" id="ht-per" role="group" aria-label="统计周期"></span>
        <button class="ht-ico ht-gen" id="ht-gen" type="button"
                aria-label="按条件时间查询成文" aria-disabled="true">${HT.markSvg(HT.DEFAULT_UI.mark)}</button>
        <!-- 拿走成品：复制全文 / 导出（清单或统计报表二选一）。只用图标，
             动词退进 aria-label 与悬停提示——标题栏里已经有六颗按钮。 -->
        <button class="ht-ico" id="ht-copy" type="button" title="复制全部"
                aria-label="复制全部文字" aria-disabled="true">${HT.ICON.copy}</button>
        <button class="ht-ico" id="ht-exp" type="button" title="导出报表" aria-label="导出报表"
                aria-haspopup="menu" aria-expanded="false" aria-disabled="true">${HT.ICON.download}</button>
        <!-- 次要功能收在右上角一组，只用图标、压到墨 4：
             标题栏只留一个被强调的动作（查询），其余靠位置与明度退到后面。
             （1.12.13）设置换回齿轮（齿减到 8 根、中心留孔，13px 下仍数得出齿），
             问答仍是一本书：三根滑块的形状更像"参数调节"，不如齿轮直接。 -->
        <span class="ht-minor" id="ht-minor">
          <button class="ht-ico ht-ico-s" id="ht-cfg" type="button" aria-label="打开设置">${HT.ICON.gear}</button>
          <button class="ht-ico ht-ico-s" id="ht-help" type="button" title="口径与常见问题"
                  aria-label="打开口径与常见问题" aria-expanded="false">${HT.ICON.book}</button>
          <button class="ht-ico ht-ico-s" id="ht-close" type="button" aria-label="收起面板（Esc）">${HT.ICON.x}</button>
        </span>
        <div class="ht-hint" id="ht-hint" role="status" aria-live="polite"></div>
      </div>
      <!-- 校验收在一层下拉里：只有「已校验」那一行点得开。
           里面三样：几项通过 / 仅问题还是全部 / 逐条说明。
           早先它常驻在时间下面一行，稿子没出时也占着一块地；收成下拉之后，
           面板顶部只剩两个时间和两个动作。 -->
      <div class="ht-ckpop" id="ht-ckpop" role="dialog" aria-label="数据校验" hidden>
        <div class="ck-pop-hd">
          <em class="ic" id="ht-ckic" aria-hidden="true"></em>
          <b class="rt" id="ht-ckrt"></b>
          <span class="sp"></span>
          <span class="ht-seg" id="ht-ckseg" role="group" aria-label="校验显示范围">
            <button type="button" data-mode="issue">仅问题</button>
            <button type="button" data-mode="all" class="on">全部</button>
          </span>
        </div>
        <div class="ht-checks" id="ht-checks"></div>
      </div>
      <!-- 两份表共用一个 ⇩。都有人要，但都不常用，不值得再占一个图标位。
           两行写的就是导出后的文件名（1.12.18）：菜单问的是"拿哪一份文件"，
           不是"要哪一种报表"，所以行里只有文件名，不挂任何副题。 -->
      <div class="ht-menu" id="ht-expmenu" role="menu" aria-label="导出" hidden>
        <button type="button" role="menuitem" data-act="list">
          <span>火灾信息列表.xlsx</span>
        </button>
        <button type="button" role="menuitem" data-act="stat">
          <span>分原因分等级火灾情况统计表.xlsx</span>
        </button>
      </div>
      <div class="ht-hline" id="ht-hline"><i class="ht-hbar" id="ht-bar"></i></div>
      <div class="ht-body">
        <!-- 主体里不再有"时间行 + 复制导出"那一块：（1.12.8）起它们全在标题栏，
             这里直接从正文开始。面板宽度也随之为标题栏加宽（见 panel.css #ht-panel）。 -->
        <div id="ht-out"><div class="ht-empty">${HT.ICON.ghost}<span>点查询图标，按条件时间成文</span></div></div>
        <div class="ht-faq" id="ht-faq" hidden>
          <div class="fq-head">
            <button class="fq-back" id="ht-fqback" type="button" aria-label="返回（Esc）">${HT.ICON.back}</button>
            <b>口径与常见问题</b>
            <span class="sp"></span>
            <span class="fq-cnt" id="ht-fqcnt"></span>
          </div>
          <div class="fq-find">
            <input id="ht-fqinput" type="search" spellcheck="false"
                   placeholder="搜：截点  成灾  待核  专注" aria-label="搜索问题">
          </div>
          <div class="fq-nav" id="ht-fqnav" role="group" aria-label="问题分类"></div>
          <div class="fq-list" id="ht-fqlist"></div>
        </div>
        <div class="ht-set" id="ht-set" hidden>
          <!-- 设置页的"保存"在**头部右上角**，不再单占一条页脚：
               设置不是对话框，不需要一条只放两个按钮的底栏；
               而"改完这里点保存"这件事，最容易被看见的位置就是标题行右侧。
               按钮由 settings.js 挂进来（它才知道保存要收哪些项），
               这里只留容器——独立设置页没有这个容器时退回页脚。 -->
          <div class="fq-head st-head">
            <button class="fq-back" id="ht-setback" type="button" aria-label="返回（Esc）">${HT.ICON.back}</button>
            <b>设置</b>
            <span class="st-hats" id="ht-setacts"></span>
          </div>
          <div class="st-view" id="ht-setview"></div>
        </div>
      </div>
    </div>`;

  /**
   * @param {ShadowRoot} shadow
   * @param {object} nav mountNav 返回的句柄
   */
  HT.mountPanel = function (shadow, nav) {
    /* ShadowRoot 不是 Element，没有 insertAdjacentHTML，必须走 template + appendChild */
    const tpl = document.createElement('template');
    tpl.innerHTML = PANEL_HTML;
    shadow.appendChild(tpl.content);

    const $ = id => shadow.getElementById(id);
    /* 装配前的边界检查：标记与脚本对不上（改了 HTML 漏了 id、或者被别的脚本动了
       宿主）时，明确说出"缺哪个"，而不是在下面某一行抛一个没有上下文的
       TypeError。弹出点由 nav.js 兜住——那边会把入口置为不可用并记一条 UI-MOUNT，
       而不是让整个扩展一起白。 */
    const NEED = ['ht-panel', 'ht-range', 'ht-per', 'ht-hline', 'ht-bar', 'ht-out',
      'ht-ckpop', 'ht-ckic', 'ht-checks', 'ht-ckrt', 'ht-hint', 'ht-st', 'ht-stb', 'ht-sts',
      'ht-gen', 'ht-copy', 'ht-exp', 'ht-expmenu', 'ht-faq', 'ht-fqinput', 'ht-fqnav', 'ht-fqlist', 'ht-fqcnt',
      'ht-help', 'ht-set', 'ht-setview', 'ht-cfg', 'ht-close'];
    const miss = NEED.filter(id => !$(id));
    if (miss.length) throw new Error('面板缺少节点：' + miss.join('、'));
    const panel = $('ht-panel');
    const head = panel.querySelector('.ht-head');
    const rangeBox = $('ht-range');
    /* 周期开关的容器在标题栏里（1.12.8）；它原来跟着条件时间一起由 showMeta 画在
       主体顶部，现在两处分开画：读数和开关各有各的位置。 */
    const perBox = $('ht-per');
    const hline = $('ht-hline');
    const bar = $('ht-bar');
    const outBox = $('ht-out');
    const ckPop = $('ht-ckpop');
    const ckBox = $('ht-checks');
    const ckRt = $('ht-ckrt');
    const hintEl = $('ht-hint');
    const stEl = $('ht-st');
    const stI = $('ht-sti');
    const stB = $('ht-stb');
    const stSess = $('ht-sts');
    const btnGen = $('ht-gen');
    const btnCopy = $('ht-copy');
    const btnExp = $('ht-exp');
    const body = panel.querySelector('.ht-body');

    /* 口径与常见问题 */
    const faqEl = $('ht-faq');
    const fqInput = $('ht-fqinput');
    const fqNav = $('ht-fqnav');
    const fqList = $('ht-fqlist');
    const fqCnt = $('ht-fqcnt');
    const btnHelp = $('ht-help');

    /* 设置浮层（与问答同一块地方，内容由 settings.js 挂进来） */
    const setEl = $('ht-set');
    const setView = $('ht-setview');
    const btnCfg = $('ht-cfg');
    let settingsView = null;
    /* 进出走 HT.veil：hidden 只管布局，观感交给 is-in / is-out。
       feedback.js 没加载时退回"只改 hidden"——硬切，但至少能用。 */
    const setVeil = HT.veil ? HT.veil(setEl, 130)
      : { show: () => { setEl.hidden = false; }, hide: cb => { setEl.hidden = true; if (cb) cb(); } };

    const META = HT.META;
    const STATE = HT.UI_STATE;
    const esc = HT.esc;
    const pad = HT.pad;
    const throttled = HT.createThrottle();

    let state = 'checking';
    let busy = false;
    /* 最近一次生成的完整结果与"生成后是否被人改过"。
       导出要用：校验结论只对生成那一刻的正文成立，人改完字之后再去上报，
       稿子和校验就对不上了，导出件里必须留痕。 */
    let lastRun = null;
    /* 按下查询的那一刻。一次取数只写一次（不随进度跳），面板关掉就清 ——
       草稿本来也不跨会话，留着上一次的时刻只会和屏上空白的正文对不上。 */
    let queryAt = null;
    let editedAfterGen = false;
    let cooling = false;
    let cfg = null;
    let CK = null;              // 校验栏（src/ui/checks.js），mountChecks 之后可用
    let coolTimer = null;
    let barTimer = null;
    let hintTimer = null;

    /* 专注、问答与设置的状态。
       "哪一段正被放大"这根指针已经在 sections.js 自己的闭包里了（0.25.0），
       面板这边只留一个句柄——想退出专注就叫 S.exitFocus()，不再直接读那根指针。 */
    let S = null;              // 段落区（src/ui/sections.js），mountSections 之后可用
    let F = null;              // 问答浮层（src/ui/faq.js），mountFaq 之后可用
    let setOpen = false;

    /* ── 底部状态栏 ───────────────────────────────────────── */
    /* 左边**只允许三个字**（检测中/未登录/未到点/已就绪/查询中/已校验/出错了），
       三个字是扫一眼就能抓住的长度；取数明细这类补充信息一律进 title，
       不再在右边挂一串小字——那串小字会随进度每秒抖动，比状态本身还抢眼。 */
    /* 圈里画什么，只由 tone 决定，与三个字并行说同一件事：
       绿圈对勾 = 已校验 / 已就绪，黄圈叹号 = 未登录 / 未到点，
       红圈叹号 = 出错了，灰圈三点 = 检测中 / 查询中。
       颜色走 panel.css 的 .stb.ok / .warn / .bad / .run，这里只挑形状。 */
    function stIcon(tone) {
      if (tone === 'ok') return HT.ICON.ckOk;
      if (tone === 'warn' || tone === 'bad') return HT.ICON.ckAlert;
      return HT.ICON.ckDots;
    }
    let footTip = '';
    function setFoot(label, tone, tip) {
      stB.textContent = label || '';
      stEl.className = 'stb' + (tone ? ' ' + tone : '');
      stI.innerHTML = stIcon(tone);
      /* 只有「已校验」那一行点得开：校验结果还挂在它下面。
         其余状态把 aria-disabled 置上，既拦住点击，也让样式退成不可点。 */
      stEl.setAttribute('aria-disabled', state === 'done' ? 'false' : 'true');
      footTip = tip || label || '';
      stEl.title = footTip;
      /* 状态字一换，后面的小尾巴（未同步 / 能不能点）也要跟着重算：
         从「已就绪」翻到「未登录」时，尾巴若还挂着上一条的「未同步」，两句话打架。 */
      paintSess();
    }

    /* 标题栏原来还有一块「到截点还剩多久」的倒计时，0.19 撤掉了。
       理由有两条：截点本来就写在下面的「基准时间」里，倒计时是把同一件事说两遍；
       而它占的那几十像素，正是把名字挤成「值…」的原因。
       现在这一行只剩：名字（可伸缩）→ 一道竖线 → 状态三个字 → 六个按钮。 */

    /* ── 顶部进度线 ───────────────────────────────────────── */
    /** @param {number|null} v 0-100；null = 不确定进度（来回扫） */
    function setBar(v, tone) {
      clearTimeout(barTimer);
      barTimer = null;
      bar.classList.remove('ok', 'warn', 'bad', 'fade');
      bar.style.opacity = '1';
      if (tone) bar.classList.add(tone);
      hline.classList.toggle('indet', v === null);
      bar.style.width = (v === null ? 34 : Math.max(0, Math.min(100, v))) + '%';
    }

    function finishBar(tone) {
      setBar(100, tone);
      barTimer = setTimeout(() => {
        bar.classList.add('fade');
        bar.style.opacity = '0';
        barTimer = setTimeout(() => {
          if (!busy) { bar.style.width = '0'; hline.classList.remove('indet'); }
        }, 320);
      }, HT.UI_MS.hint);
    }

    /* ── 瞬时反馈：在**被点那个按钮**下方浮四个字，1.6 秒自己消失 ── */
    /** @param {string} text @param {Element} [anchor] 触发这次提示的按钮 */
    function hint(text, anchor) {
      hintEl.textContent = text;
      hintEl.classList.add('show');
      const hr = head.getBoundingClientRect();
      const ar = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : null;
      const w = hintEl.offsetWidth;
      const h = hintEl.offsetHeight;
      let left, top;
      if (ar && ar.width) {
        /* 按钮正下方居中，左右夹在标题栏之内 */
        left = ar.left - hr.left + ar.width / 2 - w / 2;
        top = ar.bottom - hr.top + 6;
      } else {
        left = hr.width - w - 10;
        top = (hr.height - h) / 2;
      }
      left = Math.max(6, Math.min(left, Math.max(6, hr.width - w - 6)));
      hintEl.style.left = left + 'px';
      hintEl.style.top = top + 'px';
      clearTimeout(hintTimer);
      hintTimer = setTimeout(hideHint, 1600);
    }

    /** 收掉提示条时必须把位置一起归零。
        它是绝对定位的：只摘 .show 只是变成 opacity 0，盒子仍在原来那个 left 上，
        依旧算进面板的滚动范围——窗口一窄，它就把面板撑出一条横向滚动条
        （实测 448 宽的面板被一条 226 宽的旧提示撑到 505）。
        淡出留 240ms：等过渡走完再挪位置，别让人看见它"跳"回左上角。 */
    function hideHint(now) {
      hintEl.classList.remove('show');
      const clear = () => {
        if (hintEl.classList.contains('show')) return;
        hintEl.style.left = '0px';
        hintEl.style.top = '0px';
      };
      if (now) clear();
      else setTimeout(clear, 240);
    }

    /* 空态文案要跟着状态走：没到截点时点「生成」拿到的是上一个周期，
       这一点不写清楚，用户会以为取的是今天的数。 */
    function refreshEmpty() {
      const sp = outBox.querySelector('.ht-empty span');
      if (!sp || outBox.querySelector('.ht-item')) return;
      /* 空态只说下一步做什么。"未到点、取的是上一周期"这件事不用再写一遍——
         顶上两行时间（基准 21 日 18 时 / 查询 20 日 18 时）已经把差异摆在明面上。 */
      sp.textContent = '点查询图标生成简报';
    }

    /* ── 状态 ─────────────────────────────────────────────── */
    /* 冷却期不再算进置灰条件：生成完就该立刻恢复成可用的蓝色，
       否则用户会以为还在加载。冷却只拦点击（给「请稍候」），不改外观。 */
    const canGen = () => !busy &&
      (state === 'ready' || state === 'pending' || state === 'done' || state === 'error');
    const hasText = () => {
      const tas = outBox.querySelectorAll('textarea');
      for (const t of tas) if (t.value.trim()) return true;
      return false;
    };

    /* 复制与导出的可用条件有两条：这一稿有字，且这一稿的校验是过的。
       校验没过就置灰——这一版的口径是"核对完再拿走"，不是"先拿走、文末附一句"。
       理由放在 title 里：悬停能看到"几项待核"，不必点一下再换一句提示。 */
    const TIP_COPY = btnCopy.title;
    const TIP_EXP = btnExp.title;
    function refreshGates() {
      const g1 = canGen();
      btnGen.classList.toggle('is-off', !g1);
      /* 取数中把放大镜换成转圈：置灰只是"按不动了"，而人手刚点过的那个按钮
         得自己动一下，才算收到了（1.12.11）。class 与 is-off 分开管——
         is-off 也出现在"没登录 / 没到点"上，那些情况不该转。 */
      btnGen.classList.toggle('is-busy', busy);
      btnGen.setAttribute('aria-disabled', g1 ? 'false' : 'true');
      /* 图标的状态形也跟着走（1.12.16）：这四态只换形状与颜色，不换 DOM */
      paintMarkState();
      const has = hasText();
      const bad = (lastRun && lastRun.summary && lastRun.summary.failed) || 0;
      const g2 = has && !bad;
      [btnCopy, btnExp].forEach(b => {
        b.classList.toggle('is-off', !g2);
        b.setAttribute('aria-disabled', g2 ? 'false' : 'true');
        b.title = !has ? '生成一次后才能用' : (bad ? `${bad} 项待核，核对后再用` : (b === btnCopy ? TIP_COPY : TIP_EXP));
      });
    }
    const gated = () => !hasText() || !!(lastRun && lastRun.summary && lastRun.summary.failed);

    /* ── 界面手感（1.12.16）────────────────────────────────
       五颗控件的参数存在 cfg.ui（默认值见 config.js 的 UI_PARAMS），
       这里只做两件事：
         · 写成 CSS 变量（HT.applyUi），长什么样由 panel.css 决定；
         · 查询图标要按分段数 / 弧长重画 SVG——几何是算出来的，改不了变量。
       设置页拖滑杆时走 onUi → 同一套函数，所以"预览"与"保存后"是同一份实现。 */
    function paintMark() {
      const ui = (cfg && cfg.ui && cfg.ui.mark) || HT.DEFAULT_UI.mark;
      btnGen.innerHTML = HT.markSvg(ui);
      paintMarkState();
    }

    /* 图标画的是"这一轮走到哪一步"，与状态字同源：
       查询中转弧、出稿画对勾、出错画叉，其余是一个完整的圈。
       不按 nologin / pending 换形——那两种是"还没开始"，圈本身就是"按这里开始"。 */
    function paintMarkState() {
      const k = busy ? 'run' : (state === 'done' ? 'done' : (state === 'error' ? 'bad' : 'idle'));
      btnGen.setAttribute('data-mark', k);
    }

    function applyUiFrom(c) {
      const ui = (c && c.ui) || HT.DEFAULT_UI;
      HT.applyUi(panel, ui);
      paintMark();
      /* 分段开关的高度 / 内边距可能刚变过，滑块要重新贴一次（不动画） */
      placeThumb(false);
    }

    /* 短名只有一份：dom.js 的 UI_STATE[态].label。
       这里只补「为什么」与灯色，不再各写一个词——以前胶囊「未登录」、
       状态栏「未登录」，同一个人在两处看到两种说法。 */
    const SN = k => (STATE[k] && STATE[k].label) || '';

    function setState(s) {
      state = STATE[s] ? s : 'checking';
      nav.setState(state);
      refreshTip();
      refreshGates();
      refreshEmpty();
      /* 离开「已校验」就把校验下拉收起：里面说的是上一轮的结果，
         留在屏上会被当成这一轮的。 */
      if (state !== 'done' && CK) CK.hide();
      if (state === 'checking') setFoot(SN('checking'), '');
      else if (state === 'nologin') setFoot(SN('nologin'), 'warn', '未登录，登录后自动启用');
      /* 没到条件时间不是错误：按钮照样能取上一周期，只是取的不是今天。
         所以是黄圈叹号，不是红圈——红只留给真的出错。 */
      else if (state === 'pending' && cfg && cfg.baseAt)
        setFoot(SN('pending'), 'warn', '这个条件时间还没到，查询会拿不到数据');
      else if (state === 'pending') setFoot(SN('pending'), 'warn', '未到条件时间，现在查询取的是上一周期');
      else if (state === 'ready') setFoot(SN('ready'), 'ok', '已经过了条件时间，可以查询');
      else if (state === 'running') setFoot(SN('running'), 'run', '正在查询…');
      else if (state === 'done') setFoot(SN('done'), 'ok');
      /* 这一条只是占位：真正的原因由调用方 catch 里的 setFoot(errInfo(e).card.foot…) 覆盖，
         同一帧内完成，界面上看不到「出错」。不在这里写分类文案——
         错误文案的来源只有 data/errors.js 一处。 */
      else if (state === 'error') setFoot(SN('error'), 'bad');
    }

    /* 状态文案只写到读屏能读到的地方（入口的 aria-label），不弹自绘提示框。
       倒计时撤掉之后这里不再每秒变一次，只随状态走。 */
    function refreshTip() {
      nav.setTip('');
    }

    /* ── 开合 ─────────────────────────────────────────────── */
    const isOpen = () => panel.classList.contains('open');

    /* 面板位置：入口长在站点导航里，位置是固定的，面板却可以拖到屏幕上任何地方。
       一个天天要看的东西，位置被写死等于每次都要把视线移到别人替你选的地方。
       所以这里单独记一份 {x, anchor, bottom|top}，下次打开回到原处；
       没记过（或者「记住位置」关着）就落在入口正下方再往左铺开。 */
    const GEOM = HT.geom;
    const viewW = GEOM.viewW;
    const viewH = GEOM.viewH;
    const clampN = GEOM.clampN;
    const EDGE = GEOM.PANEL.EDGE;      // 贴边留白，与默认位置一致
    const SNAP_PX = GEOM.PANEL.SNAP;   // 松手时距上下边多少像素内才贴边
    const GRAB = GEOM.PANEL.GRAB;      // 拖动时距视口边的最小留白
    /* {x, anchor, bottom|top}。三种量说的是同一件事的三个自由度：
         x       横向位置，**自由**（只在离左右边 10px 内才贴边）
         anchor  纵向锚哪条边：bottom = 下沿钉住往上长，top = 上沿钉住往下长
         bottom/top 那一条边距视口多少
       横向不是 side：存"贴左还是贴右"的话，拖到屏幕中间也会被拽回边。
       面板是看稿子、对照网页的地方，停在中间是正常用法，所以横向改成像素坐标。
       纵向仍要 anchor：面板高度随内容变，只靠一个 bottom 反推的话，
       每加一行字顶边就往上飘一点。 */
    let panelPos = null;
    /* 从存储里读回来、还没用上的那份位置（首次打开面板时认领） */
    let storedPanel = null;

    /** 面板当前（或应有的）宽度：关着时 offsetWidth 仍是布局宽度，
        取不到就按 CSS 那条 min(400px, 100vw-32px) 算。 */
    function panelW() {
      return panel.offsetWidth || Math.min(400, viewW() - 32);
    }

    /* 面板高度上限 = min(设计的 78vh, 那一侧还剩多少空间)。
       只写死 78vh 是不够的：面板若贴着底边往上长，一旦它被拖到屏幕中部、
       或者窗口被缩矮，78vh 就会把顶部顶到视口外——标题栏、关闭按钮、生成按钮
       一起消失，人只会看到半块面板挂在屏幕上方，还以为界面"无限伸缩"了。 */
    const PANEL_MIN = GEOM.PANEL.MIN;  // 再挤也要放得下标题栏 + 一行内容
    const PANEL_PAD = GEOM.PANEL.PAD;  // 面板与视口上下的呼吸
    let fitTimer = null;
    /* 面板是往上长还是往下长。默认"下沿锚定、向上长"（钮在面板下面）；
       钮被拖到屏幕上部、上方放不下一个最小面板时，翻到钮下面往下长——
       像下拉菜单在底部翻上去那样。早先的做法是把面板硬压下来，
       副作用是收起面板时钮被一起拽下来，"位置记不住"就是这么来的。 */
    let panelAnchor = 'bottom';

    function fitPanelBox() {
      /* 怎么算在 geom.js（纯函数，verify 用假 rect 验算）；这里只负责
         读当前状态、把结果写回样式，不做算术。 */
      const tall = !!(setOpen || (F && F.isOpen()));
      const box = GEOM.fitBox({
        vh: viewH(),
        tall: tall,
        pos: panelPos,
        anchor: panelAnchor,
        styleTop: parseFloat(panel.style.top),
        focus: !!(S && S.isFocus()),
        /* 一段都没有就是空态：下限换成 440，否则点开只有一条缝。
           有段落（哪怕全收起）仍按 200，收起后不留一大片空白。 */
        empty: !outBox.querySelector('.ht-item')
      });
      panel.style.maxHeight = box.max + 'px';
      panel.style.minHeight = box.floor + 'px';
      /* 浮层（设置 / 问答）必须有**确定高度**：里面的 .st-body 是靠 flex:1
         分到高度才滚得动的。只给 max-height 时面板高度仍是 auto，flex:1
         等于"照内容铺开"，内容一长就溢出被裁——1366×768 的笔记本上，
         第一屏之外的设置项看得见一半、滚轮一动不动。正文态不给定高：
         空态要保持那条缝，定高会铺出一整块空白。 */
      panel.style.height = tall ? box.max + 'px' : '';
      return box.max;
    }

    function applyPanelPos() {
      if (!panelPos) { panelAnchor = 'bottom'; fitPanelBox(); return; }
      /* 窗口缩小后存下来的 x 可能已经出界：夹回可用范围再写，
         否则面板会一半挂在视口外。 */
      panelPos.x = GEOM.clampN(Number(panelPos.x) || EDGE, GRAB,
        Math.max(GRAB, viewW() - panelW() - GRAB));
      panel.style.left = Math.round(panelPos.x) + 'px';
      panel.style.right = 'auto';
      /* 落位与"往哪边长"的推导在 geom.layout：吸顶、贴底、装不下时翻转，
         三条分支都在那儿，调用方只管把返回的 top/bottom 写进样式。 */
      const at = GEOM.layout({ vh: viewH(), pos: panelPos });
      panelAnchor = at.anchor;
      panel.style.top = at.top == null ? 'auto' : at.top + 'px';
      panel.style.bottom = at.bottom == null ? 'auto' : at.bottom + 'px';
      fitPanelBox();
    }

    /**
     * 把面板的位置记下来。入口长在站点导航里、位置固定，面板拖到哪儿它推不出来，
     * 所以必须单独存一份。
     * 「记住位置」关掉就删掉这把键（不是"不写"——不写会被上次的旧值读回来）。
     */
    function savePanelPos() {
      if (!panelPos) return;
      try {
        if (cfg && cfg.rememberPos === false) {
          g.chrome.storage.local.remove('panelPos');
          return;
        }
        g.chrome.storage.local.set({
          panelPos: {
            x: Math.round(panelPos.x),
            anchor: panelPos.anchor,
            bottom: panelPos.bottom == null ? null : Math.round(panelPos.bottom),
            top: panelPos.top == null ? null : Math.round(panelPos.top)
          }
        });
      } catch (e) { }
    }

    /** 复位：忘掉存下来的位置，重新落到入口正下方（设置页「复位」走这里） */
    function resetPanelPos() {
      panelPos = GEOM.panelPosFromAnchor({
        rect: nav.rect(), width: panelW(), vw: viewW(), vh: viewH()
      });
      storedPanel = null;
      try { g.chrome.storage.local.remove('panelPos'); } catch (e) { }
      applyPanelPos();
    }

    let pDrag = null;

    function movePanel(e) {
      if (!pDrag || e.pointerId !== pDrag.id) return;
      const dx = e.clientX - pDrag.x0;
      const dy = e.clientY - pDrag.y0;
      if (!pDrag.moved) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < 5) return;
        pDrag.moved = true;
        panel.classList.add('is-dragging');
      }
      const r = panel.getBoundingClientRect();
      const left = clampN(pDrag.left + dx, GRAB, Math.max(GRAB, viewW() - r.width - GRAB));
      const top = clampN(pDrag.top + dy, GRAB, Math.max(GRAB, viewH() - r.height - GRAB));
      panel.style.left = left + 'px';
      panel.style.top = top + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      if (e.cancelable) e.preventDefault();
    }

    function endPanelDrag(e) {
      if (!pDrag || (e && e.pointerId !== pDrag.id)) return;
      document.removeEventListener('pointermove', movePanel, true);
      document.removeEventListener('pointerup', endPanelDrag, true);
      document.removeEventListener('pointercancel', endPanelDrag, true);
      panel.classList.remove('is-dragging');
      if (pDrag.moved) {
        /* 松手后浏览器会补一个 click；标题行把它当"点标题"就会立刻折叠。
           60ms 足够盖住这一次，又不影响下一次真正的点击。 */
        suppressClick = true;
        setTimeout(() => { suppressClick = false; }, 60);
        const r = panel.getBoundingClientRect();
        /* 三条路（吸顶 / 贴底 / 对齐网格）都在 geom.snapPanel 里，阈值 10px */
        panelPos = GEOM.snapPanel({ rect: r, vw: viewW(), vh: viewH() });
        panel.classList.add('is-snapping');
        applyPanelPos();
        setTimeout(() => panel.classList.remove('is-snapping'), 340);
        savePanelPos();
      }
      pDrag = null;
    }

    /* 拖拽把手有两处，不是一个：
       列表态是面板标题栏（那里空、横条长，最好抓）；
       专注态标题栏被收起了，顶上只剩这一段自己的标题行——它就是这一态
       唯一能抓的横条。不接上它，专注进去以后面板再也拖不动，
       而专注恰恰是最想把面板挪开对照网页的时候。
       抓着标题行拖完松手，浏览器还会补一个 click，那一下不能当成"点标题折叠"，
       否则每拖一次就收起来一次，所以留一个很短的抑制窗口。 */
    let suppressClick = false;

    function inDragHandle(t) {
      if (!t || !t.closest) return false;
      if (t.closest('button, input, select, textarea, a')) return false;
      if (head.contains(t)) return true;
      return !!t.closest('.ht-item.is-focus .hd');
    }

    panel.addEventListener('pointerdown', e => {
      if (e.button !== 0 || !isOpen()) return;
      if (!inDragHandle(e.target)) return;
      const r = panel.getBoundingClientRect();
      pDrag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, left: r.left, top: r.top, moved: false };
      document.addEventListener('pointermove', movePanel, true);
      document.addEventListener('pointerup', endPanelDrag, true);
      document.addEventListener('pointercancel', endPanelDrag, true);
    });

    /* 窗口被缩放：上限得跟着重算，否则缩到一半窗口，面板顶部又跑到视口外 */
    g.addEventListener('resize', () => {
      /* 瞬时提示是按"按下那一刻的标题栏宽度"算的左偏移（见 hint），
         窗口一变那个数就过期了——窄下来之后它会顶出面板右侧，
         把整块面板撑出一条横向滚动条，看起来像面板坏了。
         它只活 1.6 秒，缩放时直接收掉并归零位置（hideHint(true)），
         比重新算一遍便宜。 */
      hideHint(true);
      /* 条件时间编辑框是**按打开那一刻的矩形算的坐标**：窗口一变，它的 left/top
         就过期了（窄下来之后可能悬在面板外面）。它只活几秒，直接收回比重算稳当。 */
      if (baseEditing()) closeBaseEdit();
      clearTimeout(fitTimer);
      fitTimer = setTimeout(() => {
        if (!isOpen() && !panelPos) return;
        fitPanelBox();
      }, 120);
    });

    function openPanel() {
      /* 先确认界面还长在页面上。站点重建 body / 登录后整块重挂时，#ht-root
         会被一起删掉，而入口是由 nav 自己重建的——于是"图标在、图标会亮、
         面板永远不出来"，反复点也没用：每次都作用在一个已经脱离文档的节点上。
         自愈放在打开前，是因为这是唯一"人正等着看结果"的时刻。 */
      try { if (HT.ensureUI) HT.ensureUI(); } catch (e) { }
      if (isOpen()) return;
      /* 位置只有一个真相：存过就回到存的地方，没存过就落在入口「数据」正下方。
         三层优先级，**不能合并**：
           ① panelPos    —— 本次会话里拖过，内存里这份是最新的；
           ② storedPanel —— 上次会话存下来的（启动时读回来，只认领一次）；
           ③ 默认落位    —— 从 nav.rect() 现算。
         早先这里只有 ③，因为面板位置是"从悬浮钮的位置推"出来的，钮自己会持久化；
         入口固定之后钮没了，漏掉 ① 就会出现"拖完关掉再开，回到原处"。
         「记住位置」关掉时既不读也不写，每次打开都落回默认位。 */
      const remember = !cfg || cfg.rememberPos !== false;
      if (remember && panelPos) {
        /* 本次会话里拖过：内存里这份就是最新的，不动 */
      } else if (remember && storedPanel) {
        panelPos = {
          x: Number(storedPanel.x),
          anchor: storedPanel.anchor === 'top' ? 'top' : 'bottom',
          bottom: storedPanel.bottom == null ? null : Number(storedPanel.bottom),
          top: storedPanel.top == null ? null : Number(storedPanel.top)
        };
      } else {
        panelPos = GEOM.panelPosFromAnchor({
          rect: nav.rect(), width: panelW(), vw: viewW(), vh: viewH()
        });
      }
      storedPanel = null;
      applyPanelPos();
      nav.setActive(true);          // 入口留在原地，只标一个"开着"的状态
      panel.classList.remove('closing');
      panel.removeAttribute('inert');
      panel.classList.add('open');
      showMeta();
      startTick();
      probeLogin();
      try { panel.focus({ preventScroll: true }); } catch (e) { }
    }

    function closePanel(restoreFocus) {
      if (!isOpen()) return;
      /* 面板收起时把专注、问答、设置一并收掉：下次打开应当是干净的列表，
         否则会看到"只剩一段"或"停在设置里"却想不起自己点过什么 */
      F.close();
      closeSettings(false);
      S.exitFocus();
      panel.classList.remove('is-dim');     // 下次打开不该是淡的
      panel.classList.remove('open');
      panel.classList.add('closing');
      panel.setAttribute('inert', '');
      nav.setActive(false);
      stopTick();
      setTimeout(() => panel.classList.remove('closing'), HT.prefersReduced() ? 0 : 150);
      if (restoreFocus) { try { nav.el.focus({ preventScroll: true }); } catch (e) { } }
    }

    const togglePanel = () => (isOpen() ? closePanel(true) : openPanel());

    /* ── 问答浮层（ui/faq.js）────────────────────────────────
       口径、术语、校验项说明、导出差异、界面操作，全在那一块里；
       它自己持开关状态、自己绑标题栏那颗「?」、搜索框与「返回」。
       面板只把"打开前先关掉设置"这件事交过去（互斥的另一半在这里）。
       ─────────────────────────────────────────────────────── */
    F = HT.mountFaq({
      el: faqEl,
      input: fqInput,
      nav: fqNav,
      list: fqList,
      cnt: fqCnt,
      btn: btnHelp,
      back: $('ht-fqback'),
      body: body,
      esc: esc,
      throttled: throttled,
      fitBox: fitPanelBox,
      closeOther: () => { if (setOpen) closeSettings(false); }
    });

    /* ── 设置（面板内浮层）──────────────────────────────────
       0.9 是独立标签页：点齿轮跳走一页，改完还得自己回来。
       这不是"设置"该有的样子——它和问答一样，只是同一块地方换个内容看。
       所以改成浮层：位置、进出方式、Esc 行为全部与问答一致，
       唯一区别是它里面挂的是 settings.js（独立设置页也用同一份）。
       ───────────────────────────────────────────────────── */
    function openSettings() {
      F.close();
      S.exitFocus();
      setOpen = true;
      setVeil.show();
      btnCfg.setAttribute('aria-expanded', 'true');
      body.scrollTop = 0;
      if (!settingsView) {
        settingsView = HT.mountSettings(setView, {
          /* 「恢复默认 / 保存」挂到头部右上角（见 PANEL_HTML 里那段注释） */
          head: $('ht-setacts'),
          /* 「复位到右下角」：让钮当场回位；面板还开着不动，收起后自然落在钮上方 */
          onPanelReset: () => {
            resetPanelPos();
          },
          onSaved: c => {
            cfg = c;
            S.applyFont(cfg.focusFont);
            applyUiFrom(c);
            if (cfg.rememberPos === false) {
              storedPanel = null;
              try { g.chrome.storage.local.remove('panelPos'); } catch (e) { }
            }
            showMeta();
            refreshAnchor();
            refreshTip();
            HT.clearCache();
            try { HT.siteHider.setCfg(cfg); } catch (e) { }
            /* 稿子已经在手上就当场重排，别让人为了看效果再点一次生成 */
            repose(cfg);
          },
          /* 拖滑杆时的即时预览（1.12.16）：标题栏就在设置浮层上面，看得见。
             只改这一轮的观感，不落盘——点保存才算数；收起时若没保存，
             closeSettings 会按 cfg 再画回来。 */
          onUi: ui => {
            HT.applyUi(panel, ui);
          }
        });
      } else {
        settingsView.refresh().then(() => settingsView.scrollTop());
      }
      fitPanelBox();
    }

    function closeSettings(restore) {
      if (!setOpen) return;
      setOpen = false;
      /* 收起之后再算高度：若在淡出的 130ms 里就把面板压回正文高度，
         浮层会在还剩一半不透明时被裁掉一截——看着像"闪了一下"。 */
      setVeil.hide(fitPanelBox);
      btnCfg.setAttribute('aria-expanded', 'false');
      /* 滑杆的预览没保存就收起：按存下来的那份画回来。
         否则"看了一眼没保存"的效果会一直挂在面板上，直到下次重载。 */
      if (cfg) applyUiFrom(cfg);
      if (restore) { try { btnCfg.focus({ preventScroll: true }); } catch (e) { } }
    }

    const toggleSettings = () => (setOpen ? closeSettings(true) : openSettings());

    btnCfg.addEventListener('click', () => { if (!throttled('cfg', 240)) toggleSettings(); });
    $('ht-setback').addEventListener('click', () => closeSettings(true));

    /* 「?」按钮、搜索框、「返回」的监听都跟着问答浮层去了 faq.js（0.25.0） */
    /* ── 登录与截点 ───────────────────────────────────────── */
    const loginReady = () => {
      try { return HT.loginInfo().ready; } catch (e) { return false; }
    };

    /* ── 票据寿命 ───────────────────────────────────────────────
       站点发给浏览器的是一张 JWT（字段只有 sub / exp / userid / iat），
       签发那一刻写下 30 分钟。这个数只记"什么时候签的"，**不是登录有效期**。

       2026-11-21 重新实测（抓包 + 站点业务包 + 八天诊断日志）：

         · 同一张票，票面过期 42 分钟后打了 16 个请求，全部 200；
         · 11-15 从 00:36 到 18:14 成功出稿 25 次，01:54 做完、08:16 隔夜
           再开还是成功，当天没有一次被送到登录页；
         · 站点自己也不续签：业务包里只有登录成功那一处写 token，别处只读；
           存下的 refreshToken 全站没有一处读它；
         · 真要重登，是第二天首次打开被重定向到 /login。

       所以登录没有可预测的到期时刻，票面时间与能不能取数无关。这里因此不做
       倒计时——上一版「剩 4 分」提醒的是个不影响使用的时刻，只会把人支去白跑。
       只有两种情况出字：

         1. 页面里读不到票，或取数真被拒（401/403、响应不是 JSON）——
            状态字转「未登录」，整块状态可点，点了开新标签去登录，
            原标签一个字不动，登录完这一轮自己接着跑（pendingRun）；
         2. 云端配置从没同步成功——那是另一件事，排在票据之后。

       也不在入口上加红点/角标——入口是站点导航的克隆体，多一个点就不像原生的。 */
    const SESS_POLL = 1500;             // 等登录时多久看一眼存储
    const SESS_WATCH = 15 * 60 * 1000;  // 最多等这么久，然后收手
    let sessTimer = null;
    let pendingRun = false;             // 有一轮被"凭证被拒"打断，登录完接着跑
    /* 这一轮**真的被服务端拒过**。票面 exp 过去不算——exp 过去仍能取数，
       只有 401/403 才算。它决定状态可不可点、要不要提示去登录。 */
    let authDead = false;
    /* 本机从没成功同步过、最近一次还失败了。这时屏上正文是按初始模板生成的，
       不是云端那份——不说出来，人会以为自己在用云端配置出稿。
       只多一句提示，不拦任何操作、不加可点区域。 */
    let cloudMiss = false;

    const sessLife = () => {
      try { return HT.loginInfo(); } catch (e) { return null; }
    };
    /**
     * 重画状态字后面的小尾巴，以及状态本身可不可点。
     *
     * 只有两种情况会多写字：
     *   · 云端配置没同步成功 → 「未同步」（陈述，不可点）
     *   · 确实没票 / 票被拒  → 不写字，改成整块状态可点（悬停有说明）
     * 其余时候这个位置是空的，标题栏宽度一点不变。票面时间不在这里显示——
     * 它只记签发那一刻，与能不能取数无关。
     *
     * 不重建整块 DOM：showMeta() 是整块重写 innerHTML，而它会被轮询调到，
     * 拿它来刷倒计时等于把人正在操作的东西每半分钟抹一次。
     */
    function paintSess() {
      if (!stSess) return;
      const li = sessLife();
      const noTicket = !li || !li.hasToken || li.onLoginPage;
      const dead = noTicket || authDead;

      if (dead) {
        stSess.hidden = true;
        stSess.textContent = '';
        stEl.classList.add('is-act');
        stEl.title = noTicket
          ? '这个页面里读不到站点票据，点这里去登录'
          : '票据被拒（凭证已失效），点这里去登录';
        return;
      }

      /* 配置这行排在票据之后：没票是「现在做不了」，配置不对是「做出来的可能不是你想要的」，
         前者更急。两者同时成立先说票。 */
      if (cloudMiss) {
        stSess.hidden = false;
        stSess.textContent = '未同步';
        stEl.classList.remove('is-act');
        stEl.title = '这台机器还没取回云端那份配置，当前正文按初始模板生成。'
          + '网络恢复后会自动重试；也可以在设置页点「立即同步」。';
        return;
      }

      stSess.hidden = true;
      stSess.textContent = '';
      stEl.classList.remove('is-act');
      stEl.title = footTip;
    }

    /**
     * 「屏上这份可能不是云端那份」要不要说出来。
     *
     * 判据只有两条同时成立：从没成功同步过（`at` 为空）＋ 最近一次确实失败（`fail` 有值）。
     * 到这一步，正文就是按初始模板生成的，不提示的话人不会知道。
     *
     * 三种情况故意不提示：
     *   · 云端本来就是空的（首次使用）：初始模板就是该用的那份，吓人没道理；
     *   · 自动同步被关掉：那是使用者自己的选择，设置页已经写明「只存本机」；
     *   · 成功过一次（`at` 有值）：这次没传上用的也是上次那份，不是初始模板。
     */
    function refreshCloudMiss() {
      if (!HT.cloud || !HT.cloud.readMeta) return;
      HT.cloud.readMeta().then(m => {
        const next = !m.at && !!m.fail && m.auto !== false;
        if (next === cloudMiss) return;
        cloudMiss = next;
        paintSess();
      }).catch(() => { });
    }

    /** 去站点登录。新开一个标签，原标签不动——原标签里是已经写好的稿子。 */
    function sessGo(anchor) {
      const url = String((HT.ORIGIN || '') + '/');
      try { g.open(url, '_blank', 'noopener'); } catch (e) { /* 被拦就自己开标签 */ }
      hint('已打开站点，登录后回来查询', anchor || btnGen);
      watchSess();
    }

    /**
     * 等新票据。只读 localStorage，不发任何请求——票据是同一 origin 的，
     * 在另一个标签登录之后这里立刻就能看见。
     */
    function watchSess() {
      if (sessTimer) return;
      const before = HT.token();
      const t0 = Date.now();
      sessTimer = setInterval(() => {
        const li = sessLife();
        const t = HT.token();
        if (li && li.ready && t && t !== before) { stopSess(); onRelogin(); return; }
        if (Date.now() - t0 > SESS_WATCH) stopSess();
      }, SESS_POLL);
    }
    function stopSess() { clearInterval(sessTimer); sessTimer = null; }

    /** 换了一张票：缓存作废，界面归位，被打断的那一轮接着跑。 */
    function onRelogin() {
      HT.clearCache();
      authDead = false;
      const li = sessLife();
      hint('已恢复登录', btnGen);
      paintSess();
      probeLogin();
      /* 人点过生成、被一句"凭证被拒"打断：登录回来就该接着跑，
         再问一次"要重新取数吗"等于把刚才那一下点击作废。 */
      if (pendingRun) { pendingRun = false; if (!busy) generate(); }
    }

    function probeLogin() {
      const ok = loginReady();
      if (state === 'running') return ok;
      if (ok) {
        if (state !== 'done' && state !== 'error') {
          let passed = true;
          try { passed = HT.anchorStatus(new Date(), cfg || {}).passed; } catch (e) { }
          setState(passed ? 'ready' : 'pending');
        }
      } else {
        setState('nologin');
      }
      return ok;
    }

    /* ── 两个时间 ─────────────────────────────────────────── */
    /** 两行：条件时间与查询时间。
        条件时间是**这一轮取数用的时间条件**——它是取数的右端，也是「截至…」那句
        公文的写法，点开就能改（补前天的数、按 17:30 结账）。
        查询时间是**按下查询的那一刻**，一次取数只写一次，不随进度跳。
        前者回答"查的是哪一段"，后者回答"什么时候查的"。 */
    function queryAtText() {
      if (!queryAt) return '—';
      const d = queryAt;
      return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日` +
        `${d.getHours()}时${pad(d.getMinutes())}分`;
    }

    /** 这一轮是「每日」还是「每周」。只有一个来源：配置里的 period。
        读处一律走这个函数，不在各自的地方各判一次 `=== 'week'`——
        那样以后加第三种周期（比如月度）时要改十几处。 */
    const periodOf = () => (cfg && cfg.period === 'week' ? 'week' : 'day');

    /** 「日报 / 周报」。导出成功的提示里要说清这一份是哪套周期导的：
        两者窗口常常落在同一个日期段，光看文件名分不出来。 */
    const perCn = () => (periodOf() === 'week' ? '周报' : '日报');

    /** 最近一次取数用的那一刻。读数以它为准，不跟墙钟走。
     *
     *  为什么需要它：截点轮询（pollAnchor）每秒重画一遍标题栏，而墙钟一跨过
     *  18:00，「条件时间」就自己往后跳一天——正文还是上一轮取的 11-23 那一段，
     *  读数却已经写着 11-24，两句并排放着各说各的（2026-11-24 实测：
     *  周报查询途中正好跨过 18:00，导出的文件名是 11.23-11.23，
     *  而面板上写着 11-24 18 时）。
     *  读数是「这一轮取的是哪一段」，所以它跟本轮走；状态字才是「现在能不能查」，
     *  那个继续跟墙钟（refreshAnchor 负责）。 */
    let roundNow = null;
    const metaAt = () => (lastRun && roundNow ? roundNow : new Date());

    /** 画标题栏两行读数与周期开关。
     *  窗口按 metaAt() 算：有稿按出稿那一刻，没稿按现在。
     *  改了条件时间/周期的地方要把 roundNow 推到当下——那一刻的窗口还没取过，
     *  读数该显示"下一轮会取哪一段"，而不是刚取完的那一段。 */
    function showMeta() {
      let W;
      try {
        W = HT.buildWindows(metaAt(), cfg, periodOf());
      } catch (e) {
        rangeBox.innerHTML = '<dt>条件时间</dt><dd>时间配置有误</dd>';
        return;
      }
      closeBaseEdit();
      /* 标题栏里只有两行读数，都是"这一轮取的是哪一段"：
           条件时间  这一轮按哪一刻结算（点它可改，改完下次取数生效）
           查询时间  真正按下查询的那一刻（同一次取数只写一次，不逐秒跳）
         统计周期不在这里——它是开关不是读数，紧挨着查询按钮放（1.12.8）。
         两行都交给 showMeta 现画：窗口跟着条件时间与周期一起变。 */
      rangeBox.innerHTML =
        '<div class="rw"><dt>条件时间</dt><dd>' +
        `<button type="button" id="ht-base" class="ht-base${W.explicit ? ' is-set' : ''}"` +
        ` aria-label="条件时间 ${esc(W.queryText)}，点击修改">` +
        `${esc(W.queryText)}<i aria-hidden="true">▾</i></button></dd></div>` +
        '<div class="rw"><dt>查询时间</dt><dd>' +
        `<span class="q">${esc(queryAtText())}</span></dd></div>`;
      /* 这一轮的窗口区间挂在容器上，不挂 title：标题栏不要悬停黑框（1.12.13），
         但自检要能读到"点周之后窗口确实换了"——data-win 不显示、不打断视线，
         也是调试时唯一能一眼看出"现在取的是哪一段"的地方。 */
      rangeBox.dataset.win = W.dayRange;
      /* 周期开关：两颗按钮就是两套模板的开关，切换会把窗口换成对应的那一段
         （当日 24 小时 / 本周一至今）。不带「统计周期」四个字——
         标题栏没有第二行给它，而"日｜周"本身已经说明了维度。
         （1.12.11）从「每日 / 每周」压成「日 / 周」：两颗两字按钮在标题栏里
         占 84px，压到 52px 之后，读数那一块能多出两个字的位置给完整日期，
         而"日 / 周"在"统计周期"这个分组里不会有第二种读法。
         （1.12.13）连 title 一起撤了：标题栏是常驻的一条，鼠标划过就冒出一个
         黑框，比它给出的那点信息更吵。完整说法留在 aria-label 里给读屏用。
         （1.12.16）两颗按钮底下加一块会滑的滑块（rubber segment）：换项时
         它先横跨新旧两格、末端越过一点再弹回来。滑块只在第一次画时建一次，
         之后 tick 每秒重画标题栏也不会把它冲掉。 */
      paintPer();
      /* 下拉上沿贴着标题栏下沿：标题栏高度随字号会变，写死在 CSS 里
         遇到大字号就会压住状态那一行，所以按实测高度挪。 */
      ckPop.style.top = (head.offsetHeight + 2) + 'px';
      paintSess();
    }

    function paintPer() {
      const per = periodOf();
      if (!perBox.querySelector('.ht-thumb')) {
        /* 滑块里那两份字是按钮的副本：底是强调色，副本用反白，
           滑块盖住哪一格，哪一格就"反色"了——参考实现就是这么做的，
           比"底下垫一块白、字另外变色"更稳：拉伸到一半时两格都只反一半。 */
        perBox.innerHTML = '<i class="ht-thumb" aria-hidden="true">' +
          '<span class="ht-per-copy">日</span><span class="ht-per-copy">周</span></i>' +
          '<button type="button" data-per="day"' +
          ' aria-label="统计周期：日（条件时间往前 24 小时）">日</button>' +
          '<button type="button" data-per="week"' +
          ' aria-label="统计周期：周（本周一 0 时至条件时间）">周</button>';
      }
      perBox.querySelectorAll('[data-per]').forEach(b => {
        b.classList.toggle('on', b.getAttribute('data-per') === per);
        b.setAttribute('aria-checked', b.getAttribute('data-per') === per ? 'true' : 'false');
      });
      /* 只有"周期真的变了"才滑：重画标题栏（存盘、状态字变化）也会走到这里，
         每次都滑一遍等于每次都在动，人分不清哪一下才是他自己点的。 */
      const prev = perBox.getAttribute('data-per');
      perBox.setAttribute('data-per', per);
      placeThumb(prev !== null && prev !== per);
    }

    /** 把滑块贴到当前选中的那一格；animate=false 时直接落位 */
    function placeThumb(animate) {
      const t = perBox.querySelector('.ht-thumb');
      if (!t) return;
      const el = perBox.querySelector('[data-per].on');
      if (!el) return;
      HT.slideThumb(perBox, t, el, !!animate);
      /* 贴好之后才显形：建出来到贴位之间那一帧，裁剪窗口还没算，会闪一下整条底 */
      t.classList.add('is-placed');
    }

    /** 展开编辑：在「条件时间」那一行**原位**浮出一层编辑框，两行读数一个字都不动。
     *
     *  为什么不做成"整块读数脱出标题栏"（1.12.9）：那样点一下时间，条件时间与
     *  查询时间两行会一起搬进浮层、再搬回来，正是"改一个值，动了两行"。
     *  这里只浮编辑框，读数留在原处，人还能对着「查询时间」核"上一轮是什么时候查的"。
     *
     *  位置按被点那一行的矩形现算（.ht-head 是 position:relative，用它的坐标系）：
     *    left  值左缘往左收一个内边距，让输入框里的字与原来的值左对齐
     *    top   标题栏下沿减 1 —— **压在正文顶上，不压读数**。
     *          贴着「条件时间」那一行的下沿（+2）确实更像"原位置"，
     *          但那样正好盖住下面那行「查询时间」：编辑时最想核对的
     *          "上一轮是什么时候查的"偏偏被自己挡住。所以往下让一行，
     *          两行读数一个不遮、一个不挪，浮层从读数块底下探出来。
     *  浮层宽 236、高约 84，右边放不下就往左收，绝不给自己拉出横向滚动条。 */
    function openBaseEdit() {
      let W;
      /* 与读数同一个时刻：读数写着 11-23 18 时，点开就该是 11-23 18 时 */
      try { W = HT.buildWindows(metaAt(), cfg, periodOf()); } catch (e) { return; }
      const rw = rangeBox.querySelector('.rw');
      const dd = rw && rw.querySelector('dd');
      if (!rw || !dd) { showMeta(); return; }
      closeBaseEdit();            // 连点两下不叠第二层
      /* 用 template 拼，而不是 createElement + innerHTML 两段：
         id 写在 HTML 串里，自检脚本的"面板引用的 id 都有定义"那条才认得出
         这个后建的节点（它只扫 id="…" 字面量）。 */
      const tplBp = document.createElement('template');
      tplBp.innerHTML =
        '<div class="ht-bpedit" id="ht-bpedit" role="dialog" aria-label="改条件时间">' +
        `<input type="datetime-local" step="1" class="bp-in" id="ht-basein" value="${W.baseAt}"` +
        ' aria-label="条件时间">' +
        '<span class="bp-acts">' +
        '<button type="button" data-bp="ok">确定</button>' +
        `<button type="button" data-bp="auto"${W.explicit ? '' : ' disabled'}>跟随每天</button>` +
        '<button type="button" data-bp="cancel">取消</button>' +
        '</span></div>';
      const box = tplBp.content.firstElementChild;
      head.appendChild(box);
      rw.classList.add('is-editing');
      /* 先读几何、后写字：offsetWidth 要等它进 DOM 才有值 */
      const hr = head.getBoundingClientRect();
      const dr = dd.getBoundingClientRect();
      const bw = box.offsetWidth || 236;
      const pad = parseFloat(getComputedStyle(box).paddingLeft) || 0;
      let left = dr.left - hr.left - pad;
      const maxLeft = hr.width - bw - 4;
      if (left > maxLeft) left = maxLeft;
      if (left < 4) left = 4;
      box.style.left = left + 'px';
      box.style.top = (hr.height - 1) + 'px';
      const inp = box.querySelector('#ht-basein');
      if (inp) { inp.focus(); try { inp.select(); } catch (e) { } }
    }

    /** 收回编辑框。只摘浮层与那一行的 is-editing，读数本身不动。 */
    function closeBaseEdit() {
      const old = $('ht-bpedit');
      if (old) old.remove();
      const on = rangeBox.querySelector('.rw.is-editing');
      if (on) on.classList.remove('is-editing');
    }

    /** 编辑框开着没有。Esc 与"点外面"两处都要问它。 */
    const baseEditing = () => !!$('ht-bpedit');

    /** 写回条件时间。空串 = 回到自动（每天 18:00），这是「跟随每天」按的 */
    async function applyBase(v) {
      const next = HT.normBaseAt(v);
      cfg.baseAt = next;
      try {
        await HT.saveCfg(cfg);
      } catch (e) {
        hint('条件时间没存上：' + HT.ERR_CARD.STORAGE.foot, btnGen);
        showMeta();
        return;
      }
      /* 窗口变了，上一次取数的缓存必须作废——否则点刷新拿回来的还是旧窗口的数 */
      HT.clearCache();
      /* 改的是"下一轮按哪一刻结算"，读数要跟着走到新值：
         把 roundNow 推到当下，metaAt() 才不会还拿上一轮那一刻重画读数。 */
      roundNow = new Date();
      showMeta();
      refreshEmpty();
      refreshAnchor();
      let msg = '已跟随每天 18:00';
      try { msg = '条件时间已改到 ' + HT.buildWindows(new Date(), cfg, periodOf()).baseText; } catch (e) { }
      hint(msg, btnGen);
    }

    /**
     * 换统计周期：每日 ↔ 每周。
     *
     * 两件事一起做，缺一件都会让人以为点了没反应：
     *   1. 记进配置（下次打开还停在原来的周期——出周报那两天不必每次再切）；
     *   2. 已经有稿子就**按新周期重取一份**。留着上一周期的正文最危险：
     *      上面写着「每日」而下面是周报的数，或者反过来，看着完全正常。
     *
     * 缓存也要清：窗口从 24 小时变成一周，同一批缓存的响应全都不作数了。
     */
    async function setPeriod(p) {
      const next = p === 'week' ? 'week' : 'day';
      if (periodOf() === next) return;
      cfg.period = next;
      /* 滑块由 paintPer 比对 data-per 决定滑不滑：改完 cfg 再 showMeta，
         滑块自己会滑过去；写失败时按钮会被改回来，滑块跟着回去——
         两个方向都看得见"这一下没成"。 */
      try {
        await HT.saveCfg(cfg);
      } catch (e) {
        hint('周期没存上：' + HT.ERR_CARD.STORAGE.foot, btnGen);
        showMeta();
        return;
      }
      HT.clearCache();
      /* 周期换了 = 下一轮要取的是另一段，读数立刻按现在的时刻算。
         不推 roundNow 的话，pollAnchor 与 storage 回调会拿上一轮的时刻重画，
         刚切过去的"周"在读数里看不出来。 */
      roundNow = new Date();
      showMeta();
      if (lastRun && !busy) {
        /* 不提示"已切换"——马上就开始取数了，进度条本身就在说这件事 */
        generate();
        return;
      }
      hint(next === 'week' ? '已切到每周，点查询取本周数据' : '已切到每日，点查询取当日数据', btnGen);
    }

    /* 打开期间每秒走一次，只为在跨过截点那一刻把「未到点」翻成「已就绪」。
       不重建 DOM（那会让入场动画每秒重放），只比一次时间。
       票据小尾巴不跟着走——它说的是状态变化，不是分钟的流逝。 */
    let tickTimer = null;
    function startTick() {
      if (tickTimer) return;
      tickTimer = setInterval(() => {
        if (!isOpen()) return;
        let passed = false;
        try { passed = HT.anchorStatus(new Date(), cfg || {}).passed; } catch (e) { }
        if (passed && state === 'pending') refreshAnchor();
      }, 1000);
    }
    function stopTick() { clearInterval(tickTimer); tickTimer = null; }

    function refreshAnchor() {
      if (busy || state === 'running' || state === 'error' || state === 'nologin' || state === 'done') return;
      let st;
      try { st = HT.anchorStatus(new Date(), cfg || {}); } catch (e) { return; }
      if (!st.passed && state === 'ready') setState('pending');
      else if (st.passed && state === 'pending') setState('ready');
    }

    /* ── 段落区（ui/sections.js）──────────────────────────────
       列表怎么排、怎么折、怎么专注、字多大，全部搬去了 sections.js
       （0.25.0）。留给面板的是**壳**：开合、标题栏、状态、进度、用户下拉。
       这里只把依赖交出去，参数表见 HT.mountSections 的注释。
       ─────────────────────────────────────────────────────── */
    S = HT.mountSections({
      box: outBox,
      panel: panel,
      body: body,
      icon: HT.ICON,
      fontOf: () => Number(cfg && cfg.focusFont) || 15,
      saveFont: n => {
        /* 字号只是顺手记住，写不进去不该打扰人；但也不能留一个未处理的 Promise */
        if (!cfg) return;
        cfg.focusFont = n;
        HT.saveCfg(cfg).catch(() => { });
      },
      throttled: throttled,
      onEdit: () => { editedAfterGen = true; },
      refreshGates: refreshGates,
      fitBox: fitPanelBox,
      suppressed: () => suppressClick
    });

    /* ── 校验栏（ui/checks.js）───────────────────────────────
       列表怎么画、只看问题还是全看、展开还是收起，都在那边；
       面板只负责"结果来了就 render、换人了就 clear、查询中先 hide"。
       点某一行的「?」由这里转给问答浮层（校验栏不知道该跳哪一条）。
       ─────────────────────────────────────────────────────── */
    CK = HT.mountChecks({
      sec: ckPop,
      /* 折叠按钮就是标题栏那一行状态：只有「已校验」时它才可点，
         其余状态由 checks.js 按 aria-disabled 拦下（见那边的 click 处理）。 */
      tog: stEl,
      ic: $('ht-ckic'),
      box: ckBox,
      rt: ckRt,
      segRoot: shadow,
      esc: esc,
      throttled: throttled,
      /* 从下拉里点某一条 → 进问答。先把下拉收起：问答翻开的是正文那块地，
         两层叠着只会让人不知道该按哪个返回。 */
      onAsk: key => { if (CK && CK.isOpen()) CK.toggle(); F.open('', key); }
    });

    const currentSegs = () => [...outBox.querySelectorAll('textarea')].map(t => t.value).filter(Boolean);
    const currentText = () => currentSegs().join('\n\n');

    /* ── 复制与导出 ───────────────────────────────────────── */
    /* 导出的时间窗取自本轮结果（lastRun.window.day），不是"现在"——
       跨过结算点再点导出，导的仍该是稿子那一段。串形如
       '2026-11-20 18:00:00'，解析成 Date；解不出返回 null，不猜。 */
    function dayWinOf(r) {
      const w = r && r.window && r.window.day;
      if (!w || w.length < 2) return null;
      const one = v => {
        const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
        return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
      };
      const a = one(w[0]), b = one(w[1]);
      return a && b ? { s: a, e: b } : null;
    }

    /* 存文件与写剪贴板都不在这儿了：feedback.js 的 HT.download / HT.copyText
       是唯一出口。这两件事面板与设置页都要，各写一份时连 revoke 的延时都不同。 */

    /* ── 防连点 ───────────────────────────────────────────── */
    /* 纯计时，不参与外观：这段时间里点「生成」只会浮一句「请稍候」，
       按钮照常是蓝色的。冷却期间再灰一次，用户分不清是加载还是冷却。 */
    function startCooldown(sec) {
      clearTimeout(coolTimer);
      cooling = false;
      if (!sec) return;
      cooling = true;
      coolTimer = setTimeout(() => { cooling = false; }, sec * 1000);
    }

    /* ── 错误态 ───────────────────────────────────────────── */
    /**
     * 红框 + 一个「把现场带走」的按钮。
     *
     * 两处调用（取数失败、配置读不到）原来各写一遍，措辞与 DOM 迟早会漂；
     * 现在只此一份。
     *
     * 按钮复制的不是页面上的数字，是最近的自检记录（短码 + 模块 + 校验项名）
     * 加上版本与浏览器。所以这份东西发出去不需要先打码——这是它敢存在的前提。
     * 记录本身由 lib/obs.js 落盘，这里只负责把这一次也记进去。
     */
    function showError(e) {
      const info = HT.errInfo(e);
      setBar(100, 'bad');
      setState('error');
      setFoot(info.card.foot, 'bad', info.card.tip);
      /* 1.2 起没有「上报诊断」这个按钮了：出错就自动发，不问也不打扰。
         发出去的只有短码、模块名、校验项名、版本与环境——没有起数、没有区域、
         没有模板正文。发不出去也什么都不说：正文顶上已经写着错在哪，
         再加一句"上报没成功"只是噪音，还要人去点一个按钮。 */
      outBox.innerHTML = HT.errHTML(e, esc) +
        '<p class="ht-fbnote">这次的现场已自动发回维护人员（只有错误码和版本，没有数字和稿子）</p>';
      try { HT.obs.note({ code: info.card.code, mod: 'panel', fact: info.fact }); } catch (e2) { }
      try {
        HT.diagSend(info.line, 'auto').catch(() => { });
      } catch (e3) { }
      return info;
    }

    /* ── 生成 ─────────────────────────────────────────────────────
       分两半：runOnce 只取数、不碰 DOM；paintRun 只画、不再发请求。
       拆开的原因不是"函数太长"，是原来这两件事缠在一起时，
       任何一次渲染改动都得先读懂取数链路，取数分支也没法单独跑。 */

    /** 取数：返回 report.run 的结果。除 onProgress（转给进度条）外不碰界面。 */
    async function runOnce() {
      cfg = await HT.loadCfg();
      showMeta();
      /* 按钮叫「重新取数并成文」，点了就是要新数——先把 http 层那 5 分钟缓存清掉。
         不清的话，上一轮之后 5 分钟内再点，全部命中缓存、一个请求都不发，
         正文与刚才一字不差（2026-11-16 实测：用户点刷新以为没反应）。
         只在这里清、不在 http 层清：run 内部多个源共用同一响应，过程中仍该命中，
         否则同一次出稿会把 JQ_01 拉两遍。 */
      /* 这一轮按哪一刻算窗口，只在这里取一次：run 用它取数、标题栏用它显示、
         导出用它命名文件——三处必须是同一刻，否则跨过 18:00 就各说各的。 */
      const now = new Date();
      roundNow = now;
      HT.clearCache();
      const r = await HT.run({
        now, cfg,
        /* 周期显式传下去：run 内以调用方为准（配置刚改、还没读回来的那一瞬
           也按面板上现在选的那个跑），窗口与模板都跟着它走。 */
        period: periodOf(),
        onProgress: (i, n, label) => {
          setBar(i / n * 100);
          /* 状态栏只留三个字，明细进 title：一会儿「3/7 拉取…」一会儿变，版面会抖 */
          setFoot(SN('running'), 'run', `${label} · ${i}/${n}`);
        }
      });
      return r;
    }

    /** 把一次结果画出来。t0 只用于"用时 N 秒"那一行。 */
    function paintRun(r, t0) {
      S.render(r.items);
      lastRun = r;
      editedAfterGen = false;
      /* 校验不过的项目记进本机缓冲。这一次不过、下一次还不过，才是信号；
         单次偶发不该去报修。列表与复制在设置页「诊断」，不占面板位置。
         记在这里而不是 report.js 里：domain 只算不写，它把该记的东西以
         plain object 的形式放在 meta.obs 里，写盘是这里的动作。 */
      if (r.meta.obs && r.meta.obs.length) {
        try { r.meta.obs.forEach(o => HT.obs.note(o)); } catch (e2) { }
      }
      if (r.checks.length) CK.render(r.checks, r.summary);
      /* 旁支数据没取到（某一列缺失、某段没返回）时，句子会短一截。
         不拦着出稿，但必须在正文顶上说出来，不能让它悄悄变短。 */
      if (r.meta.notices && r.meta.notices.length) {
        const bar = document.createElement('div');
        bar.className = 'ht-notice';
        bar.innerHTML = `<b>以下数据本次未取到</b>` +
          r.meta.notices.map(n => `<span>${esc(n)}</span>`).join('');
        outBox.insertBefore(bar, outBox.firstChild);
      }
      /* 运行统计：这次用了几段、发了几个请求、几项没过、总共多久。
         只记结构与时长，不记任何一个数字——想知道的不是"今天几起"，
         是"哪个版本慢、哪个数据源总要翻页、校验是不是老不过"。
         行业里这一层是 Sentry 的 transaction / Crashlytics 的会话：
         光有错误文本，看不出"大家都慢"和"只有他慢"的区别。 */
      try {
        HT.obs.note({
          code: 'GEN-OK', mod: 'panel', kind: 'use',
          fact: `seg=${(r.items || []).length}`
            + ` req=${r.meta.requests || 0}`
            + ` chk=${(r.checks || []).length}`
            + ` bad=${(r.summary && r.summary.failed) || 0}`
        });
        /* 每源耗时：一轮就看清分布，不必反复试。
           只写源名与秒数，不含任何业务数字，这张记录截图发出去也不泄密。 */
        const tms = r.meta.times || null;
        const durs = tms
          ? ' t=' + Object.keys(tms)
            .map(k => k + ':' + Math.round(tms[k] / 1000))
            .join(',')
          : '';
        HT.obs.note({
          code: 'GEN-DUR', mod: 'panel', kind: 'perf',
          /* 带上最慢的那条源、它花了多久、几个并发：只报总数时，看日志的人
             知道"慢"，不知道"哪儿慢"、"慢多少"，也就没法决定该改缓存、
             改并发还是改翻页。 */
          fact: `req=${r.meta.requests || 0}`
            + (r.meta.slow ? ` slow=${r.meta.slow.src}/${Math.round(r.meta.slow.ms / 1000)}s` : '')
            + (r.meta.conc ? ` c=${r.meta.conc}` : '')
            + durs,
          dur: Date.now() - t0
        });
        /* 发走，不等回执：这条链路不该让出稿多等一毫秒 */
        g.chrome.runtime.sendMessage({ type: 'tgFlush', why: 'panel' }, () => {
          try { void g.chrome.runtime.lastError; } catch (e2) { }
        });
      } catch (e2) { }

      const sec = (Date.now() - t0) / 1000;
      const secText = sec < 10 ? sec.toFixed(1) + 's' : Math.round(sec) + 's';
      finishBar(r.summary.failed ? 'warn' : 'ok');
      /* 取数跑通了 = 票一定还能用。把上一轮留下的"被拒"标记清掉，
         否则状态字会一直挂着可点的样子去劝人重登。 */
      authDead = false;
      setState('done');
      /* 出稿后重算一次上限与下限：正文从'一段都没有'变成'四段'，
         空态那条 440 的下限该让开了，上限也要跟着当前落位重算。
         以前只在开面板时算一次，结果是'生成完高度不动、拖一下才变'。 */
      fitPanelBox();
      const now = new Date();
      const tm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
      /* 状态只有三个字：已校验。有没有待核项由圆点的颜色说（绿 / 橙），
         具体哪几项要核对，点开这一行看下拉——状态字不再为"过没过"另起一个词，
         否则标题栏里会出现第四个字的读数，比三个字难扫。 */
      setFoot(SN('done'), r.summary.failed ? 'warn' : 'ok',
        `${tm} 查询 · ${r.meta.requests > 0 ? r.meta.requests + ' 次请求' : '缓存命中'} · 用时 ${secText}` +
        (r.summary.failed ? ` · ${r.summary.failed} 项数字对不上，请核对后再上报` : ''));
      try { g.chrome.storage.local.set({ lastDay: now.toISOString().slice(0, 10) }); } catch (e) { }

      /* ── 报表互校：出稿已经给了，这条在后台跑 ──────────────────────
         为什么不等它：它要再发两次请求（明细 + 报表），报表那边十几秒起步。
         稿子该什么时候出来就什么时候出来，校验晚几秒补上是可以的。
         回来先确认"期间没重新出稿"，否则会把上一次的数贴到新稿子上。
         失败一律静默，只记一条遥测：拿不到报表不该让使用者以为稿子有问题。 */
      if (!r.cross) return;
      r.cross().then(item => {
        if (!item || lastRun !== r) return;
        r.checks.push(item);
        const jd = r.checks.filter(x => !x.note);
        r.summary.total = jd.length;
        r.summary.failed = jd.filter(x => !x.ok).length;
        r.summary.passed = jd.length - r.summary.failed;
        r.summary.notes = r.checks.length - jd.length;
        CK.render(r.checks, r.summary);
        if (r.summary.failed) {
          setFoot(SN('done'), 'warn',
            `${tm} 查询 · 报表口径互校有 1 项对不上，请核对后再上报`);
        }
      }).catch(e => {
        try {
          HT.obs.note({
            code: 'RPT-CROSS', mod: 'panel', kind: 'err',
            fact: String((e && (e.code || e.message)) || 'err')
          });
        } catch (e2) { }
      });
    }

    async function generate() {
      busy = true;
      refreshGates();          // 查询中：生成按钮直接置灰，进度只走标题栏那条线
      F.close();
      closeSettings(false);
      S.exitFocus();
      CK.hide();
      outBox.innerHTML = '<div class="ht-empty">正在取数…</div>';
      setState('running');
      setBar(4);
      const t0 = Date.now();
      /* 查询时间就在按下这一下写定。原来这一格放的是"取到的那一段"，
         与上面的条件时间在没过点时差一天，两个值都在说时间窗口，
         反而看不出"什么时候查的"。 */
      queryAt = new Date(t0);
      showMeta();

      try {
        paintRun(await runOnce(), t0);
      } catch (e) {
        /* 九类错必须分开说，因为处置动作完全不同：
             页面没好 → 等/刷新；结构变了 → 别等了，手工上报并报修；网络 → 换网重试；
             超时 → 过会儿再来；未归类 → 直接报修。
           统一一句"获取失败"，使用者只能反复点，不知道该干什么。
           措辞、短名、要不要印原始描述全部由 data/errors.js 决定，这里只负责画。 */
        const info = showError(e);
        if (info.kind === 'AUTH') {
          /* 这是**唯一**能断定"票真的不能用了"的时刻：服务端回了 401/403，
             或者响应根本不是 JSON（已经被重定向到登录页）。票面 exp 过期不算。
             authDead 一置，状态字可点、悬停说明也换成"点这里去登录"。 */
          authDead = true;
          setState('nologin');
          /* 被票据打断：记下"这一轮人是要取数的"，登录回来自己接着跑。
             不记这一笔的话，人得重新找一遍刚才点的是哪个按钮。 */
          pendingRun = true;
          watchSess();      // 只等，不开标签——去登录由点状态那一下决定
        }
        paintSess();
      } finally {
        busy = false;
        refreshGates();          // 取数一结束立刻恢复蓝色，不等冷却
        startCooldown(cfg ? cfg.cooldownSec : 3);
      }
    }

    /* ── 设置保存后就地重排 ───────────────────────────────────
       以前保存只做了"换个 cfg 对象、清缓存"，稿子还是上一版：
       改完单位名/并区域/勾的起火原因/手填的那两句，回到主界面一个字都不变，
       得再点一次「生成」——而重生成要重新拉八个数据源、等四十多秒。
       更糟的是那个等待会被当成"设置没生效"，于是反复保存。
       这里拿 lastRun 里的同一批数重新成文，数字一个不动，只换措辞。
       ─────────────────────────────────────────────────────── */
    function repose(c) {
      if (!lastRun || typeof lastRun.repaint !== 'function' || !S) return false;
      let res;
      try {
        res = lastRun.repaint(c, HT.buildWindows(new Date(), c, periodOf()));
      } catch (e) {
        /* 重排失败就保持原样：正文还在，用户点的是一次设置，不该连稿子一起丢 */
        return false;
      }
      /* 手改过的那几段原样留着。设置管的是"程序怎么拼"，管不到人写的话；
         拿重排结果盖掉，等于用一次点选把手工润色抹掉，这种"聪明"最招人烦。
         对齐用**段落的 key**，不是位置：设置里调一次顺序，按位置对齐就会把
         "第一段的手改"贴到刚挪上来的那一段身上——顺序越调越乱。 */
      const prev = lastRun.items || [];
      const hand = Object.create(null);
      [...outBox.querySelectorAll('textarea')].forEach((t, k) => {
        const p = prev[k];
        if (!p) return;
        if (t.value !== p.text) hand[p.key != null ? p.key : '#' + k] = t.value;
      });
      const items = res.items.map((it, k) => {
        const h = hand[it.key != null ? it.key : '#' + k];
        if (h === undefined) return it;
        const copy = Object.assign({}, it);
        copy.text = h;
        return copy;
      });
      /* 段顶那条"以下数据本次未取到"是 DOM 插进去的，重绘会连它一起清掉 */
      const nb = outBox.querySelector('.ht-notice');
      const nbHTML = nb ? nb.outerHTML : '';
      S.render(items);
      if (nbHTML) outBox.insertAdjacentHTML('afterbegin', nbHTML);
      lastRun.items = items;
      if (res.checks && res.checks.length) CK.render(res.checks, res.summary);
      fitPanelBox();
      return true;
    }

    /* ── 事件 ─────────────────────────────────────────────── */
    nav.onClick = () => {
      if (throttled('fab', 180)) return;
      if (state === 'nologin') nav.nudge();
      togglePanel();
    };

    $('ht-close').addEventListener('click', () => closePanel(true));

    /* 状态本身是登录入口：没票 / 票被拒 / 快到期时点它就去站点登录
       （`is-act` 由 paintSess 加，平时不可点、光标也不变）。
       不另设一颗按钮——标题栏这一行已经没有空位，而「未登录」本身就是那句话。 */
    stEl.addEventListener('click', () => {
      if (!stEl.classList.contains('is-act')) return;
      sessGo(stEl);
    });

    /* 条件时间那一行 + 周期开关：点开编辑、确定/跟随每天/取消、日↔周。
       用**标题栏**级别的委托，不用 rangeBox 的：（1.12.8）把周期开关搬出
       #ht-range 之后，它的 [data-per] 再也冒不到 rangeBox 上——日/周两颗按钮
       整整三个版本点着没反应（1.12.11 修）。委托挂在 .ht-head 上，
       以后标题栏里再加什么，只要还在这条 bar 里就接得住。
       编辑框也是 head 的子节点（绝对定位的浮层），一起走这条委托。 */
    head.addEventListener('click', e => {
      const act = e.target.closest('[data-bp]');
      if (act) {
        const how = act.dataset.bp;
        if (how === 'cancel') { showMeta(); return; }
        if (how === 'auto') { applyBase(''); return; }
        const inp = head.querySelector('#ht-basein');
        const v = inp ? inp.value : '';
        if (!HT.normBaseAt(v)) { hint('这个时间不成立，检查一下日期与时分', inp || act); return; }
        applyBase(v);
        return;
      }
      const per = e.target.closest('[data-per]');
      if (per) { setPeriod(per.getAttribute('data-per')); return; }
      if (e.target.closest('#ht-base')) openBaseEdit();
    });
    /* 输入框里回车 = 确定；Esc 先收回编辑态（面板的 Esc 是收起面板，
       这里要抢在它前面，否则改了一半的输入框直接消失） */
    head.addEventListener('keydown', e => {
      if (!baseEditing()) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        const inp = head.querySelector('#ht-basein');
        if (inp && HT.normBaseAt(inp.value)) applyBase(inp.value);
        else if (inp) hint('这个时间不成立，检查一下日期与时分', inp);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeBaseEdit();
      }
    });

    /* 点面板外空白处收起。三个必须条件：
       ① 设置里 closeOnOutside 开着（默认开；关掉后只认右上角 × 和 Esc）
       ② 点的不在面板里、也不在入口上 —— pointerdown 先于 click 到达 document，
          漏掉面板就会变成"点任何按钮都把面板关掉，然后操作打在隐藏面板上"
       ③ 不在查询中——**这一条去掉了**。

       为什么去掉 ③：取数不会因为面板收起而中断，它本来就在后台跑完、
       把结果写进 outBox，人再打开就能看到；状态栏里那三个字也还在。
       留着它反而制造了一个看不见的坑：屏幕上显示「查询中」的那几分钟里，
       点外面一点反应都没有，而设置里「点面板外关闭」明明是开着的——
       用户只会认为这个开关坏了。要打断取数有它自己的入口，不该靠"点了没反应"。 */
    function canCloseOutside() {
      if (!isOpen()) return false;
      return !(cfg && cfg.closeOnOutside === false);
    }

    /** 点外面之后的收尾。专注态也照收：早先留了"专注时不响应"的例外，
        理由是一边看网页一边改字，但实际用起来分不清"点漏了"和"设计如此"，
        点了没反应只会让人以为界面卡住；要对照着改，面板本来就不挡视线。 */
    /** 专注态点外面只变淡，不收起。
        人进专注多半是在对着网页核数：一点旁边整块不见，回来要重新进专注、
        光标也回不到原处，分不清是"手滑"还是"设计如此"。
        普通态仍是收起——列表本来就是一瞥即走的界面，留着反而是挡路。 */
    function setDim(on) {
      if (on && !S.isFocus()) return;
      panel.classList.toggle('is-dim', !!on);
    }

    function collapseFromOutside() {
      if (!canCloseOutside()) return;
      /* 专注态这一下做什么，交给设置里的「专注失焦」决定：
         开着（默认）只变淡——进专注多半是在对着网页核数，一点旁边整块不见，
         回来要重新进专注、光标也回不到原处；
         关掉就收起，跟普通态一样。有人就是不喜欢半透明的字。
         开关在设置页「显示」，改完立即生效（cfg 是同一个对象）。 */
      if (S.isFocus() && !(cfg && cfg.focusDim === false)) { setDim(true); return; }
      closePanel();
    }

    /* 手一碰面板就恢复不透明：变淡只是"我现在没在用你"，不是一层灰罩子 */
    panel.addEventListener('pointerdown', e => {
      if (panel.classList.contains('is-dim')) setDim(false);
      /* 点菜单以外的地方把菜单收掉。按钮自己那一下交给 click 去开合，这里跳过，
         否则 pointerdown 先收、click 再开，永远打不开。 */
      if (expOpen && !HT.inPath(e, expMenu) && !HT.inPath(e, btnExp)) closeExp();
      /* 校验下拉同理：点它自己那一行不算"点外面"，否则同样是先收后开。 */
      if (CK && CK.isOpen() && !HT.inPath(e, ckPop) && !HT.inPath(e, stEl)) CK.toggle();
      /* 条件时间编辑框：点到框外就收回（点 #ht-base 除外——那一下是"再点一次改"，
         先收再开等于整块闪一下）。它浮在正文上面，不收回就会一直挂在那儿，
         而人往往接着就去改正文了。 */
      if (baseEditing() && !HT.inPath(e, $('ht-bpedit')) && !HT.inPath(e, $('ht-base'))) closeBaseEdit();
    }, true);

    document.addEventListener('pointerdown', e => {
      if (e.button !== 0 || !canCloseOutside()) return;
      if (HT.inPath(e, panel) || HT.inPath(e, nav.el)) return;
      collapseFromOutside();
    }, true);

    /* 页面主体挂在 iframe 里时（政务站十有八九如此），外层 document 根本收不到
       pointerdown —— 点在 iframe 里，事件在另一个文档里跑，这边一点动静都没有，
       于是"点哪儿都不收起"。Chrome 也不给父文档派发 focusin（实测只把
       document.activeElement 指到 iframe 上），唯一还留着的是 window blur：
       焦点进了 iframe，顶层 window 就失焦，此刻 activeElement 正好是那个 iframe。
       切标签页、点地址栏同样会 blur，但那时 activeElement 不是 iframe，天然挡掉。 */
    g.addEventListener('blur', () => {
      if (!canCloseOutside()) return;
      setTimeout(() => {
        if (!canCloseOutside()) return;
        const ae = document.activeElement;
        if (!ae || String(ae.tagName).toUpperCase() !== 'IFRAME') return;
        collapseFromOutside();
      }, 0);
    });

    /* 有的内核会在 iframe 拿焦点时给父文档补一个 focusin，能收到就更快一步 */
    document.addEventListener('focusin', e => {
      const t = e.target;
      if (!t || String(t.tagName).toUpperCase() !== 'IFRAME') return;
      if (!canCloseOutside()) return;
      collapseFromOutside();
    }, true);

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        /* 逐层退出：校验下拉 / 导出菜单 / 设置 / 问答 → 专注 → 面板。一个 Esc 撤一层 */
        if (CK && CK.isOpen()) { CK.toggle(); return; }
        if (expOpen) { closeExp(); return; }
        if (setOpen) { closeSettings(true); return; }
        if (F.isOpen()) { F.close(true); return; }
        if (S.isFocus()) { S.exitFocus(); return; }
        if (isOpen()) closePanel(true);
        return;
      }
    });

    btnGen.addEventListener('click', () => {
      if (busy) { hint('正在取数', btnGen); return; }
      if (!loginReady()) { hint('请先登录', btnGen); nav.nudge(); return; }
      if (cooling) { hint('请稍候', btnGen); return; }
      generate();
    });

    /* 复制与导出**不看登录态**：它们只读屏幕上已经有的字，一个请求都不发。
       以前这里各有一道 `if (!loginReady())`，后果是票据一过 30 分钟，
       连"把写好的稿子拷出来"都点不动——正好在最该抢救的时候把出口关掉。
       真正需要登录的是取数（btnGen），不是拿走已经写好的东西。 */
    btnCopy.addEventListener('click', async () => {
      /* 置灰时什么都不做，也不弹提示：按钮已经说明白了（见 refreshGates 的 title） */
      if (gated()) return;
      if (throttled('copy', 900)) return;
      /* 复制与导出用同一套待核附注：文件出了这台机器就没人知道它没通过核对，
         剪贴板出去的这一份同样如此。附注用〔〕括起，与正文一眼可分。
         exportNote 是函数声明，写在后面也能用（同一作用域内提升）。 */
      const copyNotes = exportNote();
      const copyBody = copyNotes.length
        ? currentText() + '\n\n' + copyNotes.join('\n')
        : currentText();
      const ok = await HT.copyText(copyBody);
      /* 成功给按钮变对勾，失败才补一句为什么 —— 成功是个"已发生"的事实，
         用不着拿一行深色小字压在第一段正文上。 */
      HT.flashBtn(btnCopy, ok ? '已复制' : '复制失败', ok);
      if (!ok) hint('复制失败：请手动全选', btnCopy);
      /* 复制走剪贴板，塞不进提示行——但至少要在这里说一声，
         免得人以为"复制出来的就是校验过的"。 */
      else if (lastRun && lastRun.summary && lastRun.summary.failed) {
        hint(`${lastRun.summary.failed} 项待核，附注已随正文复制`, btnCopy);
      }
    });

    /* 导出就是导出 txt：一个按钮、一个动作、一个文件。
       0.11 之前点它先弹一个四项菜单（复制纯文本 / 复制到 Word / .txt / .doc），
       一半的功能标题栏里已经有了，另一半（.doc）本质是 HTML 改后缀。
       现在只留一条最常用的路，点一下直接落地成 txt。

       校验未过时**照旧导出**（使用者可能就是要先拿走再核），但必须在两处留痕：
       文件名带「待核」、文末附一行提示。之前这些信息只活在面板里，
       文件出了这台机器就没人知道它没通过核对。 */
    function exportNote() {
      const r = lastRun;
      const bad = r && r.summary ? r.summary.failed : 0;
      const lines = [];
      if (bad) {
        const keys = (r.checks || []).filter(c => !c.ok).map(c => c.name || c.key);
        lines.push(`〔校验提示：${bad} 项数字未通过核对${keys.length ? '——' + keys.slice(0, 6).join('、') + (keys.length > 6 ? ' 等' : '') : ''}。本稿按现状导出，未阻断，请核对后再上报。〕`);
      }
      if (editedAfterGen) {
        lines.push('〔校验提示：正文在生成后经过手动修改，校验结论针对修改前的内容。〕');
      }
      return lines;
    }

    /* 导出的是「综合查询 → 查条目」那张明细表，不是正文——正文用复制。
       表由站点服务端生成，这里只发一次请求、把回来的字节原样存盘，
       所以文件与手点导出是同一份（2026-11-21 实测 sheet1 逐字节相同）。
       原来这里导出 txt：那份东西没人用，而正文本来就能复制。 */
    /* ── 导出：两份表 ────────────────────────────────────────
       一份是「综合查询 → 查条目」的明细清单，由站点服务端直接出文件；
       一份是正文那句起火原因对应的分原因分等级统计表，由网页前端出文件。
       两份都不常用，所以共用一个 ⇩，点开选一份。 */
    const expMenu = $('ht-expmenu');
    /* 高亮块（1.12.16）：菜单从图标那一角长出来，指针在两行之间滑时
       底下那块跟着滑；指针离开回到上一次停的那一行。行高、宽度、两个时长
       都是设置页「界面 · 导出菜单」里的参数（CSS 变量，见 panel.css）。 */
    const expGlide = HT.mountGlide ? HT.mountGlide(expMenu) : null;
    /* expOpen 是"逻辑上开着"，expMenu.hidden 是"画面上没了"：
       收起有一段 120ms 的淡出，这段时间元素还在，不能拿 hidden 当状态——
       否则这 120ms 里点 ⇩ 会被当成"已经关了"，菜单反而打不开。 */
    let expOpen = false;
    let expTimer = 0;

    function closeExp() {
      if (!expOpen) return;
      expOpen = false;
      btnExp.setAttribute('aria-expanded', 'false');
      if (expGlide) expGlide.close();
      expMenu.classList.remove('is-open');
      expMenu.classList.add('is-closing');
      clearTimeout(expTimer);
      const cs = g.getComputedStyle(expMenu);
      const wait = (parseFloat(cs.getPropertyValue('--ui-menu-pop-out')) || 120) + 20;
      expTimer = setTimeout(() => {
        expMenu.classList.remove('is-closing');
        expMenu.hidden = true;
      }, wait);
    }

    function toggleExp() {
      if (expOpen) { closeExp(); return; }
      if (gated()) return;
      /* 菜单右缘对齐按钮右缘：两颗按钮之间还有齿轮与帮助，往左铺才不会盖住标题 */
      const pr = panel.getBoundingClientRect(), br = btnExp.getBoundingClientRect();
      expMenu.style.right = Math.max(8, Math.round(pr.right - br.right)) + 'px';
      expMenu.style.top = Math.round(br.bottom - pr.top + 6) + 'px';
      clearTimeout(expTimer);
      expMenu.classList.remove('is-closing');
      expMenu.hidden = false;
      /* 先落到"关着"那一帧，再加 is-open：同一个任务里直接加类，
         浏览器会把两帧合并，菜单是"啪"地出现而不是从 0.95 长到 1。 */
      void expMenu.offsetWidth;
      expMenu.classList.add('is-open');
      expOpen = true;
      btnExp.setAttribute('aria-expanded', 'true');
      if (expGlide) expGlide.open();
    }

    expMenu.addEventListener('click', e => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      e.stopPropagation();
      closeExp();
      if (b.getAttribute('data-act') === 'stat') exportStat();
      else exportList();
    });

    btnExp.addEventListener('click', toggleExp);

    /**
     * 明细清单：站点服务端生成的 xlsx，扩展只发一次请求、把字节原样存盘，
     * 所以文件与手点导出是同一份（2026-11-21 实测 sheet1 逐字节相同）。
     */
    async function exportList() {
      if (throttled('export', 900)) return;
      const win = dayWinOf(lastRun);
      if (!win) { hint('没有可导出的时间段', btnExp); return; }
      const cols = HT.exportColsOf(cfg);
      if (!cols.length) { hint('设置里没有勾选导出列', btnExp); return; }
      btnExp.setAttribute('aria-disabled', 'true');
      hint('正在导出…', btnExp);
      try {
        const got = await HT.fetchExport(win, cols);
        HT.saveBytes(got.name, got.bytes,
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        /* 下载这件事浏览器有自己的下载条，但它在页面底部、常常在视野外；
           按钮这次换对勾 + 变绿，是唯一发生在"刚点的那一下"上的确认。 */
        HT.flashBtn(btnExp, '已导出', true);
        /* 带上"日报 / 周报"：两者窗口常常落在同一个日期段（周窗口 11-23 0 时起、
           日窗口 11-23 18 时起，都是 11.23-11.24），文件名一模一样，
           浏览器只会在后面加个 (1)——事后分不清哪份是哪份。 */
        hint(`已导出 ${perCn()} ${got.name}`, btnExp);
      } catch (e) {
        HT.flashBtn(btnExp, '导出失败', false);
        const info = HT.errInfo(e);
        hint(info.card.tip || '导出失败', btnExp);
        /* 与取数同一套判法：只有真被拒（401/403、响应不是文件）才算票没了，
           状态字转「未登录」，点它去登录。票面时间过期不在此列。 */
        if (info.kind === 'AUTH') { authDead = true; setState('nologin'); paintSess(); }
      } finally {
        btnExp.removeAttribute('aria-disabled');
      }
    }

    /**
     * 统计报表：接口只回单元格与合并区，xlsx 由页面自己的导出模块写（见 page/rep.js）。
     * 这里因此是「取数 → 交给页面」，不碰字节、不拼表——站点改表样，扩展不用跟着改。
     */
    async function exportStat() {
      if (throttled('export', 900)) return;
      const win = dayWinOf(lastRun);
      if (!win) { hint('没有可导出的时间段', btnExp); return; }
      btnExp.setAttribute('aria-disabled', 'true');
      hint('正在导出…', btnExp);
      try {
        const got = await HT.fetchReportStat(win);
        /* 站点回的名字不带区间（`重庆市分原因分等级条目情况统计表`），
           日/周两份完全同名——明细清单至少还会被浏览器加上 (1)，
           报表连这个区别都没有，过两天打开文件夹根本认不出哪份是周报。
           这里按本轮实际取的那一段补上，写法与明细清单一致。 */
        const base = got.name.replace(/\.xlsx$/i, '');
        const span = HT.fmtDot(win.s) + '-' + HT.fmtDot(win.e);
        const title = /（[^（）]*）$/.test(base) ? base : `${base}（${span}）`;
        const r = await HT.pageExport({
          /* 页面那个导出函数自己补扩展名：传标题，不传文件名 */
          title,
          head: got.head, result: got.result, merges: got.merges,
          leftLine: got.leftLine,
          rangeStartRow: got.rangeStartRow, rangeStartCol: got.rangeStartCol
        });
        HT.flashBtn(btnExp, '已导出', true);
        hint(`已导出 ${perCn()} ${r.name || title + '.xlsx'}`, btnExp);
      } catch (e) {
        HT.flashBtn(btnExp, '导出失败', false);
        const info = HT.errInfo(e);
        hint(info.fact || info.card.tip || '导出失败', btnExp);
        if (info.kind === 'AUTH') { authDead = true; setState('nologin'); paintSess(); }
      } finally {
        btnExp.removeAttribute('aria-disabled');
      }
    }

    /* ── 版本 ─────────────────────────────────────────────── */
    /* 标题栏不再显示版本号：面板是从站点导航点进来的，名字与版本写在入口、
       设置页与更新提示里；占在标题栏只会把状态和动作挤向两边。
       「脚本与清单版本不一致」这一条仍然要留——它说明浏览器跑的可能是旧脚本，
       排查时第一眼要看的就是它，所以记进诊断缓冲，界面上不常驻。 */
    function showVersion() {
      let mfVer = '';
      try { mfVer = g.chrome.runtime.getManifest().version; } catch (e) { }
      if (mfVer && mfVer !== META.version) {
        try {
          HT.obs.note({
            code: 'VER-MISMATCH', mod: 'panel',
            fact: `script=${META.version} manifest=${mfVer}`
          });
        } catch (e) { }
      }
    }

    /* ── 外部变更 ─────────────────────────────────────────── */
    try {
      g.chrome.storage.onChanged.addListener((ch, area) => {
        if (area !== 'local') return;
        if (!ch.cfg) return;
        cfg = HT.normalizeCfg(ch.cfg.newValue);
        S.applyFont(cfg.focusFont);
        applyUiFrom(cfg);
        showMeta();
        refreshAnchor();
        refreshTip();
        HT.clearCache();
        try { HT.siteHider.setCfg(cfg); } catch (e) { }
        /* 这里不自动重跑取数：改一行设置就重新打一遍接口太贵，
           而且面板里的设置浮层正开着时重跑会把浮层关掉（generate 会 closeSettings）。
           云端取回了新配置才值得重排，那条走下面的 ht-cloud-pulled。 */
      });
    } catch (e) { }

    /* 云端取回了一份新配置（另一台机器改的）。开着面板就地把稿子重排一遍：
       模板换了，屏幕上还挂着旧措辞，人会以为"同步没生效"。
       只在浮层关着时重排——人正在设置页里打字，底下的稿子跟着跳没有意义。 */
    try {
      g.addEventListener('ht-cloud-pulled', () => {
        refreshCloudMiss();
        if (!isOpen() || setOpen || busy) return;
        HT.loadCfg().then(c => {
          cfg = c;
          S.applyFont(cfg.focusFont);
          applyUiFrom(cfg);
          showMeta();
          repose(cfg);
        }).catch(() => { });
      });
    } catch (e) { }

    /* ── 启动 ─────────────────────────────────────────────── */
    /* 面板位置单独存一把（键 panelPos）：拖到哪儿入口都推不出来，必须记。
       读回来的这份在打开面板时认领；「记住位置」关掉就不认（见 openPanel）。
       老版本存过 {side, bottom} 和 {x, anchor, at}——没有 x 的一律当作没存过，
       落回入口下方即可，不必为它们写迁移。 */
    try {
      g.chrome.storage.local.get(['panelPos'], r => {
        const p = r && r.panelPos;
        if (!p || !Number.isFinite(Number(p.x))) return;
        storedPanel = p;
      });
    } catch (e) { }

    showVersion();
    setState('checking');
    setBar(0);

    HT.loadCfg().then(c => {
      cfg = c;
      S.applyFont(cfg.focusFont);
      applyUiFrom(cfg);
      showMeta();
      probeLogin();
      try { HT.siteHider.setCfg(cfg); } catch (e) { }
      /* 页面一打开就对一次云端（cloud.js 自带 60 秒限流，多次触发不会重复请求）。
         往后延 1.5 秒：先让页面和面板自己起来，别和首屏抢带宽。 */
      setTimeout(() => {
        try { HT.cloud.boot().then(() => refreshCloudMiss()).catch(() => { }); } catch (e) { }
      }, 1500);
    }).catch(e => {
      /* 读不到配置就不该继续：用户改过的模板与出厂模板措辞可能完全不同，
         悄悄退回默认等于替人改稿。停在错误态，让人重开面板再试。
         渲染与取数失败共用同一个 showError —— 同一类错在一屏里出现两种长相，
         会让人以为是两个问题。 */
      showError(e);
    });

    /* ── 两个轮询 ───────────────────────────────────────────────
       都改成"跑完再排下一次"，而不是固定间隔的 setInterval：
       频率跟着"面板开没开"走——开着是人在用，关着只剩登录态要维护。
       内容脚本的生命周期等于这个标签页，所以没有"销毁"这一步；
       句柄留着是为了出问题时能停（`HT.__debug` 里不暴露，改代码才用得上）。 */
    let loginTimer = 0;
    let anchorTimer = 0;

    /* 登录态轮询：登录完成自动转可用，不必刷新页面 */
    function pollLogin() {
      try {
        if (!busy) {
          const ok = loginReady();
          if (ok && (state === 'nologin' || state === 'checking')) probeLogin();
          else if (!ok && (state === 'ready' || state === 'pending')) setState('nologin');
        }
        paintSess();      // 剩几分钟与忙不忙无关，查询中也要看得到
      } finally {
        /* 关着时降到和截点同一个节奏：灯色晚 30 秒变，没人看得出来；
           而每 2.5 秒读一次存储、跨一次扩展上下文，整天开着就是白耗。 */
        loginTimer = setTimeout(pollLogin, isOpen() ? HT.UI_MS.loginPoll : HT.UI_MS.anchorPoll);
      }
    }

    /* 截点轮询：跨过整点会自动从"未到点"变"已就绪" */
    function pollAnchor() {
      try {
        if (!busy) {
          refreshTip();
          if (isOpen()) {
            showMeta();
            refreshAnchor();
          } else if (state === 'pending') {
            let passed = false;
            try { passed = HT.anchorStatus(new Date(), cfg || {}).passed; } catch (e) { }
            if (passed) setState('ready');
          }
        }
      } finally {
        anchorTimer = setTimeout(pollAnchor, HT.UI_MS.anchorPoll);
      }
    }

    pollLogin();
    pollAnchor();

    const api = {
      open: openPanel,
      close: () => closePanel(false),
      setState,
      setFoot,
      setBar,
      version: META.version,
      /** 调试/预览用：停在查询中的某个进度 */
      debugBusy: (i, n, label) => {
        busy = true;
        setState('running');
        setBar(i / n * 100);
        setFoot(SN('running'), 'run', `${label} · ${i}/${n}`);
      },
      /** 调试/预览用：让第 n 段进入专注（`?pin=1`） */
      debugPin: n => {
        const item = outBox.querySelectorAll('.ht-item')[n || 0];
        if (!item) return false;
        const ta = item.querySelector('textarea');
        if (!ta) return false;
        S.enterFocus(item, ta);
        return true;
      },
      /** 调试/预览用：直接打开问答浮层（`?faq=1`） */
      debugFaq: () => { F.open(''); return true; },
      /** 调试/预览用：直接打开设置浮层（`?cfg=1`） */
      debugCfg: () => { openPanel(); openSettings(); return true; },
      /** 调试/预览用：把面板放到指定位置（`?pos=left:120`） */
      debugPos: (side, bottom) => {
        panelPos = {
          x: side === 'left' ? GEOM.PANEL.EDGE
            : Math.max(GEOM.PANEL.EDGE, viewW() - panelW() - GEOM.PANEL.EDGE),
          anchor: 'bottom',
          bottom: Number(bottom) || 70
        };
        applyPanelPos();
        return true;
      },
      /** 调试/预览用：复位到入口正下方（`?reset=1`） */
      debugReset: () => { resetPanelPos(); return true; },
      /** 调试/预览用：读回入口的视口矩形，用来核对面板是不是真的落在它下方 */
      debugNavRect: () => {
        const r = nav.rect();
        return r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null;
      }
    };
    HT.__debug = HT.__debug || {};
    HT.__debug.api = api;
    return api;
  };
})(typeof window !== 'undefined' ? window : globalThis);
