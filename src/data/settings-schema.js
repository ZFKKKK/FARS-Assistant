/**
 * src/data/settings-schema.js —— 设置页的结构声明（唯一来源）
 *
 * @layer  data（声明层：纯数据 + 纯字符串拼装，不碰 DOM、不读存储）
 * @file   src/data/settings-schema.js
 * @since  0.25.0
 *
 * 为什么要有这个文件：
 *   0.24 及以前，设置页长什么样、配置项叫什么、持久化到哪个键，是三份独立的
 *   拷贝——`settings.js` 里 180 行 HTML 模板、`fill()` 的一串 setSw、`collect()`
 *   的一串 `x: getSw('x')`。加一个开关要改四处，漏一处不会报错，只会**静默失效**：
 *   开关能点，但不落盘；或者落了盘，但下次打开不显示。
 *
 *   这里把「有哪些分组、每组哪些行、每行是什么控件、绑哪个 cfg 键」一次写完，
 *   渲染与读写都从这张表走。以后加设置项 = 加一行数据，不再有第二处要同步。
 *
 * 边界（刻意不做的事）：
 *   · 不做分类改版。分组顺序、标题、行顺序与 旧版手写模板的界面**逐一对应**，
 *     改版是另一件事（见 重构建议存档 §4.3）。
 *   · 不碰模板编辑器。`templates` 是重度富文本组件（chip / 光标 / 浮层），
 *     它只需要一个挂载点，不需要被拆成行数据。
 *   · 不替 `config.js` 决定默认值。DEFAULT_CFG 仍是唯一默认值来源，
 *     这里只声明"界面绑哪个键"，不声明"默认是多少"。
 *
 * 与 verify 的关系：
 *   CFG_KEYS 把 `DEFAULT_CFG` 的每个键显式归档（界面 / 面板 / 历史 / 内部）。
 *   `自检脚本` 双向比对这张表与 DEFAULT_CFG，任何一边多出或漏掉都判失败——
 *   这是防止"又出现一个谁也够不着的配置键"的唯一护栏。
 */
