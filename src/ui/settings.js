/**
 * src/ui/settings.js —— 设置视图（面板内浮层与独立设置页共用同一份实现）
 *
 * @layer  ui（表现层）
 * @file   src/ui/settings.js
 * @since  0.10.0
 *
 * 为什么是一个"视图模块"而不是一个页面：
 *   0.9 的设置是独立标签页（options.html）。点齿轮跳走一页，等于把"手上这份稿子"
 *   留在原地、把配置搬到另一处改，改完还得自己回来。0.10 把它做成面板里的浮层
 *   （和「口径与常见问题」同一个位置、同一套进出方式），改完点保存就回到稿子上。
 *   chrome://extensions 的「扩展选项」仍然要有落点，所以 options.html 退化成
 *   一个 20 行的宿主页：同一份 CSS、同一个模块，只是挂载点更宽。
 *
 * 模板编辑器（0.10 的核心）
 *   模板不再是"块的列表"，而是**一段自由文本**，中间可以插占位符：
 *     · 数据 —— 数据域 → 字段 → 呈现方式，三级联动
 *     · 日期 —— 时间段 / 时间点 / 日期，各给几种写法
 *     · 整段成文 —— 原来的公文段落，一键插入
 *   于是"起火原因引导语""待查后缀""固定结尾句"这些半成品开关全部删掉：
 *   想改那句话，就在那段话里改。
 *
 * 编辑区用 contenteditable + 不可编辑的 chip 表示占位符：
 *   纯 textarea 只能显示 {{f:day.C|numUnit}} 这种原文，写稿的人看不出那是什么；
 *   而 chip 上写的就是"当日有效条目起数"。序列化在 readEditor() 一处完成。
 *
 * 这份编辑器整体搬到了 src/ui/editor.js（0.25.0）：列表、光标、chip、三级级联
 * 都归它；这个文件只剩"有哪些设置项、怎么存、浮层归谁开"。
 */
