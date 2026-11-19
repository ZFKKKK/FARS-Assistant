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
 *   4. 状态栏：左边三个字说状态（未到点/取数中/已生成），明细与请求数退进 title。
 *      到截点的倒计时 0.19 已撤——截点写在主体的「基准时间」里，说一遍就够
 *
 * 交互约定
 *   · 按钮只有两态：可用 / 置灰。置灰**仍可点**，点一下就在这个按钮下方浮出四个字
 *     （请先登录 / 正在取数 / 请稍候），1.6 秒自己消失——不弹框、不做全局固定位置
 *   · 取数中把刷新按钮直接置灰，防止重复点；取数结束自动恢复
 *   · 关闭只有三个出口：× / Esc / 再点顶部「数据」；另外「点面板外空白处」按
 *     设置里的 closeOnOutside 决定要不要生效（默认开，取数中不响应）
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
        <!-- 标题栏左侧是产品名 + 版本号。1.2 起不再放"谁在用"——
             多用户档案撤掉了：同一台机器就是同一套配置，切人反而成了
             一个没人用的开关，还占着标题栏最显眼的位置。 -->
        <div class="ht-brand" id="ht-brand" title="简报助手">
          <b>简报助手</b><span class="ht-vv" id="ht-ver">v—</span>
        </div>
        <div class="ht-stat" id="ht-stat">
          <span class="st" id="ht-st"><i class="dt" aria-hidden="true"></i><b id="ht-stb">检测中</b><i class="ht-sts" id="ht-sts" hidden></i></span>
        </div>
        <span class="ht-sp"></span>
        <button class="ht-ico ht-gen" id="ht-gen" type="button" title="重新取数并成文"
                aria-label="生成" aria-disabled="true">${HT.ICON.refresh}</button>
        <button class="ht-ico" id="ht-copy" type="button" title="复制全部" aria-label="复制全部文字" aria-disabled="true">${HT.ICON.copy}</button>
        <button class="ht-ico" id="ht-exp" type="button" title="导出为 txt" aria-label="导出为 txt" aria-disabled="true">${HT.ICON.fileDown}</button>
        <button class="ht-ico" id="ht-cfg" type="button" aria-label="打开设置">${HT.ICON.gear}</button>
        <button class="ht-ico" id="ht-help" type="button" title="口径与常见问题" aria-label="打开口径与常见问题" aria-expanded="false">${HT.ICON.help}</button>
        <button class="ht-ico" id="ht-close" type="button" aria-label="收起面板（Esc）">${HT.ICON.x}</button>
        <div class="ht-hint" id="ht-hint" role="status" aria-live="polite"></div>
      </div>
      <div class="ht-hline" id="ht-hline"><i class="ht-hbar" id="ht-bar"></i></div>
      <div class="ht-body">
        <dl class="ht-range" id="ht-range"></dl>
        <div class="ht-ckbar" id="ht-cksec" hidden>
          <button class="ht-cktog" id="ht-cktog" type="button" aria-expanded="false" aria-controls="ht-checks">
            <i class="bar" aria-hidden="true"></i>
            <b>数据校验</b>
            <span class="rt" id="ht-ckrt"></span>
            <span class="car" aria-hidden="true">▾</span>
          </button>
          <span class="ht-seg" id="ht-ckseg" role="group" aria-label="校验显示范围">
            <button type="button" data-mode="issue">仅问题</button>
            <button type="button" data-mode="all" class="on">全部</button>
          </span>
        </div>
        <div class="ht-checks" id="ht-checks"></div>
        <div id="ht-out"><div class="ht-empty">${HT.ICON.ghost}<span>点刷新图标取数并成文</span></div></div>
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
    const NEED = ['ht-panel', 'ht-ver', 'ht-range', 'ht-hline', 'ht-bar', 'ht-out',
      'ht-cksec', 'ht-cktog', 'ht-checks', 'ht-ckrt', 'ht-hint', 'ht-st', 'ht-stb', 'ht-sts',
      'ht-gen', 'ht-copy', 'ht-exp', 'ht-faq', 'ht-fqinput', 'ht-fqlist', 'ht-fqcnt',
      'ht-help', 'ht-set', 'ht-setview', 'ht-cfg', 'ht-close'];
    const miss = NEED.filter(id => !$(id));
    if (miss.length) throw new Error('面板缺少节点：' + miss.join('、'));
    const panel = $('ht-panel');
    const verEl = $('ht-ver');
    const head = panel.querySelector('.ht-head');
    const rangeBox = $('ht-range');
    const hline = $('ht-hline');
    const bar = $('ht-bar');
    const outBox = $('ht-out');
    const ckSec = $('ht-cksec');
    const ckTog = $('ht-cktog');
    const ckBox = $('ht-checks');
    const ckRt = $('ht-ckrt');
    const hintEl = $('ht-hint');
    const stEl = $('ht-st');
    const stB = $('ht-stb');
    const stSess = $('ht-sts');
    const btnGen = $('ht-gen');
    const btnCopy = $('ht-copy');
    const btnExp = $('ht-exp');
    const body = panel.querySelector('.ht-body');

    /* 口径与常见问题 */
    const faqEl = $('ht-faq');
    const fqInput = $('ht-fqinput');
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
    /* 左边**只允许三个字**（检测中/请登录/未到点/已就绪/取数中/已生成/出错了），
       三个字是扫一眼就能抓住的长度；取数明细这类补充信息一律进 title，
       不再在右边挂一串小字——那串小字会随进度每秒抖动，比状态本身还抢眼。 */
    let footTip = '';
    function setFoot(label, tone, tip) {
      stB.textContent = label || '';
      stEl.className = 'st' + (tone ? ' ' + tone : '');
      footTip = tip || label || '';
      stEl.title = footTip;
      /* 状态字一换，后面的小尾巴（票据剩几分钟 / 能不能点）也要跟着重算：
         从「已就绪」翻到「请登录」时，尾巴若还挂着上一条的「剩 4 分」，两句话打架。 */
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
      hintTimer = setTimeout(() => hintEl.classList.remove('show'), 1600);
    }

    /* 空态文案要跟着状态走：没到截点时点「生成」拿到的是上一个周期，
       这一点不写清楚，用户会以为取的是今天的数。 */
    function refreshEmpty() {
      const sp = outBox.querySelector('.ht-empty span');
      if (!sp || outBox.querySelector('.ht-item')) return;
      const a = (cfg && cfg.anchor) || '18:00';
      /* 手填了基准时间就不存在"取上一周期"这回事——取的就是他填的那一段 */
      const waiting = state === 'pending' && !(cfg && cfg.baseAt);
      sp.textContent = waiting ? `未到 ${a}，点刷新取上一周期` : '点刷新图标取数并成文';
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

    function refreshGates() {
      const g1 = canGen();
      btnGen.classList.toggle('is-off', !g1);
      btnGen.setAttribute('aria-disabled', g1 ? 'false' : 'true');
      const g2 = hasText();
      [btnCopy, btnExp].forEach(b => {
        b.classList.toggle('is-off', !g2);
        b.setAttribute('aria-disabled', g2 ? 'false' : 'true');
      });
    }

    /* 短名只有一份：dom.js 的 UI_STATE[态].label。
       这里只补「为什么」与灯色，不再各写一个词——以前胶囊「未登录」、
       状态栏「请登录」，同一个人在两处看到两种说法。 */
    const SN = k => (STATE[k] && STATE[k].label) || '';

    function setState(s) {
      state = STATE[s] ? s : 'checking';
      nav.setState(state);
      refreshTip();
      refreshGates();
      refreshEmpty();
      if (state === 'checking') setFoot(SN('checking'), '');
      else if (state === 'nologin') setFoot(SN('nologin'), 'warn', '请先登录业务系统，登录后自动启用');
      /* 未到基准时间不是错误：按钮照样能取上一周期，只是取的不是今天 */
      else if (state === 'pending' && cfg && cfg.baseAt)
        setFoot(SN('pending'), '', '这个基准时间还没到，取数会拿不到数据');
      else if (state === 'pending') setFoot(SN('pending'), '', '未到基准时间，现在生成取的是上一周期');
      else if (state === 'ready') setFoot(SN('ready'), '', '可以取数生成');
      else if (state === 'running') setFoot(SN('running'), 'run', '正在取数…');
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
      const box = GEOM.fitBox({
        vh: viewH(),
        tall: !!(setOpen || (F && F.isOpen())),
        pos: panelPos,
        anchor: panelAnchor,
        styleTop: parseFloat(panel.style.top),
        focus: !!(S && S.isFocus())
      });
      panel.style.maxHeight = box.max + 'px';
      panel.style.minHeight = box.floor + 'px';
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
      clearTimeout(fitTimer);
      fitTimer = setTimeout(() => {
        if (!isOpen() && !panelPos) return;
        fitPanelBox();
      }, 120);
    });

    function openPanel() {
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
       签发那一刻写下 30 分钟；localStorage 里只有 `token` 一把，没有 refresh_token，
       接口也没有"拿旧票换新票"的入口 —— 所谓"保活"在前端做不成。

       但**票面时间不等于能不能用**：请求同时带同源 Cookie，exp 过了照样能查数
       （出稿人实测："我在站点上明明还能查数据，扩展却显示已过期"）。
       所以这里只做两件事，都不拦人：

         1. 剩不到五分钟时，在标题栏状态字后面挂三个字（「剩 4 分」）——
            提前说一声，免得取数跑到一半断；
         2. 真的被拒（401/403，或响应根本不是 JSON）之后，状态字转「请登录」、
            整块状态可点，点了开一个新标签去登录，原标签一个字不动，
            登录完这一轮自己接着跑（pendingRun）。

       **不在 exp 到期时写「已过期」**：上一版那一行把人支去白登了一次。
       也不在入口上加红点/角标——入口是站点导航的克隆体，多一个点就不像原生的。 */
    const SESS_WARN = 5 * 60 * 1000;    // 剩 5 分钟起提醒
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
    const clockOf = ms => {
      const d = new Date(ms);
      return pad(d.getHours()) + ':' + pad(d.getMinutes());
    };

    /**
     * 重画状态字后面的小尾巴，以及状态本身可不可点。
     *
     * 只有两种情况会多写字：
     *   · 票还剩不到五分钟 → 「剩 4 分」（琥珀）
     *   · 确实没票 / 票被拒  → 不写字，改成整块状态可点（悬停有说明）
     * 其余时候这个位置是空的，标题栏宽度一点不变。
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

      const soon = !li.unknown && li.leftMs > 0 && li.leftMs <= SESS_WARN;
      if (soon) {
        const m = Math.max(1, Math.ceil(li.leftMs / 60000));
        stSess.hidden = false;
        stSess.textContent = '剩 ' + m + ' 分';
        stEl.classList.add('is-act');
        stEl.title = '票据 ' + clockOf(li.exp) + ' 到期。到期后照样能取数，'
          + '真被拒了状态会变成「请登录」，点一下就能去登';
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
      hint('已打开站点，登录后这里接着取数', anchor || btnGen);
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
      hint('已恢复登录' + (li && li.exp ? '（票面到 ' + clockOf(li.exp) + '）' : ''), btnGen);
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

    /* ── 基准时间 ─────────────────────────────────────────── */
    /** 只画「基准时间」一行。
        早先这里是「本期 / 去年同期」两行区间——两行长得很像，一眼分不出哪个是
        要取的数、哪个只是同比参照，还得先读懂「本期」这个词指的是哪 24 小时。
        换成结算时刻本身这一个值：它既是这次取数的右端，也是「截至…」那句话的写法，
        一个数说清一件事。完整区间退到 title，需要核对时悬停即可。

        1.1 起这一行可点：点开就能指定到某一刻（补前天的数、按 17:30 结账）。
        原来只能改设置页的「统计截点」，而且只能填时分秒，日子由"到没到点"推。 */
    function showMeta() {
      let W;
      try {
        W = HT.buildWindows(new Date(), cfg);
      } catch (e) {
        rangeBox.innerHTML = '<dt>基准时间</dt><dd>时间配置有误</dd>';
        return;
      }
      rangeBox.classList.remove('is-edit');
      /* 只有「基准时间」一行。票据状态挂到标题栏的状态字后面（`#ht-sts`），
         不再在这里占第二行：两行一出现，整块就长高一行，正在写的字跟着往下跳；
         而且"票还剩几分钟"跟"取的是哪一段"本来不是一类信息。 */
      rangeBox.innerHTML = '<dt>基准时间</dt>' +
        `<dd title="${esc(W.dayRange)}">` +
        `<button type="button" id="ht-base" class="ht-base${W.explicit ? ' is-set' : ''}"` +
        ' title="点这里改：取数截至这一刻">' +
        `${esc(W.baseText)}<i aria-hidden="true">▾</i></button></dd>`;
      paintSess();
    }

    /** 展开编辑：原地把这一行换成输入框，不弹浮层（面板窄，浮层容易压住正文） */
    function openBaseEdit() {
      let W;
      try { W = HT.buildWindows(new Date(), cfg); } catch (e) { return; }
      rangeBox.classList.add('is-edit');
      rangeBox.innerHTML = '<dt>基准时间</dt>' +
        '<dd class="bpd">' +
        `<input type="datetime-local" step="1" class="bp-in" id="ht-basein" value="${W.baseAt}">` +
        '<span class="bp-acts">' +
        '<button type="button" data-bp="ok">确定</button>' +
        `<button type="button" data-bp="auto"${W.explicit ? '' : ' disabled'}>跟随每天</button>` +
        '<button type="button" data-bp="cancel">取消</button>' +
        '</span></dd>';
      const inp = rangeBox.querySelector('#ht-basein');
      if (inp) { inp.focus(); try { inp.select(); } catch (e) { } }
    }

    /** 写回基准时间。空串 = 回到自动（每天 18:00），这是「跟随每天」按的 */
    async function applyBase(v) {
      const next = HT.normBaseAt(v);
      cfg.baseAt = next;
      try {
        await HT.saveCfg(cfg);
      } catch (e) {
        hint('基准时间没存上：' + HT.ERR_CARD.STORAGE.foot, btnGen);
        showMeta();
        return;
      }
      /* 窗口变了，上一次取数的缓存必须作废——否则点刷新拿回来的还是旧窗口的数 */
      HT.clearCache();
      showMeta();
      refreshEmpty();
      refreshAnchor();
      let msg = '已跟随每天 18:00';
      try { msg = '基准时间已改到 ' + HT.buildWindows(new Date(), cfg).baseText; } catch (e) { }
      hint(msg, btnGen);
    }

    /* 打开期间每秒走一次，只为在跨过截点那一刻把「未到点」翻成「已就绪」。
       不重建 DOM（那会让入场动画每秒重放），只比一次时间。
       顺带每 20 秒重画一次票据小尾巴——「剩 4 分」要在变「剩 3 分」时跟着走，
       每秒重画没有意义（分钟级的数），只是白读写一次存储。 */
    let tickTimer = null;
    let sessTick = 0;
    function startTick() {
      if (tickTimer) return;
      tickTimer = setInterval(() => {
        if (!isOpen()) return;
        let passed = false;
        try { passed = HT.anchorStatus(new Date(), cfg || {}).passed; } catch (e) { }
        if (passed && state === 'pending') refreshAnchor();
        if (++sessTick % 20 === 0) paintSess();
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
       面板只负责"结果来了就 render、换人了就 clear、取数中先 hide"。
       点某一行的「?」由这里转给问答浮层（校验栏不知道该跳哪一条）。
       ─────────────────────────────────────────────────────── */
    CK = HT.mountChecks({
      sec: ckSec,
      tog: ckTog,
      box: ckBox,
      rt: ckRt,
      segRoot: shadow,
      esc: esc,
      throttled: throttled,
      onAsk: key => F.open('', key)
    });

    const currentSegs = () => [...outBox.querySelectorAll('textarea')].map(t => t.value).filter(Boolean);
    const currentText = () => currentSegs().join('\n\n');

    /* ── 复制与导出 ───────────────────────────────────────── */
    const stamp = () => {
      const d = new Date();
      return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
    };

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
      HT.clearCache();
      const r = await HT.run({
        now: new Date(), cfg,
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
      const now = new Date();
      const tm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
      /* 第三类"数据拿到了但校验不通过"就在这里说清楚：稿子生成了，但数字互相矛盾。
         措辞上不叫"失败"，因为确实出稿了；也不叫"完成"，因为不能直接上报。 */
      setFoot(r.summary.failed ? HT.UI_WORD.chkFail : SN('done'), r.summary.failed ? 'warn' : 'ok',
        `${tm} 生成 · ${r.meta.requests > 0 ? r.meta.requests + ' 次请求' : '缓存命中'} · 用时 ${secText}` +
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
          setFoot(HT.UI_WORD.chkFail, 'warn',
            `${tm} 生成 · 报表口径互校有 1 项对不上，请核对后再上报`);
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
      refreshGates();          // 取数中：生成按钮直接置灰，进度只走标题栏那条线
      F.close();
      closeSettings(false);
      S.exitFocus();
      CK.hide();
      outBox.innerHTML = '<div class="ht-empty">正在取数…</div>';
      setState('running');
      setBar(4);
      const t0 = Date.now();

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
        res = lastRun.repaint(c, HT.buildWindows(new Date(), c));
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
       不另设一颗按钮——标题栏这一行已经没有空位，而「请登录」本身就是那句话。 */
    stEl.addEventListener('click', () => {
      if (!stEl.classList.contains('is-act')) return;
      sessGo(stEl);
    });

    /* 基准时间那一行：点开编辑、确定/跟随每天/取消。用委托，
       因为这一行的 DOM 每次 showMeta 都重画。 */
    rangeBox.addEventListener('click', e => {
      const act = e.target.closest('[data-bp]');
      if (act) {
        const how = act.dataset.bp;
        if (how === 'cancel') { showMeta(); return; }
        if (how === 'auto') { applyBase(''); return; }
        const inp = rangeBox.querySelector('#ht-basein');
        const v = inp ? inp.value : '';
        if (!HT.normBaseAt(v)) { hint('这个时间不成立，检查一下日期与时分', inp || act); return; }
        applyBase(v);
        return;
      }
      if (e.target.closest('#ht-base')) openBaseEdit();
    });
    /* 输入框里回车 = 确定；Esc 先收回编辑态（面板的 Esc 是收起面板，
       这里要抢在它前面，否则改了一半的输入框直接消失） */
    rangeBox.addEventListener('keydown', e => {
      if (!rangeBox.classList.contains('is-edit')) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        const inp = rangeBox.querySelector('#ht-basein');
        if (inp && HT.normBaseAt(inp.value)) applyBase(inp.value);
        else if (inp) hint('这个时间不成立，检查一下日期与时分', inp);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        showMeta();
      }
    });

    /* 点面板外空白处收起。三个必须条件：
       ① 设置里 closeOnOutside 开着（默认开；关掉后只认右上角 × 和 Esc）
       ② 点的不在面板里、也不在入口上 —— pointerdown 先于 click 到达 document，
          漏掉面板就会变成"点任何按钮都把面板关掉，然后操作打在隐藏面板上"
       ③ 不在取数中——**这一条去掉了**。

       为什么去掉 ③：取数不会因为面板收起而中断，它本来就在后台跑完、
       把结果写进 outBox，人再打开就能看到；状态栏里那三个字也还在。
       留着它反而制造了一个看不见的坑：屏幕上显示「取数中」的那几分钟里，
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
    panel.addEventListener('pointerdown', () => {
      if (panel.classList.contains('is-dim')) setDim(false);
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
        /* 逐层退出：设置 / 问答 → 专注 → 面板。一个 Esc 撤一层，符合直觉 */
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
      if (!hasText()) { hint('还没有内容', btnCopy); return; }
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

    btnExp.addEventListener('click', () => {
      if (!hasText()) { hint('还没有内容', btnExp); return; }
      if (throttled('export', 900)) return;
      const notes = exportNote();
      const body = currentText() + (notes.length ? '\n\n' + notes.join('\n') : '');
      const tail = (lastRun && lastRun.summary && lastRun.summary.failed) ? '_待核' : '';
      /* 文本给记事本 / Excel 看，要 BOM；文件名里的日期与"_待核"后缀是公文习惯 */
      HT.download(`警情统计_${stamp()}${tail}.txt`, body, 'text/plain;charset=utf-8', true);
      /* 下载这件事浏览器有自己的下载条，但它在页面底部、常常在视野外；
         按钮这次换对勾 + 变绿，是唯一发生在"刚点的那一下"上的确认。 */
      HT.flashBtn(btnExp, tail ? '已导出·待核' : '已导出 txt', true);
      hint(tail ? '已导出（文件名标注待核）' : '已导出 txt', btnExp);
    });

    /* ── 版本 ─────────────────────────────────────────────── */
    function showVersion() {
      verEl.textContent = `v${META.version}`;
      let mfVer = '';
      try { mfVer = g.chrome.runtime.getManifest().version; } catch (e) { }
      if (mfVer && mfVer !== META.version) {
        verEl.classList.add('is-stale');
        verEl.textContent = `v${META.version} ≠ ${mfVer}`;
        verEl.title = `脚本 ${META.version} 与清单 ${mfVer} 不一致，请重新加载扩展`;
      } else {
        verEl.title = `${META.name} ${META.version} · 构建 ${META.build}`;
      }
    }

    /* ── 外部变更 ─────────────────────────────────────────── */
    try {
      g.chrome.storage.onChanged.addListener((ch, area) => {
        if (area !== 'local') return;
        if (!ch.cfg) return;
        cfg = HT.normalizeCfg(ch.cfg.newValue);
        S.applyFont(cfg.focusFont);
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
        paintSess();      // 剩几分钟与忙不忙无关，取数中也要看得到
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
      /** 调试/预览用：停在取数中的某个进度 */
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