(function (g) {
  'use strict';
  const HT = (g.__HT = g.__HT || {});

  const esc = s => HT.esc(s);

  /* ── 行构造小工具 ───────────────────────────────────────
     刻意与旧版手写模板输出的标签结构逐字一致：
     类名、属性顺序、`<i>` 占位都不改，所以 panel.css 不需要动一行。 */

  /* 一行 = 标签 + 控件，必要时下面再跟一句说明。
     说明放在行内（`.st-desc`）而不是 `title` 属性里：悬停才出现的字，
     在触屏和笔记本上等于没有。大厂的设置页也是这个规矩——
     能被读到的解释才叫解释。 */
  const row = (k, inner, desc) =>
    '<div class="st-row"><span class="st-k">' + esc(k) + '</span><div class="st-v">' + inner + '</div>' +
    (desc ? '<p class="st-desc">' + esc(desc) + '</p>' : '') + '</div>';

  const btn = (act, text, extra) =>
    '<button class="st-btn" type="button" data-act="' + act + '"' + (extra || '') + '>' + esc(text) + '</button>';

  /* aria-checked 的初值由 render(base) 从真实配置推出来（见 render 的注释）。
     on 为 undefined 时按"开"画——只影响没传 base 的预览页。 */
  const sw = (f, tip, on) =>
    '<button class="st-sw" type="button" role="switch" aria-checked="' + (on === false ? 'false' : 'true') +
    '" data-f="' + f + '"' + (tip ? ' title="' + esc(tip) + '"' : '') + '><i></i></button>';

  const num = (r) =>
    '<input class="st-in st-num" type="number" min="' + r.min + '" max="' + r.max +
    '" step="' + r.step + '" data-f="' + r.f + '">' +
    (r.unit ? '<span class="st-unit">' + esc(r.unit) + '</span>' : '');

  /* ── 控件渲染表 ─────────────────────────────────────────
     每种类型一个函数，新增类型只在这里加一个键。 */

  const RENDER = {
    /* 1.2 起没有「用户」这一组：多用户档案撤掉了（同一台机器一套配置）。 */

    /* 时间是面板上的事（点「基准时间」直接填年月日时分秒），
       设置页不再有那一行时间输入框 —— 1.1 撤掉了 RENDER.time。 */


    /* 中心城区：按钮 + 只读文本，点开是多选浮层（浮层本身在 settings.js 里画） */
    picker: (r) => row(r.k,
      '<button class="st-pick" type="button" data-act="' + r.act + '" aria-haspopup="true" aria-expanded="false">' +
      '<span class="st-pick-t" data-f="' + r.f + '">未选</span><i>▾</i></button>', r.desc),

    switch: (r, on) => row(r.k, sw(r.f, r.tip, on), r.desc),

    num: (r) => row(r.k, num(r), r.desc),

    /* 小标题：组内分节（模板组下面「口径」「人数」两节）。
       它不是控件，所以不带 data-f，也不进 bindable()。 */
    sub: (r) => '<div class="st-sub">' + esc(r.k) + '</div>',

    /* 同比一行：控件按**句子顺序**摆，读出来就是「减少 3 人，下降 2.1%」。
       方向在一行里出现两次（按钮 + 联动字）是刻意的：按钮是操作，
       联动字是句子的一部分；两者同源（只存一个 up/down），
       所以不会出现"人数减少、幅度上升"这种自相矛盾的写法。 */
    dirNum: (r) =>
      '<div class="st-row st-row-dir"><span class="st-k">' + esc(r.k) + '</span><div class="st-v">' +
      '<button class="st-dir" type="button" data-dir="' + r.dir + '" aria-pressed="true"' +
      (r.tip ? ' title="' + esc(r.tip) + '"' : '') + '>增加</button>' +
      '<input class="st-in st-num" type="number" min="0" step="1" data-f="' + r.f + '"' +
      ' aria-label="' + esc(r.k) + '人数">' +
      '<span class="st-unit">' + esc(r.unit || '') + '</span>' +
      '<span class="st-dirw" data-w="' + r.dir + '">上升</span>' +
      '<input class="st-in st-num" type="number" min="0" step="0.1" data-f="' + r.f2 + '"' +
      ' aria-label="' + esc(r.k) + '幅度">' +
      '<span class="st-unit">' + esc(r.unit2 || '') + '</span>' +
      '</div>' + (r.desc ? '<p class="st-desc">' + esc(r.desc) + '</p>' : '') + '</div>',

    /* 多行文本：整句由人维护的那几句（人数结句 / 人数同比）。
       宽度撑满、按行数给初始高度，保存走 collect 的 else 分支（取 el.value）。 */
    text: (r) => row(r.k,
      '<textarea class="st-ta" data-f="' + r.f + '" rows="' + (r.rows || 2) + '"' +
      (r.tip ? ' title="' + esc(r.tip) + '"' : '') +
      (r.ph ? ' placeholder="' + esc(r.ph) + '"' : '') + '></textarea>', r.desc),

    /* 复选一组：勾上的展示，未勾的归入句尾「其余正在调查中」（起火原因）。
       与 picker 的区别：选项固定且少，不需要浮层与搜索，直接摊在设置页里。 */
    checks: (r) => row(r.k,
      '<div class="st-checks" data-f="' + r.f + '">' +
      (r.items || []).map(n =>
        '<label class="st-chk"><input type="checkbox" data-n="' + esc(n) + '">' +
        '<span>' + esc(n) + '</span></label>').join('') +
      '</div>', r.desc),

    btn: (r) => row(r.k, btn(r.act, r.text), r.desc),

    /* 只读展示：存储占用、诊断计数、版本号。同一行可以再挂几个按钮 */
    note: (r) => row(r.k,
      '<span class="st-unit" data-f="' + r.f + '">—</span>' +
      (r.btns || []).map(b => btn(b.act, b.text, b.hidden ? ' hidden' : '')).join(''), r.desc),

    /* 备份：两个按钮 + 一个隐藏的 file input（导入用） */
    file: () => row('配置文件',
      btn('exp', '导出备份') + btn('imp', '导入备份') +
      '<input type="file" accept=".json,application/json" data-f="impFile" hidden>'),

    /* 宿主容器：内容由 settings.js 动态画（模板列表 / 诊断日志） */
    body: (r) => r.body
  };

  /* ── 结构 ───────────────────────────────────────────────
     顺序 = 界面顺序 = 旧版手写模板的现状。改分类改这里，不要再去改 settings.js。

     行字段：
       k     左侧标签
       t     控件类型（见 RENDER）
       f     data-f 名（读写控件时按它定位）
       cfg   绑的 config 键（只有 switch / num / time 需要；有它才算"可读写配置项"）
       empty 输入框为空时的回落值（与 collect() 原实现一致）
       tip   悬停说明（沿用旧版模板里那几条长 title，不新增） */

  const GROUPS = [
    /* 顺序按「改动频率 + 同类聚合」排：
       每期都要动的在最前，一次性配置居中，维护与升级类在最后。
       同组内一个决定一件事，不把站点适配混进面板行为。

       原来独立的「文案」「规则」两组已并进「模板」（1.8.0）：这几块回答的
       其实是同一个问题——**稿子上的字长什么样、按什么口径写**。
       分成两个抽象名字的组时，想改一句话要在两组之间来回找。 */
    {
      id: 'tpl', title: '模板',
      acts: [{ act: 'tplReset', text: '恢复默认' }, { act: 'tplAdd', text: '新建' }],
      /* 段落卡片放最前：进来先看见稿子有哪几段，这是这一组的主体。
         用 body 行而不是组的 body 字段——组字段按约定排在所有行之后，
         那样卡片会被挤到「口径」「人数」下面去。 */
      rows: [
        { t: 'body', body: '<div class="st-tpls" data-f="tpls"></div>' },

        { k: '口径', t: 'sub' },
        /* cfg 只用于对账（它绑的是 coreTowns），读写走 coreSel，不走 fill/collect 的循环 */
        { k: '中心城区', t: 'picker', act: 'core', f: 'coreText', cfg: 'coreTowns' },
        {
          k: '起火原因', t: 'checks', f: 'causePick', cfg: 'causePick',
          items: HT.CAUSE_OPTIONS,
          desc: '勾选的原因按起数单列，其余并入「其他正在调查中」'
        },
        {
          k: '区县用简称', t: 'switch', f: 'shortTown', cfg: 'shortTown',
          desc: '「奉节县」写作「奉节」'
        },
        {
          k: '并入两江', t: 'switch', f: 'townMerge', cfg: 'townMerge',
          desc: '渝北、江北、两江新区合并为「两江」，起数相加'
        },

        /* 人数这几个数每期都要改，但它们不是"设置项"，是替换进句子的数字——
           句子的措辞在段落模板里（{{f:ph.casualty}} / {{f:cas.hurt}} 那两个标签）。
           分开放的理由：数字天天变、措辞一年才改一次，混在一格里就会
           "为了改一个数，把整句话重打一遍"。 */
        { k: '伤亡', t: 'sub' },
        {
          k: '受伤人数', t: 'num', f: 'casHurt', cfg: 'casHurt', empty: '',
          unit: '人', min: 0, max: 9999, step: 1,
          desc: '留空取平台值，填写后以填写值为准'
        },
        {
          k: '死亡人数', t: 'num', f: 'casDead', cfg: 'casDead', empty: '',
          unit: '人', min: 0, max: 9999, step: 1,
          desc: '留空取平台值，填写后以填写值为准'
        },
        {
          k: '受伤同比', t: 'dirNum', f: 'yoyHurtN', f2: 'yoyHurtP',
          cfg: 'yoyHurtN', cfg2: 'yoyHurtP', dir: 'yoyHurtDir',
          unit: '人', unit2: '%',
          desc: '人数与幅度填正数，方向点按钮切换；人数留空则此项不出现在正文'
        },
        {
          k: '死亡同比', t: 'dirNum', f: 'yoyDeadN', f2: 'yoyDeadP',
          cfg: 'yoyDeadN', cfg2: 'yoyDeadP', dir: 'yoyDeadDir',
          unit: '人', unit2: '%',
          desc: '人数与幅度填正数，方向点按钮切换；人数留空则此项不出现在正文'
        }
      ]
    },
    {
      id: 'common', title: '面板',
      rows: [
        {
          k: '生成冷却', t: 'num', f: 'cooldownSec', cfg: 'cooldownSec',
          unit: '秒', min: 0, max: 30, step: 1,
          desc: '两次生成之间的最短间隔'
        },
        { k: '点击外部关闭', t: 'switch', f: 'closeOnOutside', cfg: 'closeOnOutside' },
        {
          k: '专注时变淡', t: 'switch', f: 'focusDim', cfg: 'focusDim',
          desc: '专注时点到面板外，面板变淡而不收起，点回即恢复'
        },
        { k: '记住位置', t: 'switch', f: 'rememberPos', cfg: 'rememberPos' },
        { k: '复位位置', t: 'btn', act: 'panelReset', text: '复位' }
      ]
    },
    {
      id: 'site', title: '站点',
      /* 站点适配与面板行为是两件事：前者只影响网页上那个第三方浮标，
         后者影响面板自己。合成一组时，开关夹在"专注时变淡"和"记住位置"中间，
         读起来像同一类设置。 */
      rows: [
        {
          k: '屏蔽浮标', t: 'switch', f: 'hideSiteFab', cfg: 'hideSiteFab',
          desc: '隐藏统计页左下角的第三方 AI 浮标，不影响站点功能'
        }
      ]
    },
    {
      id: 'diag', title: '诊断',
      /* 撤掉「运行统计」开关（1.8.0），也撤掉「反馈问题」按钮（1.9.1）：
         出错自动上报，这一组只剩一句状态。给一颗"反馈"按钮等于暗示"不点就不报"，
         而实际上报是后台按需发的，跟这里点不点没有关系。
         发的东西：版本号 + 环境 + 本机自检记录（短码 / 模块 / 校验项名），
         没有起数、没有区域、没有模板正文，也没有账号（见 release.js 的 report）。 */
      rows: [
        {
          k: '状态', t: 'note', f: 'obsStat',
          desc: '运行异常时自动上报，不收集起数与稿子内容'
        },
        /* 登录票据。票面写的是签发那一刻的 30 分钟，实测与能不能取数无关
           （过期几小时照样取数，第二天首次打开才要重登），所以这里不打倒计时、
           不给"续期"按钮：一颗按不动的按钮，比没有更让人费解。
           真正的登录入口在面板那一行。 */
        {
          k: '登录', t: 'note', f: 'sessStat',
          desc: '票面时间只记签发那一刻，与能否取数无关'
        }
      ]
    },
    {
      id: 'bak', title: '备份',
      rows: [
        { t: 'file' },
        { k: '存储占用', t: 'note', f: 'used', desc: '配置与模板占用的本机空间' }
      ]
    },
    {
      id: 'cloud', title: '云端',
      /* 所有装了本扩展的电脑共用**一份**配置，所以这里没有同步码，
         也没有「上传 / 取回」——两个按钮能做的事，保存和打开页面已经做了。
         只在两处破例给人一个手动的口子：
           · 没同步成（断网、服务器忙）时露出「立即同步」；
           · 云端覆盖过本机时露出「还原」，退回归属那一份（只留一层）。
         开关「自动同步」不绑 cfg，它存在 cloudSync 那把键里。 */
      rows: [
        {
          k: '同步', t: 'note', f: 'syncStat',
          btns: [{ act: 'syncNow', text: '立即同步', hidden: true }]
        },
        {
          k: '自动同步', t: 'switch', f: 'syncAuto',
          desc: '换机器不用重新配；保存后自动上传，打开站点时取回较新的一份'
        },
        {
          k: '上一份', t: 'note', f: 'syncPrev',
          btns: [{ act: 'syncRestore', text: '还原', hidden: true }]
        }
      ]
    },
    {
      id: 'ver', title: '版本',
      /* 打开设置页即查一次清单（跳过缓存）；查不到时才出现「重试」。
         不常驻「检查更新」：自动检查已经覆盖了同一个动作。

         （1.9.1）撤掉「重新加载」那一行：浏览器扩展页自己就有刷新，
         而且换了安装包之后真正该做的是"在扩展页点一下刷新"——
         在这儿再摆一颗按钮，两处做同一件事，还容易让人以为它能换版本。 */
      rows: [
        { k: '当前', t: 'note', f: 'verLocal' },
        {
          k: '更新', t: 'note', f: 'verLatest',
          btns: [
            { act: 'updRetry', text: '重试', hidden: true },
            { act: 'updGet', text: '下载', hidden: true },
            { act: 'updCopy', text: '复制地址', hidden: true }
          ]
        },
        /* 清单里的 notes（发布脚本写的那一条）。只在新版本那一栏出现——
           没有新版本时"改了什么"没有决策价值，留着只会占一行。
           整行由 settings.js 的 paintVer 控制显隐，这里不写死 hidden：
           note 类型的 hidden 只作用在按钮上。 */
        { k: '更新说明', t: 'note', f: 'verNotes' }
      ]
    }
  ];

  /* ── 渲染 ───────────────────────────────────────────────
     输出与旧版手写模板同构：.st-body > .st-sec，节头是 h3 或 .st-h。
     页脚不在这里——它是"保存动作"，属于视图，不属于设置项。

     base 传进来的是一份 normalizeCfg 后的配置：开关的 aria-checked 初值由它推出。
     0.24 的手写模板把默认值抄进了 HTML（hideSiteFab 写 false，其余写 true），
     于是"默认值"在两个地方各有一份——这里从 base 推，只保留 config.js 一处。 */

  function render(base) {
    const out = ['<div class="st-body">'];
    GROUPS.forEach(gp => {
      out.push('<section class="st-sec">');
      if (gp.acts && gp.acts.length) {
        out.push('<div class="st-h"><h3>' + esc(gp.title) + '</h3><span class="st-h-act">' +
          gp.acts.map(a => btn(a.act, a.text)).join('') + '</span></div>');
      } else {
        out.push('<h3>' + esc(gp.title) + '</h3>');
      }
      (gp.rows || []).forEach(r => {
        const on = r.on !== undefined ? r.on : ((r.cfg && base) ? base[r.cfg] !== false : undefined);
        out.push(RENDER[r.t](r, on));
      });
      if (gp.body) out.push(gp.body);
      out.push('</section>');
    });
    out.push('</div>');
    return out.join('');
  }

  /* ── 供 settings.js 使用的视图 ───────────────────────────
     rows()     扁平化的所有行（含无 cfg 的命令行）
     bindable() 绑定 config 键的行：fill() 与 collect() 共用这一份，
                从此"界面上的开关"与"存进配置的键"不可能再对不上。 */

  const rows = () => {
    const list = [];
    GROUPS.forEach(gp => (gp.rows || []).forEach(r => list.push(r)));
    return list;
  };

  const BINDABLE_TYPES = { switch: 1, num: 1, text: 1, checks: 1 };
  const bindable = () => rows().filter(r => r.cfg && BINDABLE_TYPES[r.t]);

  /* ── 配置键归档 ─────────────────────────────────────────
     每一个 DEFAULT_CFG 键必须在这里有一个去处，verb 见 CFG_STATUS 注释。
     verify 双向比对：表里有的键必须在 DEFAULT_CFG 里，反之亦然。 */

  const CFG_STATUS = {
    /* 基准时间只在面板上调（点那一行填年月日时分秒）。anchor 是自动模式
       的每日时刻，用户不直接改它，所以归 panel 而不是 ui。 */
    anchor: 'panel',
    baseAt: 'panel',
    templates: 'ui',
    shortTown: 'ui',
    townMerge: 'ui',
    coreTowns: 'ui',
    /* 2026-11-17（1.8.0）：人数不再整句手填，拆成"设置页填数字、措辞进模板"。
       六个新键都在「模板 · 人数」那一节里，其中四格是数字、两个 dir 是那颗
       「增加 / 减少」按钮（不绑 input，但同在界面上）。 */
    casHurt: 'ui',
    casDead: 'ui',
    yoyHurtDir: 'ui',
    yoyHurtN: 'ui',
    yoyHurtP: 'ui',
    yoyDeadDir: 'ui',
    yoyDeadN: 'ui',
    yoyDeadP: 'ui',
    causePick: 'ui',
    cooldownSec: 'ui',
    closeOnOutside: 'ui',
    focusDim: 'ui',
    hideSiteFab: 'ui',
    rememberPos: 'ui',

    /* 只在面板里调（A− / A+ 改 --ht-fa），设置页刻意不重复提供入口 */
    focusFont: 'panel',

    /* 历史模板的兜底常量：AUTO 那几段老成文还在读，所以不能删；
       但也不该再给界面入口（0.17 起这些句子被 {{f:ph.*}} 接管，
       由模板正文而不是开关决定）。风险已记入
       重构建议存档 §4.3。 */
    causeLead: 'legacy',
    pendingTpl: 'legacy',

    /* 由面板「屏蔽当前站点浮标」写入，设置页按设计不暴露输入框
       （自检脚本 有断言守着）。当前写入链路已失效，见待决清单。 */
    siteFabSelectors: 'legacy',

    /* 模板形态版本号：迁移用，用户不可见、不可改 */
    tplVer: 'internal'
  };

  HT.SETTINGS = {
    GROUPS,
    render,
    rows,
    bindable,
    CFG_STATUS,
    /** 需要 cfg 键的行数（verify 用它和开关数对账） */
    countCfgRows: () => bindable().length,
    /**
     * 归档为「界面」（ui）的键必须实际落在某个控件上。
     * 下面这几类不在 bindable() 里，但界面上确有入口，所以单独算进来：
     *   · templates —— 富文本模板编辑器；
     *   · coreTowns —— 多选浮层（picker 行）；
     *   · dirNum 那一行除 cfg 之外的另两个键（幅度、方向按钮）。
     */
    uiKeys: () => {
      const out = [];
      rows().forEach(r => {
        if (!r.cfg) return;
        out.push(r.cfg);
        if (r.t === 'dirNum') out.push(r.cfg2, r.dir);
      });
      return out.concat(['templates']);
    }
  };
})(window);
