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

  /* 一行 = 标签 + 控件。
     （1.12.11）行下面的那句灰色小字整块撤掉了：一整页二十多行、每行底下
     都压一行 11px 灰字，扫读时行与行之间全是"字噪音"，真正要看的控件反而
     被切碎了。解释没有丢——它挂到标签的 `title` 上（悬停标签才出现），
     于是同一份措辞还在数据里，只是不再常驻在版面上。
     （1.9.0）当初把说明写进行内的理由是"悬停才出现的字在触屏上等于没有"；
     这个面板只在桌面 Chrome 里跑，鼠标是标配，那条理由不再成立。 */
  const row = (k, inner, desc) =>
    '<div class="st-row"><span class="st-k"' +
    (desc ? ' title="' + esc(desc) + '"' : '') + '>' + esc(k) + '</span>' +
    '<div class="st-v">' + inner + '</div></div>';

  const btn = (act, text, extra) =>
    '<button class="st-btn" type="button" data-act="' + act + '"' + (extra || '') + '>' + esc(text) + '</button>';

  /* 页标题右端那一排动作。
     两颗例外：
       · hold（长按）—— 画成 .st-hold（液面推满才算数），背景自动是警告色。
         目前只有「删除组合」用（1.13.0），用户要求"和恢复默认一样的长按 + 警告色"）。
         它不走 data-act，一次普通点击到不了点击分发。
       · part —— 「恢复本组」要知道退哪一组（1.12.16 踩过：不带它，
         uiReset 拿到 null 静默返回，滑杆推到头再点也毫无反应）。 */
  const btnAct = a => (a.hold
    ? '<button class="st-hold" type="button" data-hold="' + a.act + '"' +
      (a.title ? ' title="' + esc(a.title) + '"' : '') + '>' + esc(a.text) + '</button>'
    : btn(a.act, a.text,
      (a.hidden ? ' hidden' : '') +
      (a.title ? ' title="' + esc(a.title) + '"' : '') +
      (a.part ? ' data-part="' + a.part + '"' : '')));

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


    /* 多选（1.12.18 统一）：一行一个按钮，按钮里是"已选几项"的摘要，点开是
       勾选清单（清单由 settings.js 画，与模板编辑器的浮层共用同一个抽屉）。
       原来中心城区是下拉、起火原因与明细列是摊在页面上的一片框——同一类
       设置长两种样子，且 37 列摊开时那一页只剩格子。现在三处都是这一颗按钮。

       按钮与摘要是两个 data 名：`data-f` 给动作认（点开哪一张清单），
       `data-ms` 给摘要认。同一个名字挂两处会让 q('[data-f=...]') 取到按钮。 */
    msel: (r) => row(r.k,
      '<button class="st-msel" type="button" data-act="ms" data-f="' + r.f + '"' +
      ' aria-haspopup="dialog" aria-expanded="false">' +
      '<span class="st-msel-t" data-ms="' + r.f + '">未选</span><i>▾</i></button>', r.desc),

    switch: (r, on) => row(r.k, sw(r.f, r.tip, on), r.desc),

    num: (r) => row(r.k, num(r), r.desc),

    /* 滑杆 + 读数（1.12.16）：界面手感那一页全是"稍微大一点 / 慢一点"，
       让数字停在刻度上比让人手打 27.3 更接近他要的东西。
       读数与滑杆同源（都读 input.value），拖动时右边那个数跟着走。 */
    range: (r) =>
      '<div class="st-row st-row-rng"><span class="st-k"' +
      (r.desc ? ' title="' + esc(r.desc) + '"' : '') + '>' + esc(r.k) + '</span>' +
      '<div class="st-v st-rngv">' +
      '<input class="st-rng" type="range" min="' + r.min + '" max="' + r.max +
      '" step="' + r.step + '" data-f="' + r.f + '" aria-label="' + esc(r.k) + '">' +
      '<b class="st-rv" data-rv="' + r.f + '">—</b></div></div>',

    /* 小标题：组内分节（模板组下面「口径」「人数」两节）。
       它不是控件，所以不带 data-f，也不进 bindable()。 */
    sub: (r) => '<div class="st-sub">' + esc(r.k) + '</div>',

    /* 同比一行：控件按**句子顺序**摆，读出来就是「减少 3 人，下降 2.1%」。
       方向在一行里出现两次（按钮 + 联动字）是刻意的：按钮是操作，
       联动字是句子的一部分；两者同源（只存一个 up/down），
       所以不会出现"人数减少、幅度上升"这种自相矛盾的写法。 */
    /* 同比那一行：方向按钮 + 人数（+ 幅度）。`noPct` 去掉幅度那一格——
       周报那句本来就不带百分比（config.js 的 wkCasYoy → casYoySentence 传 pct:false，
       文书习惯是「伤人数同比减少3人、亡人数同比增加1人」，人数之间用顿号）。
       界面跟着句子走：句子用不到的数，就不该让人填。 */
    dirNum: (r) =>
      '<div class="st-row st-row-dir' + (r.noPct ? ' st-row-dir-nopct' : '') + '">' +
      '<span class="st-k"' +
      (r.desc ? ' title="' + esc(r.desc) + '"' : '') + '>' + esc(r.k) + '</span><div class="st-v">' +
      '<button class="st-dir" type="button" data-dir="' + r.dir + '" aria-pressed="true"' +
      (r.tip ? ' title="' + esc(r.tip) + '"' : '') + '>增加</button>' +
      '<input class="st-in st-num" type="number" min="0" step="1" data-f="' + r.f + '"' +
      ' aria-label="' + esc(r.k) + '人数">' +
      '<span class="st-unit">' + esc(r.unit || '') + '</span>' +
      (r.noPct ? '' :
        '<span class="st-dirw" data-w="' + r.dir + '">上升</span>' +
        '<input class="st-in st-num" type="number" min="0" step="0.1" data-f="' + r.f2 + '"' +
        ' aria-label="' + esc(r.k) + '幅度">' +
        '<span class="st-unit">' + esc(r.unit2 || '') + '</span>') +
      '</div></div>',

    /* 多行文本：整句由人维护的那几句（人数结句 / 人数同比）。
       宽度撑满、按行数给初始高度，保存走 collect 的 else 分支（取 el.value）。 */
    text: (r) => row(r.k,
      '<textarea class="st-ta" data-f="' + r.f + '" rows="' + (r.rows || 2) + '"' +
      (r.tip ? ' title="' + esc(r.tip) + '"' : '') +
      (r.ph ? ' placeholder="' + esc(r.ph) + '"' : '') + '></textarea>', r.desc),

    /* 复选一组（1.12.18 起并入 msel）：勾上的才进正文，未勾的归入
       「其余正在调查中」或「不导出」。选项从 r.items 取，允许写成函数——
       导出列那 37 项来自 contract.js，而这份声明文件只依赖 esc
       （自检脚本拿一个只有 esc 的桩跑它），写成函数就能在加载期不求值。 */

    /* 只读展示：存储占用、诊断计数、版本号。动作不再挂在这一行上（1.12.18）：
       按钮一律上页标题右端，行里只留值。 */
    note: (r) => row(r.k,
      '<span class="st-unit" data-f="' + r.f + '">—</span>', r.desc),

    /* 配置文件落在哪：只报位置，不再挂两颗按钮——（1.12.13）导出 / 导入
       上移到备份组标题的右端，这一行就只剩"东西存在哪儿"这一个事实。
       显示的是真正的存储位置（扩展的 chrome.storage.local），不是磁盘路径：
       配置从来没有落成过磁盘文件，编一个 ~/config.json 只会让人去找。 */
    file: () => row('配置文件',
      '<span class="st-unit st-path" data-f="cfgPath">chrome.storage.local</span>' +
      '<input type="file" accept=".json,application/json" data-f="impFile" hidden>',
      '配置与模板都存在扩展的本地存储里；导出会存成一份 JSON 到浏览器下载目录'),

    /* 宿主容器：内容由 settings.js 动态画（模板列表 / 诊断日志） */
    body: (r) => r.body
  };

  /* ── 结构 ───────────────────────────────────────────────
     （1.12.16）起这一页是**左分类树 + 右内容**：分组本身是导航上的一项，
     分组里再分「页」（pane）。为什么不再是一条长表单：
     模板那一块（方案 / 片段组 / 人数 / 口径）加上新增的界面手感三十行，
     一屏滚到底要滚七八屏，找一项只能靠记位置。分类树把"找"变成"点两下"。

     命名按「名词 + 限定」，同一层不混动词：
       模板 · 文稿方案 / 片段组 / 人数数据 / 区域口径
       界面 · 设置导航 / 导出菜单 / 长按按钮 / 分段开关 / 状态标记
       维护 · 运行状态 / 备份与恢复 / 云端同步 / 版本信息

     组字段：
       id / title        导航上那一项
       panes             有子页的组（点开才展开）
       rows / acts       单页组（直接选中）

     行字段：
       k     左侧标签
       t     控件类型（见 RENDER）
       f     data-f 名（读写控件时按它定位）
       cfg   绑的 config 键（只有 switch / num / text / checks 需要；有它才算"可读写配置项"）
       empty 输入框为空时的回落值（与 collect() 原实现一致）
       tip   悬停说明（沿用旧版模板里那几条长 title，不新增）
       set   同一件事的哪一套值（'day' / 'week'）。带它的行按切换按钮显隐，
             两套同时在 DOM 里，fill / collect 各读各的，不需要额外的分支 */

  /* 人数那四行每天 / 每周各一套（1.12.0）。
     为什么用工厂而不是抄两遍：抄两遍之后，"把'人数留空则此项不出现'这句话改一下"
     就会只改到其中一套。键名规则只写在这里——weekly 一套一律加 week 前缀，
     f 与 cfg 都用这个键名，于是两套的控件名天然不撞。 */
  const casRows = (set) => {
    const w = set === 'week';
    const K = k => (w ? 'week' + k.charAt(0).toUpperCase() + k.slice(1) : k);
    const emptyDesc = '留空取平台值，填写后以填写值为准';
    const yoyDesc = '人数与幅度填正数，方向点按钮切换；人数留空则此项不出现在正文';
    /* 周报那句没有百分比（见 config.js 里 wkCasYoy 的 pct:false），
       所以每周这一套只填人数，幅度那一格连同「上升 / 下降」的联动字一起撤掉。 */
    const yoyDescW = '只填人数，方向点按钮切换；人数留空则此项不出现在正文';
    return [
      {
        k: '受伤人数', t: 'num', set, f: K('casHurt'), cfg: K('casHurt'), empty: '',
        unit: '人', min: 0, max: 9999, step: 1, desc: emptyDesc
      },
      {
        k: '死亡人数', t: 'num', set, f: K('casDead'), cfg: K('casDead'), empty: '',
        unit: '人', min: 0, max: 9999, step: 1, desc: emptyDesc
      },
      {
        k: '受伤同比', t: 'dirNum', set, f: K('yoyHurtN'), f2: K('yoyHurtP'),
        cfg: K('yoyHurtN'), cfg2: K('yoyHurtP'), dir: K('yoyHurtDir'),
        unit: '人', unit2: '%', noPct: w, desc: w ? yoyDescW : yoyDesc
      },
      {
        k: '死亡同比', t: 'dirNum', set, f: K('yoyDeadN'), f2: K('yoyDeadP'),
        cfg: K('yoyDeadN'), cfg2: K('yoyDeadP'), dir: K('yoyDeadDir'),
        unit: '人', unit2: '%', noPct: w, desc: w ? yoyDescW : yoyDesc
      }
    ];
  };

  /* 界面手感的行由 config.js 的 UI_PARAMS 生成（1.12.16）。
     为什么不在声明里再抄一遍 min/max/step：那张表同时是归一化的上下限，
     抄一遍之后"滑杆能拖到 40、存进去被夹回 32"这种事迟早发生。
     惰性取值（调用时才读 HT.UI_PARAMS）：这份文件在自检里是拿一个只有
     esc 的桩跑的，加载期不能去碰别的模块。 */
  const uiPartRows = (part) => {
    const P = (HT.UI_PARAMS && HT.UI_PARAMS[part]) || null;
    if (!P) return [];
    return P.items.map(it => ({
      k: it.k,
      t: it.kind === 'bool' ? 'switch' : 'range',
      f: 'ui.' + part + '.' + it.f,
      part, key: it.f,
      min: it.min, max: it.max, step: it.step, unit: it.unit, desc: it.desc
    }));
  };

  const GROUPS = [
    /* 顺序按「改动频率 + 同类聚合」排：
       每期都要动的在最前，一次性配置居中，维护与升级类在最后。
       同组内一个决定一件事，不把站点适配混进面板行为。

       原来独立的「文案」「规则」两组已并进「模板」（1.8.0）：这几块回答的
       其实是同一个问题——**稿子上的字长什么样、按什么口径写**。
       分成两个抽象名字的组时，想改一句话要在两组之间来回找。 */
    {
      id: 'tpl', title: '模板',
      panes: [
        {
          id: 'lib', title: '文字模板',
          /* 这一页只管"字怎么写"：一条模板就是一段能编辑的正文。
             开关（这一段要不要进稿）、编辑、增删都在这里，与"哪份组合用它"无关。
             （1.14.0）从小报组合里拆出来：原来一段文字长在组合里，同一段在
             日报与周报里各是一份，改一处还得记得去另一处再改一遍。 */
          acts: [
            { act: 'libAdd', text: '新建', title: '新增一条文字模板' },
            { act: 'libReset', text: '重置', title: '整库恢复出厂那六条' }
          ],
          rows: [
            /* 编辑器由 settings.js 挂进这一页（见 mountEditor） */
            { t: 'body', body: '<div class="st-tpls" data-f="lib"></div>' }
          ]
        },
        {
          id: 'plan', title: '简报组合',
          /* 这一页只管"这一期接哪几段、谁在前"：组合 = 名字 + 周期 + 一串模板 id。
             正文不在这里——改字去「文字模板」。
             （1.14.0）用户的原话：「组合只负责在不同方案里，组合、排序、
             加减已有的文字模板」。 */
          acts: [
            { act: 'comboAdd', text: '新建', title: '新建一个组合' },
            { act: 'comboRename', text: '改名', title: '给当前组合改名' },
            { act: 'comboReset', text: '重置', title: '当前组合接的段落恢复出厂' },
            /* 长按 + 警告色：整份组合连同"接哪几段"一起删掉，没有撤销 */
            { act: 'comboDel', text: '删除', hold: true, title: '按住不放删除当前组合' }
          ],
          /* 日 / 周切换：它决定现在编的是哪一叠组合（每份组合自带周期）。
             与标题栏那颗是**同一个控件**（.ht-per），不是另一套长相。 */
          rows: [
            {
              t: 'body',
              body: '<div class="st-tpbar">' +
                '<span class="ht-per" data-f="tpseg" role="group" aria-label="编哪一份组合"></span>' +
                '</div>'
            },
            /* 该周期有哪些组合。行是"选哪一份来编"，不是出稿顺序——
               一次只出一份组合，所以没有上下移、没有"移出本方案"。 */
            { t: 'body', body: '<div class="st-plan" data-f="plan"></div>' },
            /* 当前组合接的那几段（有序）。行是引用，正文在「文字模板」页。 */
            { t: 'body', body: '<div class="st-picklist" data-f="picklist"></div>' }
          ]
        },
        {
          id: 'cas', title: '伤亡数据',
          rows: [
            /* 两套同时存在，这里只换"看得见哪一套"。切走的那套值留在自己的
               输入框里，保存时一并收走——切来切去不会丢数。 */
            {
              t: 'body',
              body: '<div class="st-tpbar">' +
                '<span class="ht-per" data-f="casseg" role="group" aria-label="伤亡填哪一套"></span>' +
                '</div>'
            },
            ...casRows('day'),
            ...casRows('week')
          ]
        },
        {
          id: 'geo', title: '区县口径',
          rows: [
            /* 三处多选（中心城区 / 起火原因 / 明细列）现在都是「一行一颗按钮 +
               点开勾选」（1.12.18）：同一类设置只有一种长相。 */
            {
              k: '中心城区', t: 'msel', f: 'coreTowns', cfg: 'coreTowns',
              desc: '勾中的区算作中心城区；一个都不勾则正文不区分中心城区'
            },
            {
              k: '起火原因', t: 'msel', f: 'causePick', cfg: 'causePick',
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
            }
          ]
        }
      ]
    },
    {
      id: 'ui', title: '界面',
      /* 五颗控件的手感参数（1.12.16）。默认值先按项目取（560px 宽的面板、
         4px 刻度），而不是网页示例那套深色大控件的数字——大屏好看的手感
         塞进 24px 的标题栏只会挤。
         每个子页标题右端一个「恢复本组」：只把这一组参数退回默认，
         不必为了一个滑杆把整页设置清掉。 */
      panes: [
        {
          id: 'nav', title: '设置导航',
          acts: [{ act: 'uiReset', part: 'nav', text: '恢复本组' }],
          rows: uiPartRows('nav')
        },
        {
          id: 'menu', title: '导出菜单',
          acts: [{ act: 'uiReset', part: 'menu', text: '恢复本组' }],
          rows: uiPartRows('menu')
        },
        {
          id: 'hold', title: '长按按钮',
          acts: [{ act: 'uiReset', part: 'hold', text: '恢复本组' }],
          rows: uiPartRows('hold')
        },
        {
          id: 'seg', title: '分段开关',
          acts: [{ act: 'uiReset', part: 'seg', text: '恢复本组' }],
          rows: uiPartRows('seg')
        },
        {
          id: 'mark', title: '状态标记',
          acts: [{ act: 'uiReset', part: 'mark', text: '恢复本组' }],
          rows: uiPartRows('mark')
        }
      ]
    },
    {
      id: 'common', title: '面板',
      /* 复位位置是这一页唯一的动作，上标题栏（1.12.18）：按钮一律站标题右端，
         正文只留可改的项。 */
      acts: [{ act: 'panelReset', text: '复位位置' }],
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
        { k: '记住位置', t: 'switch', f: 'rememberPos', cfg: 'rememberPos' }
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
      id: 'exp', title: '导出',
      /* 导出条目清单时带哪些列。37 个可选字段取自站点那张「导出项选择」，
         顺序就是列序（站点按字段清单的顺序出表，不认拖动后的次序）。
         与站点自己存的那份导出项互不影响：站点那份是账号级的，
         这份只归本机，改它不会动网页上的勾选。 */
      rows: [
        {
          k: '明细列', t: 'msel', f: 'exportCols', cfg: 'exportCols',
          items: () => (HT.EXPORT ? HT.EXPORT.titles() : []),
          desc: '导出火灾清单带哪几列，列序按本表从上到下；一列都不勾则不出文件'
        }
      ]
    },
    {
      id: 'maint', title: '维护',
      /* 四件事原来各占一段长表单，现在收在「维护」下：
         都不是每期要动的，混在模板与面板之间只会把常用的挤上去。 */
      panes: [
        {
          id: 'diag', title: '运行状态',
          /* 撤掉「运行统计」开关（1.8.0），也撤掉「反馈问题」按钮（1.9.1）：
             出错自动上报，这一组只剩状态。
             发的东西：版本号 + 环境 + 本机自检记录（短码 / 模块 / 校验项名），
             没有起数、没有区域、没有模板正文，也没有账号（见 release.js 的 report）。 */
          rows: [
            {
              k: '上报', t: 'note', f: 'obsStat',
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
          id: 'bak', title: '备份与恢复',
          /* 导出 / 导入在组标题右端（1.12.13）：它们是这一页仅有的两个动作，
             摊在"配置文件"那一行里时，那一行既说"存在哪儿"又说"怎么办"，
             读起来是两件事挤在一格里。 */
          acts: [{ act: 'exp', text: '导出' }, { act: 'imp', text: '导入' }],
          rows: [
            { t: 'file' },
            { k: '存储占用', t: 'note', f: 'used', desc: '配置与模板占用的本机空间' }
          ]
        },
        {
          id: 'cloud', title: '云端同步',
          /* 所有装了本扩展的电脑共用**一份**配置，所以这里没有同步码，
             也没有「上传 / 取回」——两个按钮能做的事，保存和打开页面已经做了。
             只在两处破例给人一个手动的口子：
               · 没同步成（断网、服务器忙）时露出「立即同步」；
               · 云端覆盖过本机时露出「还原」，退回归属那一份（只留一层）。
             开关「自动同步」不绑 cfg，它存在 cloudSync 那把键里。 */
          acts: [
            { act: 'syncNow', text: '立即同步', hidden: true },
            { act: 'syncRestore', text: '还原', hidden: true }
          ],
          rows: [
            { k: '同步', t: 'note', f: 'syncStat' },
            /* 「恢复点」（1.12.13）：云端覆盖本机之前，本机那份留的底。
               名字取备份行业的 restore point，与右上的「还原」是同一个词根。 */
            { k: '恢复点', t: 'note', f: 'syncPrev' },
            {
              k: '自动同步', t: 'switch', f: 'syncAuto',
              desc: '换机器不用重新配；保存后自动上传，打开站点时取回较新的一份'
            }
          ]
        },
        {
          id: 'ver', title: '版本信息',
          /* 打开设置页即查一次清单（跳过缓存）；查不到时才出现「重试」。
             不常驻「检查更新」：自动检查已经覆盖了同一个动作。
             下载 / 复制地址在标题右端（1.12.13）：它们是"拿到新版"的两个动作，
             与新版本号是同一件事。 */
          acts: [
            { act: 'updRetry', text: '重试', hidden: true },
            { act: 'updGet', text: '下载', hidden: true },
            { act: 'updCopy', text: '复制地址', hidden: true }
          ],
          rows: [
            { k: '当前', t: 'note', f: 'verLocal' },
            { k: '最新', t: 'note', f: 'verLatest' }
          ]
        }
      ]
    }
  ];

  /* 扁平的页列表：单页组自己就是一页，多页组按 panes 展开。
     导航、渲染、自检三处都读这一份，不再各遍历一次 GROUPS 猜结构。 */
  const panes = () => {
    const out = [];
    GROUPS.forEach(gp => {
      if (gp.panes && gp.panes.length) {
        gp.panes.forEach(p => out.push({
          gid: gp.id, id: p.id, key: gp.id + '.' + p.id,
          title: p.title,
          rows: p.rows || [], acts: p.acts
        }));
      } else {
        out.push({
          gid: gp.id, id: gp.id, key: gp.id,
          title: gp.title,
          rows: gp.rows || [], acts: gp.acts
        });
      }
    });
    return out;
  };

  /* ── 渲染 ───────────────────────────────────────────────
     输出：.st-body > (.st-nav 分类树 + .st-panes 一叠 .st-pane)。
     页脚不在这里——它是"保存动作"，属于视图，不属于设置项。

     base 传进来的是一份 normalizeCfg 后的配置：开关的 aria-checked 初值由它推出。
     0.24 的手写模板把默认值抄进了 HTML（hideSiteFab 写 false，其余写 true），
     于是"默认值"在两个地方各有一份——这里从 base 推，只保留 config.js 一处。 */

  function render(base) {
    /* data-casset 决定「人数」里哪一套行可见（每日 / 每周）。初值跟着配置里的周期，
       与模板编辑器默认打开的那套一致；不留空属性——CSS 只认 day / week，
       没有属性时两套会一起显示，也就是同一件事出现两遍。 */
    const casSet = base && base.period === 'week' ? 'week' : 'day';
    const list = panes();
    const first = list.length ? list[0].key : '';
    const out = ['<div class="st-body" data-casset="' + casSet + '" data-pane-cur="' + first + '">'];

    /* 分类树（1.12.17 按官网 CSS 档重做，branched menu）。
       组里有几页就折几项，单页组本身是一颗叶子：叶子点一下就选中，
       带子页的组点一下只折叠——这是这套菜单的两种行为，混成一种
       （点了就选中第一页）会让人在"想收起来"时被带着换了页。

       结构照抄参考实现的三层：
         .st-nav      最左边一条导轨（渐变收尾），选中分组时导轨上滑一根 16px 的亮条
         .st-tree     主干（每个展开的分组各画一段，x 由参数定）
         .stn-tree    分支：竖线折圆角伸到分类名；选中那一项另有一条同路径的
                      强调色线，靠 stroke-dashoffset 从主干"画"到它自己
       线段是算出来的（行高 / 主干位置 / 圆角 / 线宽都是参数），所以这里只留一个
       空 <svg> 当占位，几何由 uikit.js 的 navLayout 在挂载与改参数时写入。 */
    out.push('<nav class="st-nav" data-f="nav" aria-label="设置分类"><div class="st-tree">' +
      '<span class="stn-marker" aria-hidden="true"></span>');
    GROUPS.forEach(gp => {
      const kids = gp.panes && gp.panes.length ? gp.panes : null;
      if (!kids) {
        out.push('<div class="stn stn-stem"><button class="stn-hd' + (gp.id === first ? ' is-on' : '') +
          '" type="button" data-nav="' + gp.id + '">' + esc(gp.title) + '</button></div>');
        return;
      }
      const open = kids.some(p => gp.id + '.' + p.id === first);
      out.push('<div class="stn"' + (open ? ' data-open="1"' : '') + '>' +
        '<button class="stn-hd" type="button" data-navsec="' + gp.id + '" aria-expanded="' +
        (open ? 'true' : 'false') + '">' + esc(gp.title) + '</button>' +
        '<div class="stn-fold"><div class="stn-body">' +
        '<div class="stn-tree" data-sec="' + gp.id + '">' +
        '<svg class="stn-lines" aria-hidden="true"></svg>' +
        kids.map(p => {
          const k = gp.id + '.' + p.id;
          const on = k === first;
          return '<button class="stn-i' + (on ? ' is-on' : '') + '" type="button" data-nav="' + k + '"' +
            (on ? ' aria-current="page"' : '') + '>' + esc(p.title) + '</button>';
        }).join('') + '</div></div></div></div>');
    });
    out.push('</div></nav>');

    /* 内容：所有页按导航顺序**铺在同一个滚动容器里**（1.13.0）。
       以前是"一叠页、只显一页"，用户要求"右边按左边菜单的顺序全部显示，
       滚到哪一块左边就跟着变"——那其实是一页长文 + 左侧目录跟随。
       不按需重建的理由仍是模板编辑器：它装在某一页里，重建会把正在编的段
       与光标一起丢掉。全部画出来、始终可见，也就不需要 [hidden] 来回翻了。 */
    out.push('<div class="st-panes" data-f="panes">');
    list.forEach(p => {
      const on = p.key === first;
      out.push('<section class="st-sec st-pane' + (on ? ' is-on' : '') + '" data-pane="' + p.key + '">');
      if (p.acts && p.acts.length) {
        out.push('<div class="st-h"><h3>' + esc(p.title) + '</h3><span class="st-h-act">' +
          p.acts.map(btnAct).join('') + '</span></div>');
      } else {
        out.push('<h3>' + esc(p.title) + '</h3>');
      }
      (p.rows || []).forEach(r => {
        const on = r.on !== undefined ? r.on : ((r.cfg && base) ? base[r.cfg] !== false : undefined);
        let html = RENDER[r.t](r, on);
        /* 带 set 的行标上属于哪一套，由 settings.js 在容器上写 data-casset 决定显隐。
           加在生成的标签上而不是再包一层 div：包一层会打断 .st-row 的相邻选择器
           （行与行之间的分隔线是靠 :first-child / + 选的）。 */
        if (r.set) html = html.replace(/^<div class="st-row/, '<div data-set="' + r.set + '" class="st-row');
        out.push(html);
      });
      out.push('</section>');
    });
    out.push('</div></div>');
    return out.join('');
  }

  /* ── 供 settings.js 使用的视图 ───────────────────────────
     rows()     扁平化的所有行（含无 cfg 的命令行）
     bindable() 绑定 config 键的行：fill() 与 collect() 共用这一份，
                从此"界面上的开关"与"存进配置的键"不可能再对不上。 */

  const rows = () => {
    const list = [];
    panes().forEach(p => (p.rows || []).forEach(r => list.push(r)));
    return list;
  };

  /* 界面手感那些行（滑杆 / 开关）。它们绑的是嵌套的 cfg.ui，不走 cfg 那套
     平铺键，所以单独给出：fill / collect 按 part + key 组装。 */
  const uiRows = () => rows().filter(r => r.part);

  const BINDABLE_TYPES = { switch: 1, num: 1, text: 1, msel: 1 };
  const bindable = () => rows().filter(r => r.cfg && BINDABLE_TYPES[r.t]);

  /* ── 配置键归档 ─────────────────────────────────────────
     每一个 DEFAULT_CFG 键必须在这里有一个去处，verb 见 CFG_STATUS 注释。
     verify 双向比对：表里有的键必须在 DEFAULT_CFG 里，反之亦然。 */

  const CFG_STATUS = {
    /* 基准时间只在面板上调（点那一行填年月日时分秒）。anchor 是自动模式
       的每日时刻，用户不直接改它，所以归 panel 而不是 ui。 */
    anchor: 'panel',
    baseAt: 'panel',
    /* 当前统计周期（日 / 周）。面板标题栏那颗按钮与设置页「文稿组合」页
       顶上那颗切的是同一个维度：它决定这一期出哪一份组合。 */
    period: 'ui',
    /* 文字模板库（1.14.0）：一段一段的文字本身，日 / 周共用这一份。
       界面上由「文字模板」页的编辑器承载（不是一格输入框），
       所以下面的 uiKeys 把它单独算作界面键。
       combos 只存"接哪几段"（模板 id 的有序列表），正文在 tpls 里。 */
    tpls: 'ui',
    /* 文稿组合（1.14.0）：名字 + 周期 + 一串模板 id。
       pick 是日 / 周各自选中的那一个。 */
    combos: 'ui',
    pick: 'ui',
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
    /* 本周那一套（1.12.0）：同一组控件、切到「每周」才显示，所以仍是界面项。
       幅度那两格例外（1.12.14）：周报那句不带百分比（见 phrases.js 的
       wkCasYoy 传 pct:false），界面上不再画，键留着不清零，归 legacy。 */
    weekCasHurt: 'ui',
    weekCasDead: 'ui',
    weekYoyHurtDir: 'ui',
    weekYoyHurtN: 'ui',
    weekYoyHurtP: 'legacy',
    weekYoyDeadDir: 'ui',
    weekYoyDeadN: 'ui',
    weekYoyDeadP: 'legacy',
    causePick: 'ui',
    cooldownSec: 'ui',
    closeOnOutside: 'ui',
    focusDim: 'ui',
    hideSiteFab: 'ui',
    rememberPos: 'ui',
    exportCols: 'ui',
    /* 界面手感（1.12.16）：一个嵌套键，里面五组参数。
       整份由「界面」那一组的滑杆维护（见 uiRows），所以归档为 ui。
       归一化在 config.js 的 normUi 里做（上下限与步长来自 UI_PARAMS）。 */
    ui: 'ui',

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
    panes,
    render,
    rows,
    uiRows,
    bindable,
    CFG_STATUS,
    /** 需要 cfg 键的行数（verify 用它和开关数对账） */
    countCfgRows: () => bindable().length,
    /**
     * 归档为「界面」（ui）的键必须实际落在某个控件上。
     * 下面这几类不在 bindable() 里，但界面上确有入口，所以单独算进来：
     *   · tpls —— 「文字模板」页的编辑器（1.14.0 起整块由 settings.js 画）；
     *   · combos / pick —— 「文稿组合」页的列表与"接哪几段"（同上）；
     *   · period —— 模板组那颗「日 / 周」分段按钮（与标题栏切的是同一个键）；
     *   · coreTowns —— 多选浮层（picker 行）；
     *   · ui —— 界面手感那一组的滑杆（1.12.16 起是嵌套键，按 part + key 组装）；
     *   · dirNum 那一行除 cfg 之外的另两个键（幅度、方向按钮）。
     */
    uiKeys: () => {
      const out = [];
      rows().forEach(r => {
        if (!r.cfg) return;
        out.push(r.cfg);
        /* dirNum 那行除人数之外的另两格：方向按钮恒在，幅度格只在带百分比的
           那套（日模板）里画——周报那句不带 %（noPct），所以别把它算成界面键。 */
        if (r.t === 'dirNum') {
          out.push(r.dir);
          if (!r.noPct) out.push(r.cfg2);
        }
      });
      return out.concat(['tpls', 'combos', 'pick', 'period', 'ui']);
    }
  };
})(window);