(function (g) {
  'use strict';
  const HT = (g.__HT = g.__HT || {});

  const esc = s => HT.esc(s);

  /* 重庆市区域：中心城区多选的候选项。名单只用来**选择**，
     存进配置的仍是勾中的名字，取数层按 shortTown 归一后比对。 */
  const DISTRICTS = [
    '渝中区', '大渡口区', '江北区', '沙坪坝区', '九龙坡区', '南岸区', '北碚区', '渝北区', '巴南区',
    '万州区', '涪陵区', '黔江区', '长寿区', '江津区', '合川区', '永川区', '南川区', '綦江区',
    '大足区', '璧山区', '铜梁区', '潼南区', '荣昌区', '开州区', '梁平区', '武隆区',
    '城口县', '丰都县', '垫江县', '忠县', '云阳县', '奉节县', '巫山县', '巫溪县',
    '石柱土家族自治县', '秀山土家族苗族自治县', '酉阳土家族苗族自治县', '彭水苗族土家族自治县',
    '两江新区', '万盛经开区', '高新区'
  ];

  let uidSeq = 0;

  const shortName = s => {
    try { return HT.shortTown(String(s || '').trim(), true); } catch (e) { return String(s || ''); }
  };

  /* 正文与编辑区 DOM 的互转（toEditor / readEditor）在 src/ui/editor.js：
     它只服务模板编辑器，放在这里会让"设置项"和"富文本序列化"共用一份命名空间。 */

  /* 下载回执的订阅只注册一次（mount 每次打开都会重跑），
     真正指向哪一行提示由 sayTo 决定——后打开的那一屏接管。 */
  let sayTo = null;
  let dlHooked = false;
  /* 每次发起下载 +1。回执和超时定时器都认这个号，旧的那次自动作废——
     否则连点两次，第一次的超时会把第二次的结果盖掉。
     放在模块级而不是某个实例里：回执监听只注册一次，它得能作废最新那一屏的定时器。 */
  let dlTick = 0;

  /**
   * 挂载设置视图。
   * @param {HTMLElement} host 挂载点
   * @param {{onSaved?:Function, onLater?:Function}} [opts]
   */
  HT.mountSettings = function (host, opts) {
    const o = opts || {};
    const uid = 'st' + (++uidSeq);
    let cfg = HT.normalizeCfg();
    /* 三处多选（中心城区 / 起火原因 / 明细列）的选中值都在这儿，按 data-f 分键。
       以前它们各活在各处：中心城区在 coreSel、另两处在 DOM 的框上；
       统一成一颗按钮之后没有常驻的框可读，值只能留在内存里（1.12.18）。 */
    const msSel = { coreTowns: [], causePick: [], exportCols: [] };

    /* 结构与控件全部来自 src/data/settings-schema.js。
       这里只留两个动作（恢复默认 / 保存）与浮层宿主——加设置项请改 schema，
       不要在这个文件里再拼第 181 行字符串。

       两个动作放哪儿由**调用方**决定（1.9.1）：
         · 面板里的设置浮层把它挂到头部右上角（`opts.head`）——
           设置不是对话框，没必要为两颗按钮单占一条底栏；
         · 独立设置页没有那条头部，退回页脚。两条路用的是同一份 HTML，
           `data-act` 也一样，所以点击分发只写一遍。

       恢复默认是**长按**（1.12.16）：它一步清掉模板、区域与所有偏好，没有撤销。
       一颗普通按钮 + 一个 confirm 弹框，人闭着眼都能连点两下过去；
       液面推满才触发，是这类动作更合适的确认方式（参数在「界面 · 长按按钮」）。
       按钮上因此不再挂 data-act——否则一次普通点击就会走到 reset()。 */
    /* 恢复默认是**唯一**一颗长按按钮：它一步清掉模板、区域与全部偏好，
       没有撤销。其余不可撤销的动作（重置本组模板 / 还原）走两段式——
       长按是给"这一步最重"的那一颗用的，一颗排里全是长按等于没有重点。
       结构由 uikit.js 的 buildHold 补齐（液面 / 波峰 / 反白字都要现建）。 */
    const BTN_RESET = '<button class="st-hold" type="button" data-hold="reset">恢复默认</button>';
    const BTN_SAVE = '<button class="st-btn st-primary" type="button" data-act="save">保存</button>';
    const headActs = o.head || null;
    if (headActs) headActs.innerHTML = '<span class="st-msg" data-f="msg"></span>' + BTN_RESET + BTN_SAVE;

    host.innerHTML = HT.SETTINGS.render(cfg) + (headActs ? ''
      : '<div class="st-foot">' + BTN_RESET + '<span class="st-sp"></span>' +
      '<span class="st-msg" data-f="msg"></span>' + BTN_SAVE + '</div>') +
      '<div class="st-pop" data-f="pop" hidden></div>';

    const root = host;
    const pop = root.querySelector('[data-f="pop"]');
    /* 两页两个容器（1.14.0）：
         libBox  —— 「文字模板」页，编辑器挂在这里，装的是**库**；
         pickBox —— 「文稿组合」页，画的是当前组合**接的那几段**（引用，不是正文）。 */
    const libBox = root.querySelector('[data-f="lib"]');
    const pickBox = root.querySelector('[data-f="picklist"]');
    /* 提示条跟着按钮走：挂在头部时它也在头部，否则在页脚 */
    const msgEl = (headActs || root).querySelector('[data-f="msg"]');
    const bodyBox = root.querySelector('.st-body');

    const q = sel => root.querySelector(sel);
    const qa = sel => Array.from(root.querySelectorAll(sel));

    /* ── 分类树与页（1.13.0）单页长滚动 + 左侧跟随 ────────────
       左边一棵树，右边按树的顺序铺开**全部内容**，滚到哪一块，左边就亮哪一项。
       点叶子滚到那一块；点带子页的分组只折叠/展开——两种行为刻意分开：
       想收起来的时候被顺手滚走了内容，是最烦的一种"聪明"。

       为什么改成一页长文（用户 2026-11-25 明确要求）：十几页一屏一页地切，
       要找一个设置项得先在左边猜它在哪一组；铺开之后连续滚动就能从头读到尾。
       元素仍然一次性渲染、不按需重建：模板编辑器在里面，
       重建会把正在编的段、光标一起丢掉。 */
    const navBox = root.querySelector('[data-f="nav"]');
    const paneBox = root.querySelector('[data-f="panes"]');
    /* 分类树的分支线是算出来的（每组项数不同），页面画完才能排——
       挂上之后改行高 / 字号会自己重排（uikit 里挂了 ResizeObserver）。 */
    if (navBox && HT.mountNav) HT.mountNav(navBox);
    /* 初值必须是**空**的。`markPane` 头一句是"同一个 key 就早退"，
       若从 DOM 上把 `data-pane-cur` 读进来，等于宣告"已经标过了"，
       首屏那次标记（展开所在分组、把导轨标记条滑到位）会被整个跳过——
       表现是"点齿轮进来，左边一条分组都没展开、树上也没有标记条"。
       schema 画出来的 `data-pane-cur` / `is-on` 只保证"看着像选中了第一页"，
       树上的展开与标记条是 `markPane` 的活，跳过就没有。
       另外 `.ht-set` 的 DOM 是跨"打开 / 关闭"复用的，所以每次打开都要重标。 */
    let curPane = '';
    const firstPaneKey = () => {
      const all = HT.SETTINGS && HT.SETTINGS.panes ? HT.SETTINGS.panes() : [];
      return all.length ? all[0].key : '';
    };

    /* 跟随锁（见下面的「滚动跟随」一节）：声明放前面，
       免得 showPane 在某个更早的时点被调用时撞上暂时性死区。 */
    let lockKey = '';
    let lockTop = 0;
    let lockUntil = 0;
    let scrollRaf = 0;

    /** 把某一项记成"现在读的是这一块"：导航高亮 + 展开它所在的分组 */
    function markPane(key) {
      if (!key || key === curPane) return;
      curPane = key;
      bodyBox.setAttribute('data-pane-cur', key);
      paneBox.querySelectorAll('.st-pane').forEach(p => {
        p.classList.toggle('is-on', p.getAttribute('data-pane') === key);
      });
      navBox.querySelectorAll('[data-nav]').forEach(b => {
        const on = b.getAttribute('data-nav') === key;
        b.classList.toggle('is-on', on);
        if (on) b.setAttribute('aria-current', 'page');
        else b.removeAttribute('aria-current');
      });
      /* 手风琴：只展开当前所在的分组，其余折起来。折着的那一支上不会亮，
         所以"亮着的东西永远看得见"——与以前切页时的行为一致。 */
      const sec = key.split('.')[0];
      navBox.querySelectorAll('.stn').forEach(li => {
        const hd = li.querySelector('[data-navsec]');
        if (!hd) return;
        const open = hd.getAttribute('data-navsec') === sec;
        if (open) li.setAttribute('data-open', '1');
        else li.removeAttribute('data-open');
        hd.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      /* 树上的两条反馈：选中项那条分支要"画"出来，导轨上的标记条要滑到组名上 */
      if (HT.navSync) HT.navSync(navBox);
    }

    /* 谁在滚：两种挂载点不一样。
         · 面板里的齿轮浮层：.st-body 是 inset:0，高度受限，滚的是 .st-panes；
         · 独立设置页（options.html）：options.css 把 .st-body 的 overflow 放开，
           让大屏一口气读完整页，滚的其实是**文档**。
       写死任何一个，另一个挂载点上"滚到哪高亮哪"就完全不工作——而且不报错。 */
    function scrollBox() {
      if (!paneBox) return null;
      if (paneBox.scrollHeight > paneBox.clientHeight + 2) return paneBox;
      return g.document.scrollingElement || g.document.documentElement;
    }

    /** 点导航：滚到那一块。用 scrollTop 而不是 scrollIntoView——
     *  scrollIntoView 会把沿途**每一个**可滚容器都滚一遍（1.12.18 踩过：
     *  设置页的标题被滚出视野 20px），这里只滚这一个。 */
    function showPane(key) {
      const sec = key ? paneBox.querySelector('.st-pane[data-pane="' + key + '"]') : null;
      const box = scrollBox();
      if (!sec || !box) return;
      /* 先把高亮定下来，滚动过程的跟随就不会抢在点击前面闪一下别的项 */
      markPane(key);
      /* 文档滚动时"容器上沿"是视口上沿（0），不是 .st-panes 的矩形。 */
      const boxTop = box === paneBox ? paneBox.getBoundingClientRect().top : 0;
      const top = sec.getBoundingClientRect().top - boxTop + box.scrollTop;
      /* 末尾几页加起来也不够一屏时，最后一项永远到不了顶上——
         所以到底之后由 scroll 监听按"已到底"把它选出来（见 paintFollow）。
         目标位置要**自己夹到可滚范围里**：浏览器会把越界的 top 收成 max，
         而锁是按"滚到锁定的那个数"来解的，不夹的话永远对不上、只能等超时。 */
      const max = Math.max(0, box.scrollHeight - box.clientHeight);
      lockTop = Math.min(max, Math.max(0, top - 4));
      lockKey = key;
      lockUntil = Date.now() + 1600;
      box.scrollTo({ top: lockTop, behavior: 'smooth' });
    }

    /** 只折叠 / 展开一个分组，不动当前读的位置 */
    function foldSec(id) {
      const hd = navBox.querySelector('[data-navsec="' + id + '"]');
      if (!hd) return;
      const li = hd.parentNode;
      const open = li.getAttribute('data-open') !== '1';
      if (open) li.setAttribute('data-open', '1');
      else li.removeAttribute('data-open');
      hd.setAttribute('aria-expanded', open ? 'true' : 'false');
      /* 收起时如果当前项就在这一组里，标记条要跟着收起来；
         展开时它得滑出来——所以每次折叠都同步一次，而不是只在换页时。 */
      if (HT.navSync) HT.navSync(navBox);
    }

    /* ── 滚动跟随（1.13.0）──────────────────────────────────
       判定"现在读到哪一块"只有一句：**最后一个上沿在视线顶端之上的页**。
       顶端留 8px 余量，免得行高差一像素时在一与二之间来回跳。
       一页都没越过那条线 = 还在读第一页（首屏上面有页头，第一页的上沿
       本来就不在 0，不兜这一条，滚回顶时左边会停在最后读过的那一项）。
       滚到底时直接认最后一页：末尾几页不够一屏的话它永远到不了顶端，
       否则左边会一直停在倒数第二项、右边已经在读最后一项。

       点导航滚过去的途中要**压住跟随**（lockKey）。判据不是"过了多久"——
       平滑滚动跨三屏要一秒多，早先按 460ms 松手，中途一路把高亮抢成
       ui.mark / common / exp，左侧分组被折了又开，最后停在哪儿全看运气。
       现在按"到没到锁定的那个位置"来解，另有 1.6s 兜底（用户中途自己
       滚走了就再也不到那儿，不能一直压着）。 */
    function paintFollow() {
      scrollRaf = 0;
      const box = scrollBox();
      if (!box) return;
      if (lockKey) {
        const arrived = Math.abs(box.scrollTop - lockTop) <= 2;
        if (!arrived && Date.now() < lockUntil) return;
        lockKey = '';
        /* 到了就停在这儿：目标页就是用户点的那一项，不再重算。
           重算会把靠近底部的几页改成"最后一页"——「云端」下面还压着「版本」，
           点到云端、滚到底，左边就亮成版本（1.14.0 多了一页之后踩到：
           ui-audit 量「云端顺序」时读到的行是版本页的）。
           用户自己再滚一次，才交回给下面的跟随。 */
        if (arrived) return;
      }
      const list = Array.prototype.slice.call(paneBox.querySelectorAll('.st-pane'));
      if (!list.length) return;
      const boxTop = box === paneBox ? box.getBoundingClientRect().top : 0;
      const atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 2;
      let key = list[0].getAttribute('data-pane');
      if (atEnd) {
        key = list[list.length - 1].getAttribute('data-pane');
      } else {
        list.forEach(p => {
          if (p.getBoundingClientRect().top - boxTop <= 8) key = p.getAttribute('data-pane');
        });
      }
      if (key) markPane(key);
    }

    const onScroll = () => {
      if (scrollRaf) return;
      scrollRaf = requestAnimationFrame(paintFollow);
    };
    /* 两个来源都挂：面板浮层里滚 .st-panes，独立设置页里滚文档。
       scroll 事件不冒泡，少挂一个那一边就整块不跟随。 */
    if (paneBox) paneBox.addEventListener('scroll', onScroll, { passive: true });
    g.addEventListener('scroll', onScroll, { passive: true });
    /* 自己动手滚就立刻放开锁定：不然这一秒里左边像死了一样不跟着走。 */
    const dropLock = () => { lockKey = ''; };
    ['wheel', 'touchstart', 'keydown'].forEach(t =>
      g.addEventListener(t, dropLock, { passive: true }));

    /* ── 界面手感（1.12.16）───────────────────────────────────
       这三十行是「怎么显示」，不是「稿子写什么」：滑杆只改界面，
       改完立刻在面板上生效（标题栏就在设置浮层上面，看得见），
       但**要保存才算数**——与其它设置项同一个约定。 */
    /* 读数的小数位数由**步长**决定，不是一律两位。
       踩过：按下缩放的步长是 0.005，一律按两位取整，0.965 被印成 0.97——
       读数与滑杆对不上（往回调一格，读数不动），人会以为滑杆坏了。 */
    const stepDec = s => {
      const t = String(s);
      const i = t.indexOf('.');
      return i < 0 ? 0 : t.length - i - 1;
    };
    const fmtV = (v, r) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return '—';
      /* 末尾的零不印：小数位数已经由步长定死，剩下的零只是噪声
         （1.00× 读作 1×、0.970× 读作 0.97×）。只削小数部分的零，
         "900" 这种整数一位都不能动。 */
      const s2 = n.toFixed(stepDec(r.step)).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
      return s2 + (r.unit || '');
    };

    function paintRv(r) {
      const el = q(`[data-f="${r.f}"]`);
      const b = q(`[data-rv="${r.f}"]`);
      if (!el || !b) return;
      b.textContent = fmtV(el.value, r);
    }

    /** 界面上的 ui 参数 → {part: {key: 值}}（只收画出来的那些） */
    function uiFromDom() {
      const out = {};
      HT.SETTINGS.uiRows().forEach(r => {
        const el = q(`[data-f="${r.f}"]`);
        if (!el) return;
        const v = r.t === 'switch' ? getSw(r.f) : Number(el.value);
        (out[r.part] = out[r.part] || {})[r.key] = v;
      });
      return out;
    }

    /** 深一层合并：将来多一个 part 时，没画出来的那份也不能丢 */
    function mergeUi(base, patch) {
      const out = {};
      Object.keys(base || {}).forEach(p => { out[p] = Object.assign({}, base[p]); });
      Object.keys(patch || {}).forEach(p => { out[p] = Object.assign(out[p] || {}, patch[p]); });
      return out;
    }

    /** 拖动滑杆时的即时预览：本页的分类树立刻变，面板那边交给 onUi */
    function previewUi() {
      const ui = HT.normUi(mergeUi(cfg.ui, uiFromDom()));
      if (HT.applyNav) HT.applyNav(bodyBox, ui.nav);
      /* 分段开关的参数也挂到 .st-body 上：设置页里那两颗日 / 周与标题栏那颗
         是同一个控件，调「界面 · 分段开关」时两处应当一起变——
         只变一处的话，滑杆推到头也看不出改的是哪一颗。 */
      if (HT.applyUi) HT.applyUi(bodyBox, ui);
      if (typeof o.onUi === 'function') o.onUi(ui);
    }

    /** 长按按钮：把当前参数挂上去（改完滑杆回来再看，手感就是新的） */
    /* 长按按钮的动作表。**只有「恢复默认」**——这是（1.12.17）按用户要求收紧的：
       长按表示"这一步重到需要按住"，一屏里出现三四颗就变成了新的普通按钮。
       重置本组模板 / 还原 / 导入都不是长按，走普通点击（破坏性的那两颗两段式）。 */
    /** 打开文件选择框。导入是整份覆盖，但它只是"选一个文件"，并没有动手。 */
    function impPick() {
      const f = q('[data-f="impFile"]');
      if (!f) return;
      f.value = '';
      f.click();
    }

    /* 长按的动作表。两颗：
         reset     —— 恢复默认，一步清掉模板、区域与全部偏好，没有撤销；
         comboDel  —— 删除组合（1.13.0），连同里面的段落一起删掉，也没有撤销。
       前者在页脚 / 头部（由调用方给节点），后者在「文稿组合」页标题右端。
       两颗都靠"按住液面推满"确认，颜色由 .st-hold 的警告色变量给——
       用户要求的就是"和恢复默认一样的长按 + 同样的警告色"。 */
    const HOLD_ACT = {
      reset: { label: '恢复默认', done: '已恢复', run: () => reset() },
      comboDel: { label: '删除', done: '已删除', run: () => comboDel() }
    };

    function wireHold() {
      if (!HT.hold) return;
      const u = (cfg.ui && cfg.ui.hold) || {};
      /* 头部那两颗动作不在 host 里（由调用方提供，面板里挂在标题行右上角），
         所以不能只扫 root —— 少了这一句，「恢复默认」画得出来、按住毫无反应，
         而且不报任何错（1.12.16 实测踩到：holding 一直 false）。 */
      const btns = qa('[data-hold]').concat(headActs ? Array.from(headActs.querySelectorAll('[data-hold]')) : []);
      btns.forEach(b => {
        const key = b.getAttribute('data-hold');
        const a = HOLD_ACT[key];
        if (!a) return;
        HT.hold(b, {
          holdTime: u.holdTime, radius: u.radius, pressScale: u.pressScale,
          wave: u.wave, waveAmplitude: u.waveAmplitude, glow: u.glow,
          releaseTime: u.releaseTime, resetAfter: u.resetAfter,
          label: a.label, doneLabel: a.done,
          onHold: a.run
        });
      });
    }

    /* ── 读写控件 ───────────────────────────────────────── */
    function setSw(name, on) {
      const b = q(`[data-f="${name}"]`);
      if (b) b.setAttribute('aria-checked', on ? 'true' : 'false');
    }
    function getSw(name) {
      const b = q(`[data-f="${name}"]`);
      return !!b && b.getAttribute('aria-checked') === 'true';
    }

    /* ── 同比那一行（dirNum）─────────────────────────────────
       两个数字框 + 一颗方向按钮。方向只存一处（up / down），人数与幅度都存**绝对值**：
       两处各存一个符号，迟早写出「人数减少、幅度上升」这种自相矛盾的句子。 */
    function setDir(name, dir) {
      const down = dir === 'down';
      const b = q(`[data-dir="${name}"]`);
      if (b) {
        b.textContent = down ? '减少' : '增加';
        b.setAttribute('aria-pressed', down ? 'false' : 'true');
      }
      /* 这个字跟着按钮走，不单独给入口：人只回答"多了还是少了"，
         "上升 / 下降"是同一个答案的另一种说法。 */
      const w = q(`[data-w="${name}"]`);
      if (w) w.textContent = down ? '下降' : '上升';
    }

    function readDir(name) {
      const b = q(`[data-dir="${name}"]`);
      return b && b.getAttribute('aria-pressed') === 'false' ? 'down' : 'up';
    }

    function paintDirRows() {
      HT.SETTINGS.rows().forEach(r => {
        if (r.t !== 'dirNum') return;
        const n = q(`[data-f="${r.f}"]`);
        const p = q(`[data-f="${r.f2}"]`);
        /* 空就是空：0 与"没填"是两件事，前者写「增加0人」后者整侧不出现 */
        if (n) n.value = cfg[r.cfg] == null ? '' : cfg[r.cfg];
        if (p) p.value = cfg[r.cfg2] == null ? '' : cfg[r.cfg2];
        setDir(r.dir, cfg[r.dir]);
      });
    }

    function fill(c) {
      cfg = HT.normalizeCfg(c);
      /* 开关 / 数字 / 时间一律按 schema 走。
         0.24 及以前这里是十行手写赋值，加一个开关忘写一行，表现是
         "能点、但不落盘"——没有任何报错。 */
      HT.SETTINGS.bindable().forEach(r => {
        if (r.t === 'switch') { setSw(r.f, !!cfg[r.cfg]); return; }
        /* 多选（中心城区 / 起火原因 / 明细列）：配置里是顿号分隔的串，
           逐个认；没写分隔符的（手工改过配置）也认。选中的值留在 msSel，
           按钮里的摘要由 paintMS 写。 */
        if (r.t === 'msel') {
          msSel[r.f] = String(cfg[r.cfg] || '').split(/[、,，;；\s]+/).filter(Boolean);
          paintMS(r.f);
          return;
        }
        const el = q(`[data-f="${r.f}"]`);
        if (el) el.value = cfg[r.cfg];
      });
      paintDirRows();
      /* 人数那组也先给**正在用的**那一套：与模板同一个道理，出周报那几天
         进来就是本周的四个数，不必先点一下切换。 */
      planKey = cfg.period === 'week' ? 'week' : 'day';
      casShow(planKey);
      /* 界面手感：滑杆初值 + 读数 + 长按参数（都由 cfg.ui 推） */
      paintUi();
      /* 库与组合各留一份在内存里：编辑器编的是**库**，组合只存"接哪几段"。
         为什么都留副本：切来切去、改一半没保存就点别的，最后一次改动还得在；
         每次都从 cfg 读，等于把上一次的改动扔掉。 */
      lib = (cfg.tpls || []).map(t => Object.assign({}, t));
      combos = (cfg.combos || []).map(c => ({
        id: c.id,
        name: c.name,
        period: c.period === 'week' ? 'week' : 'day',
        ids: (c.ids || []).slice()
      }));
      /* 打开时先给**当前出稿的那一份**（cfg.pick）：出周报那几天进来就是周报，
         不必先点一下切换。 */
      curCid = (cfg.pick && cfg.pick[planKey]) || '';
      if (!comboOf(curCid)) curCid = (comboList()[0] || {}).id || '';
      paintTpSeg(false);
      if (ed) ed.load(lib);
      renderPlan();
      renderPick();
      /* 十五页铺开在一页里：先冲一次导航（首屏那一项 + 树上的标记条）。
         先把 curPane 清掉——这一块 DOM 是跨"打开 / 关闭"复用的，上一次在树里
         点过的折叠状态还留着，不清就会把上次的折叠当成这次的首屏。 */
      curPane = '';
      markPane(firstPaneKey());
      msg('');
    }

    /* 两段式确认：第一次点只"上膛"，四秒内再点一次才执行。

       为什么不用 confirm()：面板是注入到别人页面里的，原生对话框一弹就把整个
       页面卡住（连 Esc 都不归面板管），而且系统样式的框与整块面板的观感断层。
       为什么不用长按：长按只留给「恢复默认」——它是唯一一颗"一整排里最重"的。
       重置本组模板、还原这类"只影响一块"的动作走两段式：点错一下不会动手，
       两下才动手，但也不必按住不放。 */
    let armed = { key: '', until: 0 };
    function arm(key, hint) {
      const now = Date.now();
      const ok = armed.key === key && now < armed.until;
      armed = ok ? { key: '', until: 0 } : { key, until: now + 4000 };
      if (!ok) msg(hint);
      return ok;
    }

    /** 提示条：一行字进正文，处置与错误码进悬停——这一行很窄，塞不下两句。 */
    function msg(t, tip) {
      if (!msgEl) return;
      msgEl.textContent = t || '';
      msgEl.title = tip || '';
    }

    /* 下载回执。后台等到下载真正有了终态（下完 / 被拦 / 断流）才发这一条，
       所以下载中这一行会先停在"正在下载…"，不会被误读成已经好了——
       上一版正是拿到"任务已接下"就说"已开始下载"，而被安全浏览拦下的下载
       气泡会在这句话之后消失，看起来就是"点了没反应"。 */
    sayTo = (t, tip) => msg(t, tip);
    if (!dlHooked) {
      dlHooked = true;
      try {
        chrome.runtime.onMessage.addListener(m => {
          if (!m || m.type !== 'dlResult' || !sayTo) return;
          dlTick++;                        // 作废还没到点的超时兜底
          const r = HT.dlOut(m);
          sayTo(r.text, r.tip);
        });
      } catch (e) { /* 没有 runtime 监听权限时只是少一条回执，不影响别的 */ }
    }

    /**
     * 失败原因的一行化。
     * 与面板共用同一套事实文案（HT.errFact），只是这里空间小、不印短码。
     * 空原因兜成「未知原因」——否则屏幕上会出现「保存失败：」这样断掉的句子，
     * 看着像界面自己坏了。
     */
    function why(e) { return HT.errFact(e) || '未知原因'; }

    /* ── 云端配置 ───────────────────────────────────────── */
    /* 所有装了本扩展的电脑共用一份配置：没有同步码，也没有「上传 / 取回」按钮。
       打开设置页先对一次（限流 60 秒），之后每次保存由 config.js 的
       writePack 直接叫 HT.cloud.onCfgSaved()，不再经过界面。
       这一组没有一个是"配置项"（都不进 cfg），所以 collect() 不碰它们。 */
    let cloudMeta = null;

    /** 画一句状态 + 开关 + 覆盖后的还原入口。失败时额外露出「立即同步」 */
    async function paintCloud(patch) {
      const m = Object.assign({}, cloudMeta || {}, patch || {});
      const fresh = patch ? m : await HT.cloud.readMeta();
      cloudMeta = fresh;
      const el = q('[data-f="syncStat"]');
      if (el) el.textContent = HT.cloud.statusText(fresh);
      setSw('syncAuto', fresh.auto !== false);

      /* 「立即同步」平时是多余的按钮——自动同步就是它的全部工作。
         只有"没成功过"或"这次没传上去"的时候才露出来，那时人才需要一个手动重试。 */
      const nowBtn = q('[data-act="syncNow"]');
      if (nowBtn) nowBtn.hidden = !(fresh.fail || !fresh.at);

      const pv = await HT.cloud.prevInfo();
      const pvText = q('[data-f="syncPrev"]');
      const pvBtn = q('[data-act="syncRestore"]');
      if (pvBtn) pvBtn.hidden = !pv;
      /* 值只写时间（1.12.13）：那一行叫「恢复点」，本身就说明了这是什么，
         再补一句"覆盖前那份"是把行标签又说了一遍。没有底的时候留一个「—」，
         不整行隐藏——藏起来之后，人下次找不到这一项在哪儿。 */
      if (pvText) pvText.textContent = pv ? HT.cloud.when(pv.at) : '—';
    }

    /** 立即同步：跳过 60 秒限流，拉或推由 cloud.js 判 */
    async function syncNow() {
      msg('正在同步…');
      try {
        const r = await HT.cloud.boot({ force: true });
        if (r && r.pulled) {
          /* fill 会把整份配置画回界面，并清掉提示条，所以提示放在它后面 */
          fill(await HT.loadCfg());
          msg('已取回云端那份（' + HT.cloud.when(r.pulled) + (r.replaced ? '，本机原来那份已留底' : '') + '）');
        } else if (r && r.pushed) {
          msg('已传上云端');
        } else if (r && r.err) {
          msg('没同步成：' + r.err);
        } else {
          msg('已经是最新的，不用同步');
        }
      } catch (e) {
        msg('没同步成：' + why(e));
      }
      await paintCloud();
    }

    /** 还原被云端覆盖之前的本机那份（只留一层，用过就没了）。
     *  确认交给那颗长按按钮（1.12.16）：按住推满即是一次明确的"我要换回去"，
     *  再叠一个 confirm 是同一句话问两遍。 */
    async function syncRestore() {
      msg('正在还原…');
      try {
        await HT.cloud.restorePrev();
        fill(await HT.loadCfg());
        msg('已还原，并已传上云端');
      } catch (e) {
        msg('还原没成：' + why(e));
      }
      await paintCloud();
    }


    /* 1.2 起没有「用户」这一组：多用户档案撤掉了。
       同一台机器就是同一套配置，切换用户这个动作没人用，还占着设置页第一屏。
       存储里那份 profiles 仍然读得到（老机器不会丢配置），只是不再给界面入口。 */

    /* ── 多选（1.12.18 统一三处：中心城区 / 起火原因 / 明细列）────
       一行一颗按钮，点开是勾选清单。清单本身与模板编辑器的插入菜单共用
       openPop 那个抽屉——同一种浮层只该有一份开合行为。

       为什么值不放 DOM：这两个清单可能一个都不显示（按钮里只有摘要），
       以前"读框上的 checked"那套在收起后就没有真源了。 */
    const coreAll = () => {
      const all = DISTRICTS.slice();
      const sel = msSel.coreTowns;
      sel.forEach(n => {
        if (!all.some(d => shortName(d) === shortName(n))) all.push(n);
      });
      return all;
    };

    /** 这一张清单里有哪些项。行声明里的 items 允许是函数（导出列来自 contract） */
    function msItems(f) {
      if (f === 'coreTowns') return coreAll();
      const r = HT.SETTINGS.rows().filter(x => x.f === f)[0];
      const list = r && (typeof r.items === 'function' ? r.items() : r.items);
      return (list || []).slice();
    }
    /* 区域要比简称（「奉节」与「奉节县」是同一个人），别的项按原文比 */
    const msName = f => (f === 'coreTowns' ? shortName : (n => String(n)));

    /** 按钮里那句摘要：已选几项 + 前三个名字。一个没选就写「未选」。 */
    function paintMS(f) {
      const spans = root.querySelectorAll('[data-ms="' + f + '"]');
      const sel = msSel[f] || [];
      const nm = msName(f);
      const txt = sel.length
        ? `已选 ${sel.length} 项：` + sel.slice(0, 3).map(nm).join('、') + (sel.length > 3 ? ' 等' : '')
        : '未选';
      Array.prototype.forEach.call(spans, s => { s.textContent = txt; });
    }

    /** 勾选清单：搜索 + 列表 + 底部三个动作 */
    function drawMS(f, kw) {
      const k = String(kw || '').trim();
      const nm = msName(f);
      const sel = msSel[f] || [];
      const picked = n => sel.some(x => nm(x) === nm(n));
      const items = msItems(f).filter(n => !k || n.indexOf(k) >= 0 || nm(n).indexOf(k) >= 0);
      return '<div class="st-ms" data-msf="' + f + '">' +
        '<input class="st-in st-ms-q" type="search" placeholder="搜索" value="' + esc(k) + '">' +
        '<div class="st-ms-list">' + (items.length ? items.map(n =>
          `<label class="st-ms-i${picked(n) ? ' on' : ''}">
             <input type="checkbox" data-n="${esc(n)}"${picked(n) ? ' checked' : ''}>
             <span>${esc(nm(n))}</span></label>`).join('')
          : '<div class="st-ms-none">没有匹配的项</div>') + '</div>' +
        '<div class="st-ms-foot">' +
        '<button class="st-btn" type="button" data-act="msAll">全选</button>' +
        '<button class="st-btn" type="button" data-act="msNone">清空</button>' +
        '<span class="st-sp"></span>' +
        '<button class="st-btn st-primary" type="button" data-act="msDone">完成</button>' +
        '</div></div>';
    }

    /** 按清单的原始顺序重建选中值（导出列的列序就是清单顺序，不能按点击顺序存） */
    function msSet(f, want) {
      const nm = msName(f);
      const next = [];
      msItems(f).forEach(x => { if (want.some(y => nm(y) === nm(x))) next.push(x); });
      /* 配置里存着、清单里却已经没有的项：留着，别因为打开一次清单就把它删掉 */
      want.forEach(y => { if (!next.some(x => nm(x) === nm(y))) next.push(y); });
      msSel[f] = next;
      paintMS(f);
    }

    /* ── 浮层 ─────────────────────────────────────────────
       浮层本体留在设置页：中心城区选择器和模板编辑器共用同一个抽屉。
       "正在改哪个 chip" 属于编辑器自己的状态，已随编辑区一起搬走
       （src/ui/editor.js 的 editChip），这里不再留一份。 */
    let popOwner = null;

    function closePop() {
      pop.hidden = true;
      pop.innerHTML = '';
      popOwner = null;
      qa('[aria-expanded="true"]').forEach(b => b.setAttribute('aria-expanded', 'false'));
    }

    /** 弹出层：wide=true 时铺满编辑区宽度（插入菜单用），否则锚在按钮左边缘 */
    function openPop(anchor, html, wide) {
      closePop();
      popOwner = anchor;
      pop.innerHTML = html;
      pop.hidden = false;
      pop.classList.toggle('is-wide', !!wide);
      /* 锚点也可能是一个正文标签（改指标时），它不是按钮，别给它挂 aria-expanded */
      if (anchor.tagName === 'BUTTON') anchor.setAttribute('aria-expanded', 'true');
      const r = anchor.getBoundingClientRect();
      const hr = root.getBoundingClientRect();
      if (wide) {
        // 铺满：锚在按钮下，左右各留 4px。不这么做的话浮层只有 246px 宽、
        // 又对齐到按钮左沿，左边会露出半截 chip，看着像画错了。
        pop.style.left = '';
        pop.style.right = '';
      } else {
        const w = pop.offsetWidth || 260;
        let left = r.left - hr.left;
        left = Math.max(4, Math.min(left, Math.max(4, hr.width - w - 4)));
        pop.style.left = left + 'px';
      }
      /* 垂直方向要现算：编辑区在滚动容器里，锚点可能在面板下半部，
         而插入菜单有近 300px 高。只按"锚点下方"摆，浮层会伸到面板外面、
         压到网页上（面板本身没有裁切，看起来像画错了）。
         先按下方摆，量完高度再看放不放得下；放不下就翻到上方；
         上下都不够（面板很矮）就贴底，至少保证整块都在面板里。 */
      let top = Math.max(4, r.bottom - hr.top + 6);
      const room = (hr.height || root.clientHeight || 0) - 8;
      const ph = pop.offsetHeight || 0;
      if (ph && top + ph > room) {
        const up = r.top - hr.top - ph - 6;
        top = up >= 4 ? up : Math.max(4, room - ph);
      }
      pop.style.top = top + 'px';
      const inp = pop.querySelector('.st-ms-q');
      if (inp) { try { inp.focus({ preventScroll: true }); } catch (e) { } }
    }

    /* ── 文字模板编辑器 ───────────────────────────────────
       列表、编辑区、chip、三级级联全在 src/ui/editor.js（0.25.0 拆出）。
       这里只做一件事：把浮层与提示条注入进去。浮层是中心城区选择器
       共用的，不能让编辑器自己再造一个——同一个抽屉两种开合手感，
       用户会以为点错了。

       （1.14.0）它装的是**库**，不是某一组组合里的段落：改一句话不必先想
       "我在改哪份组合里的这一段"。改完之后组合那边只是"接的那几段"跟着变字。
       编辑器自己管理自己那棵子树的事件，所以下面的事件分发里
       看不到 tplOn / edit / up / down / del 这些动作。
       onChange 让「文稿组合」页的清单跟着更新（改标题、删掉一条之后，
       那边现在接的这几行要立刻对得上）。 */
    const ed = HT.mountEditor({
      box: libBox, pop, openPop, closePop, msg,
      onChange: () => {
        libStash();
        /* 库里删掉一条之后，组合里那串 id 要当场把孤儿摘掉：留着它会显示
           "（库中已没有这一段）"，而保存时归一化也会把它过滤掉——
           界面与存储就短暂地不是一个东西，中间那一下最难解释。
           摘空了补回第一条：空组合出的是空稿，比"接错一段"更难查。 */
        const live = lib.map(t => t.id);
        let dirty = false;
        combos.forEach(c => {
          const before = (c.ids || []).join(',');
          c.ids = (c.ids || []).filter(x => live.indexOf(x) >= 0);
          if (!c.ids.length && live.length) c.ids = [live[0]];
          if (c.ids.join(',') !== before) dirty = true;
        });
        /* 只有 id 列表真的变了才重画组合列表：改标题时每一键都重画会把
           行内改名框（.st-gname-in）冲掉，人正打着字就丢了。 */
        if (dirty) renderPlan();
        renderPick();
      }
    });

    /* ── 两层：文字模板库 → 文稿组合（1.14.0）──────────────────
       lib     —— 库，日 / 周共用这一份（编辑器持有它）；
       combos  —— 组合：一个名字 + 一个周期 + 一串模板 **id**；
       planKey —— 现在看的是哪一叠（与标题栏那颗日 / 周同一个维度）；
       curCid  —— 当前这一份组合。

       组合里存 id 而不是段落，是因为同一段文字要同时接在日报与周报里：
       存两份拷贝的话，"改一处还得记得去另一处再改一遍"。代价是改一条
       会同时改到所有接了它的组合——这正是集中管理要的效果。

       周期在组合上（而不是模板上）：一个组合从头到尾按一种窗口取数。
       周报要报当日，就把当日那几条**接进周组合**——它在周窗口下取数，
       W.DAY 仍是条件时间那一天，与旧「周方案接日套件」的结果逐段一致。 */
    const planBox = root.querySelector('[data-f="plan"]');

    let planKey = 'day';
    let lib = [];
    let combos = [];
    let curCid = '';

    const comboOf = id => combos.filter(c => c.id === id)[0] || null;
    const comboList = () => combos.filter(c => c.period === planKey);
    const libOf = id => lib.filter(t => t.id === id)[0] || null;
    const pTxt = p => (p === 'week' ? '周' : '日');
    /** 这一份组合接的模板（顺序即出稿顺序）。库里已删掉的 id 自动跳过 */
    const pickTpls = c => ((c && c.ids) || []).map(libOf).filter(Boolean);
    /** 接了几段"开着的"：关掉的段不进稿子，所以计数只算开着的那些 */
    const segN = c => pickTpls(c).filter(t => t.on !== false).length;

    function newCid() {
      return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4);
    }

    /** 把编辑器里这份库抄回内存（不落盘） */
    function libStash() {
      if (!ed) return;
      lib = ed.value().map(t => ({
        id: t.id, title: t.title, on: t.on, text: String(t.text || '')
      }));
    }

    /* ── 日 / 周的滑块（1.13.0）─────────────────────────────
       与标题栏那颗**同一个控件**（.ht-per + 强调色滑块），只是这两处作用在
       "编哪一叠组合"上。以前设置页用的是另一套 .ht-seg（只有底色没有滑块），
       同一件东西在面板与设置里长两个样——用户点名要统一。
       结构只建一次（滑块 + 两份字的副本），之后只改 on 与滑块位置：
       每次重建会把滑块量几何的时机搞乱，入场那一下会闪。 */
    const PER_WORD = {
      tpseg: { day: '日', week: '周' },
      casseg: { day: '每日', week: '每周' }
    };

    function mountPer(box, words) {
      if (!box || box.querySelector('.ht-thumb')) return;
      box.innerHTML = '<i class="ht-thumb" aria-hidden="true">' +
        '<span class="ht-per-copy">' + words.day + '</span>' +
        '<span class="ht-per-copy">' + words.week + '</span></i>' +
        '<button type="button" data-per="day" aria-checked="false">' + words.day + '</button>' +
        '<button type="button" data-per="week" aria-checked="false">' + words.week + '</button>';
    }

    function paintPer(box, cur, animate) {
      if (!box) return;
      const el = box.querySelector('[data-per="' + cur + '"]');
      const thumb = box.querySelector('.ht-thumb');
      box.querySelectorAll('[data-per]').forEach(b => {
        const on = b === el;
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
      });
      if (el && HT.slideThumb) HT.slideThumb(box, thumb, el, animate);
      /* 贴好之后才显形（`.ht-thumb` 平时 opacity:0，裁剪窗口还没算时
         显出来会闪一条满宽蓝底）。判据取 __edges：滑块没量到宽度就不贴，
         这时也不许显形——只在"确实落到了某一格"时点亮它。 */
      if (thumb && thumb.__edges) thumb.classList.add('is-placed');
    }

    /** 文稿组合页顶上那一颗：与 planKey 同源 */
    function paintTpSeg(animate) {
      const box = q('[data-f="tpseg"]');
      if (!box) return;
      mountPer(box, PER_WORD.tpseg);
      paintPer(box, planKey, animate);
    }

    /** 组合列表：该周期有哪几份，当前编的那份高亮。
     *  行是"选哪一份来编"，不是出稿顺序——一次只出一份组合，
     *  所以没有上下移，也没有"移出 / 加入"。 */
    function renderPlan() {
      if (!planBox) return;
      const list = comboList();
      const total = list.reduce((n, c) => n + segN(c), 0);
      const rows = list.map((c, i) => {
        const on = c.id === curCid;
        return '<li class="st-pitem' + (on ? ' is-cur' : '') + '" data-cid="' + esc(c.id) + '">' +
          '<button class="st-pick" type="button" data-act="comboPick" data-cid="' + esc(c.id) + '">' +
          '<span class="st-pn">' + (i + 1) + '</span>' +
          '<span class="st-pname">' + esc(c.name) + '</span>' +
          '<span class="st-pmeta">' + segN(c) + ' 段</span>' +
          '</button></li>';
      }).join('');
      planBox.innerHTML =
        '<div class="st-plan-hd"><span class="st-k">' + pTxt(planKey) + '简报</span>' +
        '<span class="st-pmeta">' + list.length + ' 份 · 共 ' + total + ' 段</span></div>' +
        '<ol class="st-plist">' + rows + '</ol>';
      /* 标题栏那颗「删除」只在还有别的组合时可用：删掉最后一份，
         归一化会补回出厂那份，界面上"删空了、保存后又冒出来"只会让人以为没保存上。 */
      const del = root.querySelector('[data-hold="comboDel"]');
      if (del) del.hidden = list.length <= 1;
      /* 「重置」只对出厂那两份有意义：自建组合没有"出厂清单"可退，
         按下去什么也不会发生——不如收起，别给一颗按了没反应的按钮。 */
      const rb = root.querySelector('[data-act="comboReset"]');
      if (rb) {
        const c = comboOf(curCid);
        rb.hidden = !(c && HT.DEFAULT_COMBOS.some(d => d.id === c.id));
      }
    }

    /** 这一份组合接的那几段：一串**引用**，顺序即出稿顺序。
     *
     *  这里没有正文——改字去「文字模板」页。行内只有三件事：往上、往下、
     *  移出。关掉的模板照样列出来但标「已停用」：它还在接法里，只是这一期
     *  不进稿子，直接藏掉会让人以为"我明明加过"。 */
    function renderPick() {
      if (!pickBox) return;
      const c = comboOf(curCid);
      const ids = (c && c.ids) || [];
      const rows = ids.map((id, i) => {
        const t = libOf(id);
        const off = !t || t.on === false;
        return '<li class="st-pitem' + (off ? ' is-off' : '') + '" data-tid="' + esc(id) + '">' +
          '<span class="st-pick">' +
          '<span class="st-pn">' + (i + 1) + '</span>' +
          '<span class="st-pname">' + esc(t ? t.title : '（库中已没有这一段）') + '</span>' +
          (off ? '<span class="st-pmeta">已停用</span>' : '') +
          '</span>' +
          '<span class="st-pacts">' +
          '<button class="st-pb" type="button" data-act="pickUp" data-tid="' + esc(id) + '"' +
          (i === 0 ? ' disabled' : '') + ' aria-label="上移">' + HT.ICON.arrowUp + '</button>' +
          '<button class="st-pb" type="button" data-act="pickDown" data-tid="' + esc(id) + '"' +
          (i === ids.length - 1 ? ' disabled' : '') + ' aria-label="下移">' + HT.ICON.arrowDown + '</button>' +
          '<button class="st-pb" type="button" data-act="pickOut" data-tid="' + esc(id) + '"' +
          ' aria-label="从本组合移出">' + HT.ICON.x + '</button>' +
          '</span></li>';
      }).join('');
      const rest = lib.filter(t => ids.indexOf(t.id) < 0);
      pickBox.innerHTML =
        '<div class="st-plan-hd"><span class="st-k">本组合接的段</span>' +
        '<span class="st-pmeta">' + ids.length + ' 段 · 文字模板共 ' + lib.length + ' 条</span></div>' +
        (rows ? '<ol class="st-plist">' + rows + '</ol>' : '<p class="st-hint">这一段还什么都没接。</p>') +
        '<div class="st-addrow"><button class="st-btn" type="button" data-act="pickAdd"' +
        (rest.length ? '' : ' disabled') + '>' +
        (rest.length ? '添加段落' : '库里没有可加的模板') + '</button></div>';
    }

    /** 换一份组合来看：只换清单，编辑器那边动都不动（它装的是库） */
    function loadCombo(id) {
      const c = comboOf(id);
      if (!c) return;
      curCid = id;
      renderPlan();
      renderPick();
    }

    /** 切日 / 周：换一叠组合来看（每份组合自带周期，所以这里换的是"看哪一叠"） */
    function setPlan(p) {
      const k = p === 'week' ? 'week' : 'day';
      if (k === planKey) return;
      planKey = k;
      paintTpSeg(true);
      casShow(k);
      /* 这一叠里没有刚才看的那份就换第一份——不然上面列表亮着 A、
         下面的清单还是 B 那几段，两处说的是两件事。 */
      if (comboList().every(c => c.id !== curCid)) curCid = (comboList()[0] || {}).id || '';
      renderPlan();
      renderPick();
    }

    /* ── 组合里那几段：加 / 移出 / 排序（1.14.0）────────────── */

    /** 把库里的模板追加到这份组合末尾。加进来的顺序按库里点的那一条，
     *  不再按库的顺序——"我点的是这一条"应当就是"它排在最后"，
     *  追问"它在库里排第几"没有意义。 */
    function pickAdd(id) {
      const c = comboOf(curCid);
      if (!c || !id) return;
      if (c.ids.indexOf(id) >= 0) return;
      if (c.ids.length >= HT.MAX_TPL) { msg('一份组合最多接 ' + HT.MAX_TPL + ' 段'); return; }
      c.ids.push(id);
      renderPick();
    }

    /** 打开「添加段落」浮层：只列库里还没接上的那些 */
    function openPickAdd(anchor) {
      const c = comboOf(curCid);
      if (!c) return;
      if (c.ids.length >= HT.MAX_TPL) { msg('一份组合最多接 ' + HT.MAX_TPL + ' 段'); return; }
      const rest = lib.filter(t => c.ids.indexOf(t.id) < 0);
      if (!rest.length) { msg('库里每一条都接上了；要加新的去「文字模板」新建'); return; }
      openPop(anchor,
        '<div class="st-pop-g">添加段落</div>' +
        rest.map(t => '<button class="st-pop-i" type="button" data-act="pickAddOne" data-tid="' +
          esc(t.id) + '">' + esc(t.title) +
          (t.on === false ? '<span class="st-pmeta">已停用</span>' : '') + '</button>').join(''),
        false);
    }

    /** 上移 / 下移：只换这一条的位置，别的段不动 */
    function pickMove(anchor, d) {
      const c = comboOf(curCid);
      if (!c) return;
      const id = anchor.getAttribute('data-tid');
      const i = c.ids.indexOf(id);
      const j = i + d;
      if (i < 0 || j < 0 || j >= c.ids.length) return;
      const t = c.ids[i];
      c.ids[i] = c.ids[j];
      c.ids[j] = t;
      renderPick();
    }

    /** 从这份组合移出：模板本身还在库里，随时能加回来。
     *  最后一段不许移出——空组合出的是空稿，比"接错一段"更难查。 */
    function pickOut(anchor) {
      const c = comboOf(curCid);
      if (!c) return;
      if (c.ids.length <= 1) { msg('一份组合至少接一段；想换内容先把别的加进来'); return; }
      const id = anchor.getAttribute('data-tid');
      c.ids = c.ids.filter(x => x !== id);
      renderPick();
    }


    /* ── 人数两套：每日 / 每周（1.12.0）────────────────────────
       两套行同时在 DOM 里（由 schema 的 set 标记），这里只切换"看得见哪一套"。
       为什么不像模板那样存一份内存副本：模板的编辑区只有一块，换内容就得先收回来；
       输入框是各自一个，切走的那套值就留在自己的框里，保存时一并收走。 */
    function casShow(k) {
      bodyBox.dataset.casset = k === 'week' ? 'week' : 'day';
      paintCasSeg();
    }

    /** 人数那对「每日 / 每周」：与文稿组合页那颗是同款滑块，只是字长一点 */
    function paintCasSeg(animate) {
      const box = q('[data-f="casseg"]');
      if (!box) return;
      mountPer(box, PER_WORD.casseg);
      paintPer(box, bodyBox.dataset.casset === 'week' ? 'week' : 'day', animate);
    }


    /** 界面手感那一组：滑杆初值、读数、分类树的预览、长按参数 */
    function paintUi() {
      HT.SETTINGS.uiRows().forEach(r => {
        const v = cfg.ui && cfg.ui[r.part] ? cfg.ui[r.part][r.key] : undefined;
        if (r.t === 'switch') { setSw(r.f, v !== false); return; }
        const el = q(`[data-f="${r.f}"]`);
        if (!el) return;
        if (v != null) el.value = v;
        paintRv(r);
      });
      if (HT.applyNav) HT.applyNav(bodyBox, cfg.ui && cfg.ui.nav);
      if (HT.applyUi) HT.applyUi(bodyBox, cfg.ui);
      wireHold();
      paintCasSeg();
    }

    /* ── 收集并保存 ─────────────────────────────────────── */
    function collect() {
      ed.flush();
      /* 与 fill() 同一份 schema：界面上有几个可读写项，这里就收几个。
         空值的回落规则仍按行声明（empty），与 0.24 手写版的语义逐字一致：
         数字走 `Number(v) || 回落`，时间走 `v || 回落`。 */
      const ov = {};
      HT.SETTINGS.bindable().forEach(r => {
        if (r.t === 'switch') { ov[r.cfg] = getSw(r.f); return; }
        /* 多选：按界面上的选中值拼回顿号串。全不勾就是空串——
           语义是"一个都不点名"（起火原因只剩一句「其余正在调查中」，
           明细列则不出文件），不做"空就回退全部"的隐藏兜底（那会让取消勾选毫无效果）。 */
        if (r.t === 'msel') {
          ov[r.cfg] = (msSel[r.f] || []).join('、');
          return;
        }
        const el = q(`[data-f="${r.f}"]`);
        const raw = el ? el.value : '';
        if (r.t === 'num') {
          const s = String(raw == null ? '' : raw).trim();
          const n = s === '' ? NaN : Number(s);
          /* 空格子：行上给了 empty 就用它（''= "这一项没填"，与 0 是两件事——
             受伤人数填 0 是"没人受伤"，空着是"照抄平台"）；
             没给 empty 的（冷却秒数这类本来就没有"没填"状态）按 0 存。 */
          ov[r.cfg] = Number.isFinite(n) ? n : (r.empty != null ? r.empty : 0);
        } else {
          ov[r.cfg] = raw || r.empty;
        }
      });
      /* 同比那一行：两个数字 + 一个方向。方向不在 bindable 里（它不是 input），
         但必须和数字一起收——否则界面上点了「减少」、存下来还是「增加」。 */
      HT.SETTINGS.rows().forEach(r => {
        if (r.t !== 'dirNum') return;
        const n = q(`[data-f="${r.f}"]`);
        const p = q(`[data-f="${r.f2}"]`);
        ov[r.cfg] = n ? String(n.value).trim() : '';
        /* 幅度那一格在每周那套里根本没画（句子不带百分比，见 settings-schema 的 noPct）。
           没画就**别清**：留着原值，免得哪天把周报改回去、数已经没了。 */
        ov[r.cfg2] = p ? String(p.value).trim() : (cfg[r.cfg2] == null ? '' : cfg[r.cfg2]);
        ov[r.dir] = readDir(r.dir);
      });
      /* 编辑器里那份库先收进内存，再把整份结构交出去：
         库要过 prune / tooLong（它可能刚被改过），组合只带那串 id。 */
      libStash();
      const c = Object.assign({}, cfg, ov, {
        /* 界面手感：嵌套一层，按 part + key 组装。
           与 cfg.ui 深合并，将来多一个没画出来的 part 也不会被这份覆盖掉。 */
        ui: mergeUi(cfg.ui, uiFromDom()),
        /* 周期：**不改**。文稿组合页顶上那颗日 / 周切的是"我在编哪一叠"，
           是看一眼、改一句就走的临时态；而 cfg.period 是"这一期出日报还是周报"，
           归标题栏那颗管（1.13.0）。
           早先这里写 period: planKey，等于"打开设置改一句周报的措辞，
           存完标题栏自己跳成周报"——主控在面板上，不该被配置页偷偷改掉。 */
        period: cfg.period === 'week' ? 'week' : 'day',
        /* 文字模板库：一段一段的文字本身，日 / 周共用这一份。
           不截断（见 editor.js 里 flush 的注释）：超长的段落由下面的 tooLong 拦下来，
           让用户自己删，而不是替他剪一刀然后假装保存成功。 */
        tpls: lib.map(t => ({ id: t.id, title: t.title, on: t.on, text: String(t.text || '') })),
        /* 组合只存"接哪几段、谁在前"——正文在 tpls 里，这里存 id（1.14.0） */
        combos: combos.map(cb => ({
          id: cb.id,
          name: cb.name,
          period: cb.period,
          ids: (cb.ids || []).slice()
        })),
        /* 当前这份就是这一期要出的：同周期可以有多个组合，选哪份来编 = 出哪份。
           另一个周期的选择原样留着（没碰它，就不该被这次保存改掉）。 */
        pick: Object.assign({}, cfg.pick, curCid ? { [planKey]: curCid } : {})
      });
      /* templates / weekTemplates 早已退役（1.13.0）：它们曾经是"与组合里那份
         同一个数组"的派生视图，最容易被误改。删掉，只留 tpls + combos 两处真源。 */
      delete c.templates;
      delete c.weekTemplates;
      /* 失效占位符在 domain 层清（那里才知道字段目录）。
         记下"哪一段掉了哪几个"，只报总数等于让人自己去找半句话。
         库是共用的一份，清一遍就够——组合里存的是 id，没有正文可清。 */
      const drops = [];
      const tooLong = [];
      c.tpls.forEach((t, i) => {
        const r = HT.prune(t.text);
        t.text = r.text;
        if (r.dropped) drops.push({ title: t.title || ('第' + (i + 1) + '段'), n: r.dropped, gone: r.gone });
        if (t.text.length > HT.TPL_MAX) tooLong.push({ n: t.text.length, title: t.title || '未命名段落' });
      });
      return { cfg: HT.normalizeCfg(c), drops, tooLong };
    }

    async function save() {
      const r = collect();
      /* 超长必须挡在保存之前：静默截断会切坏占位符，正文里留下半截代码 */
      if (r.tooLong.length) {
        msg(r.tooLong.map(x => `${x.title}已 ${x.n} 字，上限 ${HT.TPL_MAX} 字，请删减后再保存`).join('；'));
        return false;
      }
      /* 改名不在这里做：它有自己的确认/取消，点了立刻生效。
         混进"保存"会造成两种时序——先改名再保存，中途失败就出现"名字变了、配置没存"。 */
      let ok = false;
      try {
        ok = await HT.saveCfg(r.cfg);
      } catch (e) {
        /* 读不到存储时 saveCfg 会 reject：这时**不能**继续用一份空配置往下走 */
        msg('保存失败：' + why(e));
        return false;
      }
      cfg = r.cfg;
      msg(!ok ? '保存失败：写入被拒绝，可能是空间不足' : dropNote(r.drops));
      if (ok && o.onSaved) o.onSaved(r.cfg);
      /* 不再在这里排上传：saveCfg → writePack 里已经挂了钩子，
         这里再来一次就会双发（而且面板改基准时间那条路根本走不到这儿）。 */
      return ok;
    }

    /**
     * 失效项提示：说清在哪一段、掉了哪几个、**为什么掉**。
     *
     * 原来只说"清掉 1 个失效项…请检查那几句是否还完整"——读的人第一反应是
     * "我是不是写坏了"，而实际上绝大多数是升级前模板里的旧字段被撤掉了。
     * 撤掉的那些在 render.js 的 RETIRED 里有死因，这里拼出来；
     * 认不出的键就说"多半是升级前的旧写法"，并说明保存一次之后不再提示。
     */
    function dropNote(drops) {
      if (!drops || !drops.length) return '已保存';
      const total = drops.reduce((s, d) => s + d.n, 0);
      const keys = [];
      const where = drops.map(d => {
        const g = d.gone || [];
        g.forEach(k => keys.push(k));
        const k = g.slice(0, 3).join('、');
        return `${d.title} ${d.n} 个${k ? '（' + k + (g.length > 3 ? ' 等' : '') + '）' : ''}`;
      }).join('；');

      const R = HT.RETIRED || {};
      const known = keys.map(k => R[k]).filter(Boolean)[0];
      const why = known
        ? `这些字段已经不在可选范围里了——${known}。`
        : '这些字段已经不在可选范围里了（多半是升级前模板里的旧写法）。'
        + '需要的话从插入菜单重新选一次。';
      return `已保存。模板里有 ${total} 个占位符被移除了：${where}。`
        + why + '这一步已经改在你的模板里，再保存一次就不会提示。';
    }

    /** 「文字模板」页的重置：整库退回出厂那六条。
     *
     *  它管的是**字**：某几段被改坏了、想从头来一遍。与组合无关——
     *  组合接不接、怎么排序，这一颗一概不动。
     *  不做 confirm，也不长按（长按只留给「恢复默认」与「删除组合」）：
     *  普通按钮，第一下上膛、第二下动手，见 arm()。 */
    function libReset() {
      lib = (HT.DEFAULT_LIB || []).map(t => Object.assign({}, t));
      if (ed) ed.load(lib);
      renderPick();
      msg('文字模板已恢复出厂六条，记得保存');
    }

    /** 「文稿组合」页的重置：这份组合接的段落与名字退回出厂。
     *
     *  只对出厂那两份有意义——自建组合没有"出厂清单"可退，那颗按钮在
     *  renderPlan 里已经收起。正文一概不碰：字归「文字模板」页。
     *  两段式确认（arm），理由同上一颗。 */
    function comboReset() {
      const c = comboOf(curCid);
      if (!c) return;
      const def = HT.DEFAULT_COMBOS.filter(d => d.id === c.id)[0];
      if (!def) { msg('自建的组合没有出厂清单可退'); return; }
      c.ids = def.ids.slice();
      c.name = def.name;
      renderPlan();
      renderPick();
      msg('这一份组合已恢复出厂（只改了接哪几段），记得保存');
    }

    /** 新建一份组合：接库里第一条（周期跟当前这一叠），直接选中它。
     *  为什么给一段而不是全空：空组合出的是空稿，比"接错一段"更难查。
     *  为什么一开始就选中：新建一份却看不见它在哪儿，下一步还得自己去找。 */
    function comboAdd() {
      if (combos.length >= HT.MAX_COMBOS) { msg('最多 ' + HT.MAX_COMBOS + ' 份组合'); return; }
      libStash();
      const n = comboList().length + 1;
      const first = lib.filter(t => t.on !== false)[0] || lib[0];
      const c = {
        id: newCid(),
        name: '新组合' + n,
        period: planKey,
        ids: first ? [first.id] : []
      };
      combos.push(c);
      curCid = c.id;
      renderPlan();
      renderPick();
      msg('已新建组合，接着在下面增减段落，记得保存');
    }

    /** 删掉正在编的这一份：连段落一起消失，没有撤销（按钮是长按 + 警告色）。
     *  这一叠只剩一份时不动手——删空了归一化会补回出厂那份，
     *  "删掉又冒出来"会让人以为没保存上。 */
    function comboDel() {
      const c = comboOf(curCid);
      if (!c) return;
      if (comboList().length <= 1) {
        msg('这是「' + pTxt(planKey) + '」唯一的一份组合，想换内容请新建后再删');
        return;
      }
      const name = c.name;
      combos = combos.filter(x => x.id !== c.id);
      curCid = '';
      const next = comboList()[0];
      if (next) loadCombo(next.id);
      else { renderPlan(); renderPick(); }
      msg('已删除「' + name + '」，记得保存');
    }

    async function reset() {
      /* 没有 confirm：按住不放本身就是确认（见 BTN_RESET 的注释）。
         再弹一个框等于问两遍同一件事。
         模板不在这里单独赋值：fill() 会整份交给编辑器，TEMPLATES 也由它深拷贝，
         这样 DEFAULT_TEMPLATES 不会被界面改坏（下次另一个档案还会用到它）。 */
      fill(HT.DEFAULT_CFG);
      msg('已恢复默认，记得保存');
    }

    /**
     * 导出备份。文件名带日期：同一个人可能存好几份（换机前、改模板前），
     * 不带日期的话第二次导出的文件会把第一份盖掉。
     */
    async function exportBackup() {
      try {
        const pack = await HT.exportCfg();
        const name = `简报助手备份-${new Date().toISOString().slice(0, 10)}.json`;
        /* 走共用出口（feedback.js 的 HT.download）。第三个参数之后不传 BOM：
           JSON 开头多三个字节，下次导入时 JSON.parse 会直接报错。 */
        HT.download(name, JSON.stringify(pack, null, 2), 'application/json');
        msg(`已导出 ${name}`);
      } catch (e) {
        msg('导出失败：' + why(e));
      }
    }

    /** 存储占用：四段模板只占几十 KB，但要让这个数字看得见，人才不用凭感觉担心 */
    async function showUsed() {
      const el = q('[data-f="used"]');
      if (!el) return;
      const u = await HT.storageInfo();
      if (u.unknown) { el.textContent = '—'; return; }
      const kb = u.used / 1024;
      el.textContent = `${kb < 1 ? '<1' : Math.round(kb)} KB / 10 MB`;
    }

    /* ── 诊断 ───────────────────────────────────────────── */
    /* 这一屏显示的是本机留痕，不是"日志文件"。一条只有三样：
       短码、模块、校验项名。数字一个都没记——所以它随手可以截图发人。
       谁能被记下来、记成什么样，全部由调用点与 domain/report.js 决定；
       这里只负责显示，不解释，也不推断。 */
    /* 上报状态只读 background 记的那一条（K_DIAG）：面板出错时自动发过一份，
       这里只是把"上次发到没发出去"摆出来，不再自己发请求。 */
    function askStat() {
      return new Promise(res => {
        try {
          chrome.runtime.sendMessage({ type: 'diagStat' }, r => {
            if (chrome.runtime.lastError || !r) return res(null);
            res(r);
          });
        } catch (e) { res(null); }
      });
    }

    /* 一句话说清"报没报出去"。使用者要知道的只有一件：这台机器现在是不是正常的。
       真要排查，维护者看的是服务器上那份日报，不是这一行。 */
    function paintStat(s) {
      const el = q('[data-f="obsStat"]');
      if (!el) return;
      el.title = '';
      if (!s) { el.textContent = '无法读取'; return; }
      if (!s.enabled) { el.textContent = '已关闭'; return; }
      if (!s.last || !s.last.at) { el.textContent = '运行正常'; return; }
      const m = Math.floor((Date.now() - s.last.at) / 60000);
      const when = m < 1 ? '刚刚' : m < 60 ? m + ' 分钟前'
        : m < 1440 ? Math.floor(m / 60) + ' 小时前' : Math.floor(m / 1440) + ' 天前';
      el.textContent = s.last.ok
        ? '运行正常 · 最近 ' + when
        : '最近一次未送达（' + when + '）';
    }

    /* 登录票据。只报事实：票面时间记的是签发那一刻，实测与能否取数无关
       （过期几小时照样取数，第二天首次打开才要重登），所以不打倒计时，
       扩展这边也没有换票的入口——摆一颗"续期"按钮是骗人的。
       独立设置页（options.html）跑在扩展自己的 origin 上，读不到站点的
       localStorage：那一档直说"需在站点页面查看"，不要假装"未登录"。 */
    function paintSess() {
      const el = q('[data-f="sessStat"]');
      if (!el) return;
      el.title = '';
      let onSite = false;
      try { onSite = g.location.origin === HT.ORIGIN; } catch (e) { }
      if (!onSite) { el.textContent = '需在站点页面查看'; return; }
      let li = null;
      try { li = HT.loginInfo(); } catch (e) { }
      if (!li) { el.textContent = '无法读取'; return; }
      if (!li.hasToken) { el.textContent = '未登录'; return; }
      /* 只答"页面里有没有票"。票面时间照实写在悬停里，但不做倒计时：
         票面 30 分钟只记签发那一刻，实测过期几小时仍能取数，倒计时会误导。 */
      el.textContent = '已登录';
      if (li.unknown) { el.title = '票据里没有可读的时间字段'; return; }
      el.title = '票面 ' + new Date(li.exp).toLocaleString()
        + '（只记签发那一刻，与能否取数无关）';
    }

    /* ── 事件 ─────────────────────────────────────────────
       模板列表（含编辑区、工具栏、行内按钮）和浮层里的页签 / 三级级联，
       事件全部由 src/ui/editor.js 自己绑、自己 stopPropagation。
       这里只剩"设置页本身"的动作：档案、开关、命令按钮。
       编辑器处理过的事件不会冒泡到这里，所以下面看不到 tplOn/edit/up/down/del。 */

    function onClick(e) {
      /* 分类树（1.12.16）：点分组只折叠 / 展开，点叶子才切页。
         这两颗不是 button[data-act]，所以在最前面单独认。 */
      const nit = e.target.closest ? e.target.closest('[data-nav]') : null;
      if (nit) { showPane(nit.getAttribute('data-nav')); return; }
      const nsec = e.target.closest ? e.target.closest('[data-navsec]') : null;
      if (nsec) { foldSec(nsec.getAttribute('data-navsec')); return; }

      /* 日 / 周的滑块：文稿组合页那颗切"编哪一叠"，人数页那颗切"填哪一套"。
         它们不是 button[data-act]（.ht-per 里的按钮只带 data-per），
         所以得在 data-act 之前认——否则会落到"点了空白处"那条分支上。 */
      const per = e.target.closest ? e.target.closest('.ht-per [data-per]') : null;
      if (per) {
        const box = per.closest('.ht-per');
        const to = per.getAttribute('data-per') === 'week' ? 'week' : 'day';
        if (box.getAttribute('data-f') === 'tpseg') setPlan(to);
        else if (box.getAttribute('data-f') === 'casseg') { casShow(to); paintCasSeg(true); }
        return;
      }

      /* 同比的方向按钮：点一下在「增加 / 减少」之间翻，后面的「上升 / 下降」跟着变。
         只改界面，存盘走 collect（与旁边的数字一起收）。 */
      const dir = e.target.closest ? e.target.closest('.st-dir[data-dir]') : null;
      if (dir) {
        const name = dir.dataset.dir;
        setDir(name, readDir(name) === 'down' ? 'up' : 'down');
        return;
      }

      const sw = e.target.closest('.st-sw');
      if (sw) {
        const on = sw.getAttribute('aria-checked') !== 'true';
        sw.setAttribute('aria-checked', on ? 'true' : 'false');
        /* 这个开关不绑 cfg（它不在配置里，见上面云端那一段），
           所以得自己落盘，否则"点了、关了页、下次又是开着的" */
        if (sw.dataset.f === 'syncAuto') {
          HT.cloud.writeMeta({ auto: on }).then(() => {
            paintCloud({ auto: on });
            msg(on ? '已打开：改完自动传，打开站点自动取' : '已关闭自动同步，配置只存本机');
            /* 刚打开就该立刻对一次，别等下一次保存或下次开页面 */
            if (on) HT.cloud.boot({ force: true }).then(() => paintCloud());
          });
        }
        return;
      }

      const b = e.target.closest('button[data-act]');
      if (!b) {
        /* 点空白处收掉浮层（编辑区里的点击由编辑器 stopPropagation 拦住了） */
        if (!pop.hidden && !pop.contains(e.target)) closePop();
        return;
      }
      const act = b.dataset.act;

      /* 长按按钮（恢复默认 / 还原）由 HT.hold 接管：
         一次普通点击走到这里就到此为止，动作只在液面推满时由它回调。 */
      if (b.hasAttribute('data-hold')) return;

      if (act === 'uiReset') {
        /* 只退这一组参数：滑杆拖歪了，不该为了一个数把整页设置清掉 */
        const part = b.getAttribute('data-part');
        const def = (HT.DEFAULT_UI && HT.DEFAULT_UI[part]) || null;
        if (!def) return;
        HT.SETTINGS.uiRows().filter(r => r.part === part).forEach(r => {
          if (r.t === 'switch') { setSw(r.f, def[r.key] !== false); return; }
          const el = q(`[data-f="${r.f}"]`);
          if (el) el.value = def[r.key];
          paintRv(r);
        });
        previewUi();
        msg('这一组已恢复默认，记得保存');
        return;
      }
      if (act === 'panelReset') {
        /* 当场把面板挪回入口下方，而不是"写一把存储、等下次打开"——
           设置页里点一下、屏幕上没动静，人会以为没生效。 */
        if (o.onPanelReset) o.onPanelReset();
        msg('面板已复位到入口下方');
        return;
      }
      /* 多选（三处共用这一颗）：点开清单；再点一次同一颗就收起。
         底部的三个动作只改选中值，不改搜索词——「全选」按的是当前清单。 */
      if (act === 'ms') {
        const f = b.getAttribute('data-f');
        if (!pop.hidden && popOwner === b) { closePop(); return; }
        openPop(b, drawMS(f, ''));
        return;
      }
      if (act === 'msAll' || act === 'msNone') {
        const ms = pop.querySelector('.st-ms');
        if (!ms) return;
        const f = ms.dataset.msf;
        const kw = (pop.querySelector('.st-ms-q') || {}).value || '';
        msSet(f, act === 'msAll' ? msItems(f) : []);
        ms.outerHTML = drawMS(f, kw);
        const q2 = pop.querySelector('.st-ms-q');
        if (q2) { try { q2.focus({ preventScroll: true }); } catch (e) { } }
        return;
      }
      if (act === 'msDone') {
        const ms = pop.querySelector('.st-ms');
        if (ms) paintMS(ms.dataset.msf);
        closePop();
        return;
      }

      /* ── 文稿组合（1.13.0）：切日 / 周、选一份来编、新建 / 改名 / 删除 ──
         组合是"一份完整的稿子"，所以这里的动作都不碰别的组合。 */
      if (act === 'comboPick') {
        const id = b.getAttribute('data-cid');
        if (id && id !== curCid) loadCombo(id);
        return;
      }
      if (act === 'comboAdd') { comboAdd(); return; }

      /* 改名：点一下变输入框，回车 / 失焦提交，Esc 取消。
         不用 prompt：那是浏览器原生小窗，在这套界面里像另一个程序弹出来的。 */
      if (act === 'comboRename') {
        const c = comboOf(curCid);
        const nameEl = planBox && planBox.querySelector('.st-pitem.is-cur .st-pname');
        if (!c || !nameEl) return;
        const inp = document.createElement('input');
        inp.className = 'st-gname-in';
        inp.value = c.name;
        inp.maxLength = 12;
        inp.setAttribute('aria-label', '组合名称');
        nameEl.replaceWith(inp);
        inp.focus();
        inp.select();
        let closed = false;
        const commit = ok => {
          if (closed) return;
          closed = true;
          if (ok) {
            const v = HT.normComboName(inp.value);
            if (v) c.name = v;
          }
          renderPlan();
        };
        inp.addEventListener('blur', () => commit(true));
        inp.addEventListener('keydown', e => {
          if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
          else if (e.key === 'Escape') { e.preventDefault(); closed = true; renderPlan(); }
        });
        return;
      }


      /* 文字模板的增删改序全在编辑器里（它持有库），这里只转一手。
         （1.14.0）库不归任何一份组合，所以「新建」进的是库，
         「重置」退的是整库——两件事都不碰组合接了什么。 */
      if (act === 'libAdd') { ed.add(); return; }
      if (act === 'libReset') {
        if (arm('libReset', '再点一次「重置」确认：六条文字模板回到出厂')) libReset();
        return;
      }
      /* 组合里那几段：加 / 移出 / 上移下移。只动这一份组合的 id 列表。 */
      if (act === 'comboReset') {
        if (arm('comboReset', '再点一次「重置」确认：这一份组合回到出厂接法')) comboReset();
        return;
      }
      if (act === 'pickAdd') { openPickAdd(b); return; }
      if (act === 'pickAddOne') { pickAdd(b.getAttribute('data-tid')); closePop(); return; }
      if (act === 'pickUp') { pickMove(b, -1); return; }
      if (act === 'pickDown') { pickMove(b, 1); return; }
      if (act === 'pickOut') { pickOut(b); return; }
      if (act === 'save') { save(); return; }
      if (act === 'reset') { reset(); return; }

      if (act === 'updCheck' || act === 'updRetry') { updCheck(); return; }
      if (act === 'updGet') { updGet(b); return; }
      if (act === 'updCopy') { updCopy(b); return; }
      if (act === 'syncNow') { syncNow(); return; }
      /* 这两颗在（1.12.17）从长按改回普通点击 + 两段式：
         它们各自只影响一块（这一组的模板 / 本机设置的来源），
         长按的"重"应当留给「恢复默认」那一颗。 */
      if (act === 'syncRestore') {
        if (arm('syncRestore', '再点一次「还原」确认：用云端那一份覆盖本机设置')) syncRestore();
        return;
      }

      if (act === 'exp') { exportBackup(); return; }
      if (act === 'imp') { impPick(); return; }
    }

    /* 点击分发的两个来源：设置正文，以及头部那两颗动作按钮。
       头部是外部传进来的节点，可能被同一页多次挂载（设置页重开），
       所以监听只绑一次，处理器每次挂载时换成最新的这一份闭包——
       直接 addEventListener 会越叠越多，第二次点保存会跑两遍。 */
    root.addEventListener('click', onClick);
    if (headActs) {
      if (!headActs.__stClick) {
        headActs.__stClick = ev => { if (headActs.__stHandler) headActs.__stHandler(ev); };
        headActs.addEventListener('click', headActs.__stClick);
      }
      headActs.__stHandler = onClick;
    }

    root.addEventListener('change', e => {
      const t = e.target;
      /* 多选清单：勾一项就重建选中值（顺序跟清单走），摘要当场跟着变。
         不重建整个清单——那会把搜索框的焦点与光标一起丢掉。 */
      if (t.matches('.st-ms input[type="checkbox"]')) {
        const ms = t.closest('.st-ms');
        const f = ms.dataset.msf;
        const nm = msName(f);
        const n = t.dataset.n;
        const next = (msSel[f] || []).filter(x => nm(x) !== nm(n));
        if (t.checked) next.push(n);
        msSet(f, next);
        t.closest('.st-ms-i').classList.toggle('on', t.checked);
        return;
      }
    });

    root.addEventListener('input', e => {
      const t = e.target;
      /* 界面手感的滑杆（1.12.16）：读数跟着走，本页分类树立刻预览，
         面板那边由 onUi 重画（标题栏就在这层浮层上面，看得见）。 */
      if (t.matches && t.matches('.st-rng')) {
        const r = HT.SETTINGS.uiRows().filter(x => x.f === t.getAttribute('data-f'))[0];
        if (r) paintRv(r);
        previewUi();
        return;
      }
      if (t.matches('.st-ms-q')) {
        const ms = t.closest('.st-ms');
        const kw = t.value;
        if (ms) {
          ms.outerHTML = drawMS(ms.dataset.msf, kw);
          const q2 = pop.querySelector('.st-ms-q');
          if (q2) { q2.focus(); q2.setSelectionRange(kw.length, kw.length); }
        }
        return;
      }
    });

    root.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      if (!pop.hidden) { closePop(); e.stopPropagation(); return; }
      /* 编辑态：Esc 先退出编辑（把正文落回列表再收起编辑区）。
         "退出编辑"是编辑器的状态，所以问它一句，而不是在这里改它的变量。 */
      if (ed.exitEditing()) e.stopPropagation();
    });

    /* ── 对外 ───────────────────────────────────────────── */
    /* 导入：选文件 → 读文本 → 整份校验 → 重画表单。
       不做"合并"，只做"覆盖"：合并会让两个人的模板混在一起，分不清哪段是谁的。 */
    (function bindImport() {
      const f = q('[data-f="impFile"]');
      if (!f) return;
      f.addEventListener('change', async () => {
        const file = f.files && f.files[0];
        if (!file) return;
        /* 导入是"整份覆盖"，没有回滚路径：选错一个文件，现有的模板与偏好就全没了。
           确认放在**弹选择框之前**——「导入」这颗按钮走两段式（见 arm()），
           点第二下才弹框。这里再问一遍等于问两遍同一件事，而且原生 confirm
           会把整个页面卡住（面板是注入的，框一出来连 Esc 都不归它管）。 */
        try {
          const text = await file.text();
          await HT.importCfg(text);
          fill(await HT.loadCfg());
          await showUsed();
          msg('已导入');
          if (o.onSaved) o.onSaved(HT.normalizeCfg(await HT.loadCfg()));
        } catch (e) {
          msg('导入失败：' + why(e));
        } finally {
          f.value = '';   // 同一个文件再选一次也要触发 change
        }
      });
    })();

    /* ── 版本对账 ────────────────────────────────────
       只核对版本号，不下载、不替换。请求必须由 background 发出：
       content script 的 fetch 走页面 origin，会被目标站的 CSP 拦掉
       （详见 background.js 里的说明）。

       这一屏**不自己写提示文案**：查得怎么样由 release.js 给短码，
       话在 errors.js 的 UPD 表里，这里只负责摆。以前四种"查不到"
       各写各的，最后变成一句「这次没查到：Failed to fetch」。 */
    function askUpdate(force) {
      const fallback = {
        reason: 'nobg', local: HT.localVer(), latest: '',
        hasNew: false, notes: [], url: '', detail: '后台未回话'
      };
      return new Promise(res => {
        try {
          chrome.runtime.sendMessage({ type: 'checkUpdate', force: !!force }, r => {
            if (chrome.runtime.lastError || !r) res(fallback);
            else res(r);
          });
        } catch (e) {
          res(fallback);
        }
      });
    }

    /** 一句"哪一段断了 + 能不能自己解决"，鼠标停上去给完整处置。 */
    function updTitle(i) {
      return i.title + '\n' + i.tip + (i.detail ? '\n' + i.code + '：' + i.detail : '');
    }

    /**
     * 「本机」「最新」两栏各写各的，但**必须能一起读**。
     *
     * 三种关系，不能只有两种：
     *   清单更高   → 有新版本
     *   一样       → 已是最新
     *   清单更低   → 分发源落后（这一版还没发布）
     * 少了第三种，「本机」比「最新」高的时候，两行会一起出现"… · 已是最新"，
     * 读起来是"分发源上那个号就是最新版"。查得到清单 ≠ 清单是新的。
     */
    function paintVer(v) {
      const local = q('[data-f="verLocal"]');
      const latest = q('[data-f="verLatest"]');
      const get = q('[data-act="updGet"]');
      const cp = q('[data-act="updCopy"]');
      const i = HT.updInfo(v);
      /* 本机版本优先取运行时清单，不用文件里的常量：同步盘换掉文件但没重载时，
         常量已经是新的，跑的还是旧的——那一行会显示成新版，把"没重载"这唯一的线索抹掉。 */
      if (local) local.textContent = v.local || HT.localVer();
      if (!latest) return;
      const W = HT.UPD_WORD;
      /* 只说结论，不把版本号拼进状态里——版本号已经在「当前」那一行。
         ahead 也要写清是哪个号：那句话和「当前」并排读，才不会被理解反。 */
      /* （1.12.13）只写结论：有新版本就只写那个号（与「当前」那一行的号
         同一个位置、同一种数字），没有就写「已是最新」。
         原先那一版写成「某版本号 可用」，把"版本号"和"可以更新"两句话说在同一格里，
         而"可用"这个词还要人自己翻译成"我可以去下"。
         ahead（分发源落后于本机）也按「已是最新」写：本机确实是最新的，
         差别在分发源，那条说明只放进悬停——它维护人员才需要看。 */
      latest.textContent = i.ok
        ? (i.hasNew ? i.latest : W.same)
        : i.foot;
      latest.classList.toggle('is-new', i.hasNew);
      latest.title = i.ok
        ? (i.ahead
          ? '分发源上最新只到 ' + i.latest + '，本机是 ' + (v.local || HT.localVer()) +
            '——这一版还没发布，不是「已是最新」'
          : '')
        : updTitle(i);
      /* 自动检查已覆盖「有没有新版」，只在失败时留重试入口：
         成功时再多一个按钮，等于同一个动作给两个入口。 */
      const retry = q('[data-act="updRetry"]');
      if (retry) retry.hidden = !!i.ok;
      if (get) {
        get.hidden = !(i.hasNew && i.url);
        if (i.url) get.dataset.url = i.url;
        if (i.latest) get.dataset.ver = i.latest;
        /* 清单里的包指纹（发布脚本写的）。下载前由后台取一遍包比对，
           对不上就不下——手工解压覆盖的包，比"版本号对不对"更该核的是字节。
           老清单没有这两个字段，传空串，后台按"没有指纹"直接下。 */
        get.dataset.sha = v.sha256 || '';
        get.dataset.size = v.size ? String(v.size) : '';
        /* 清单里给的可能是 zip，也可能是说明页——按钮上的字要跟着变，
           否则点"获取安装包"却跳出一个网页，人以为下错了。 */
        get.textContent = /\.zip(\?|$)/i.test(i.url) ? '下载' : '打开页面';
      }
      /* 「复制地址」与获取按钮同进同出：它只在新版本那一栏有用——下载被安全策略
         拦下时，粘到地址栏手动下是唯一还走得通的路。 */
      if (cp) {
        cp.hidden = !(i.hasNew && i.url);
        if (i.url) cp.dataset.url = i.url;
        cp.title = '把安装包地址复制到剪贴板，粘到浏览器地址栏就能手动下载';
      }
    }

    async function updCheck() {
      msg('检查中…');
      const v = await askUpdate(true);
      paintVer(v);
      const i = HT.updInfo(v);
      const W = HT.UPD_WORD;
      /* 成功只说结论；失败说"哪一段断了"，有状态码才附上状态码。 */
      if (i.ok) {
        msg(i.hasNew ? (W.newer + ' ' + i.latest + '，点右侧按钮获取')
          : i.ahead
            ? ('分发源上最新只到 ' + i.latest + '，比本机旧——这一版还没发布')
            : (W.same + '（' + i.latest + '）'));
      } else {
        msg(i.title + (i.detail ? '（' + i.detail + '）' : ''));
      }
    }

    /* ── 获取安装包 / 重新加载 ──────────────────────────
       这两件事 content script 自己做不了（downloads 与 runtime.reload 都不是
       content script 能碰的 API），所以都转给 background。
       reload 之后这个页面会连同整个扩展一起重建，所以提示语先写上去再发。 */
    function updGet(btn) {
      const url = btn && btn.dataset.url;
      if (!url) { msg('还没有可下载的地址'); return; }
      const ver = (btn && btn.dataset.ver) || '';
      const sha256 = (btn && btn.dataset.sha) || '';
      const size = Number((btn && btn.dataset.size) || 0) || 0;
      const isZip = /\.zip(\?|$)/i.test(url);
      if (isZip) {
        msg('正在下载…', '下完会回报结果；被浏览器拦下也会说清原因。');
        /* 兜底：下载任务被浏览器挂起（等你在下载栏点「保留」）或干脆丢了，
           onChanged 就永远不来。90 秒还没结果就别让它一直停在"正在下载"。 */
        const stamp = ++dlTick;
        setTimeout(() => {
          if (stamp !== dlTick) return;    // 已经有结果，或人又点了一次
          msg('下载迟迟没有回报',
            '打开 chrome://downloads 看那一项：写着「已阻止」就点旁边的「保留」；' +
            '列表里根本没有它，就回来说「复制地址」手动下载。');
        }, 90000);
      }
      try {
        chrome.runtime.sendMessage({ type: 'updGet', url, ver, size, sha256 }, r => {
          if (chrome.runtime.lastError || !r) { msg('下载没开始：扩展后台没有响应'); return; }
          /* zip 的成败要等后台回报（dlResult）：回调只代表"任务被接下"，
             这一刻说"已下载"就是在骗人——被拦下的下载气泡会在这句话之后消失。 */
          if (r.ok) {
            if (!isZip) msg('已打开下载页');
            else if (sha256) msg('正在下载…', '安装包已与清单里的 sha256 核对一致。');
            return;
          }
          /* 两类失败要分开说："没开始下"是浏览器的事（安全策略拦了），
             "核对不通过"是包的事（清单与字节对不上，可能是被换过）。
             同一句话说出去，人会去点「保留」，而复用的是错的包。 */
          const blocked = /核对|清单|不一致|不符|取不到安装包/.test(String(r.why || ''));
          msg((blocked ? '没有下载：' : '下载没开始：') + String(r.why || '浏览器拒绝了这次下载'),
            r.raw ? (blocked ? '详情：' + r.raw : '浏览器原话：' + r.raw) : '');
        });
      } catch (e) { msg('下载没开始：扩展后台没有响应'); }
    }

    /* 手动取件。下载被安全浏览拦下时，downloads API 那条路已经走不通了，
       但把地址粘到地址栏回车仍然能下——这是最后一条不依赖扩展权限的路。 */
    function updCopy(btn) {
      const url = (btn && btn.dataset.url) || '';
      if (!url) { msg('还没有可复制的地址'); return; }
      const done = () => msg('地址已复制', url + '\n粘到浏览器地址栏回车即可下载');
      const fail = () => msg('复制失败，请手动抄下这个地址', url);
      /* 剪贴板只走 HT.copyText：它自己会从 clipboard API 退到 textarea 选中
         （面板刚打开时页面没焦点，clipboard API 会失手）。这里不再抄一遍回退逻辑。 */
      HT.copyText(url).then(ok => (ok ? done() : fail()), fail);
    }

    /* 1.3 起撤掉「上次检查」与「自动重载」两行：前者是维护者要看的时间戳，
       后者在真机上从没被打开过（换文件本来就得手动放）。
       background 仍在记 updLast，只是不再往界面上搬。

       （1.9.1）起「反馈问题」与「重新加载」两颗按钮也撤了：
       前者与"出错自动上报"是两套说法，留着只会让人以为不点就不报；
       后者浏览器扩展页自己就有，在这儿再摆一颗是重复入口。 */

    const api = {
      /** 每次打开都重新读一遍：面板那边可能刚改过基准时间 */
      async refresh() {
        fill(await HT.loadCfg());
        await paintCloud();                      // 先按本机记录画一句，不用等网络
        /* 然后对一次云端（60 秒内重复打开不会重复请求）。
           真取回了新的一份，界面上的模板要跟着换——否则人会以为"保存没生效"。 */
        const r = await HT.cloud.boot().catch(() => null);
        if (r && r.pulled) fill(await HT.loadCfg());
        await paintCloud();
        await showUsed();
        paintStat(await askStat());               // 上报是后台记的，不在这一层
        paintSess();                              // 本地读 token 就够，不用等网络
        paintVer(await askUpdate(true));    // 打开即查一次：设置页是唯一能看到版本的地方，不吃 24 小时缓存
      },
      save,
      collect,
      /* 滚的是内容容器：面板浮层里是 .st-panes，独立设置页里是文档 */
      scrollTop: () => {
        const box = scrollBox();
        if (box) box.scrollTop = 0;
        if (navBox) navBox.scrollTop = 0;
      },
      dirty: () => {
        const r = collect();
        return JSON.stringify(r.cfg) !== JSON.stringify(HT.normalizeCfg(cfg));
      }
    };

    api.refresh();
    return api;
  };
})(typeof window !== 'undefined' ? window : globalThis);
