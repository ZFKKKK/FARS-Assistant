/**
 * src/data/config.js —— 版本元数据、用户档案与设置（默认值 + 归一化 + 迁移）
 *
 * @layer  data（数据层）
 * @file   src/data/config.js
 * @since  0.5.0
 *
 * 设置的唯一读写入口。设置页、面板、取数层都只通过这里拿配置，
 * 任何"默认值改一处"的需求都落到 DEFAULT_CFG / DEFAULT_TEMPLATES，不再散落各模块。
 *
 * 0.9 起多了一层「用户档案」：同一个人可能替几个使用者出稿，各人的中心城区、
 * 段落模板、措辞都不一样。存储拆成四把键，互不覆盖：
 *   profiles    [{id, name}]        用户清单
 *   activeProfile 'u1'              当前用户
 *   cfgOf       {u1: {...cfg}}      每个用户一份完整配置
 *   cfg         当前用户配置的镜像    只给 background.js 读（Service Worker 不引分层脚本）
 * 镜像必须由本文件写，别的地方一律不许直接写 cfg——
 * 两份数据一旦各写各的，提醒时刻和面板就会对不上。
 *
 * 一处必须说清的取舍（0.17）：单位称谓不再是配置项，它现在是**模板正文里的几个字**。
 * 于是"换个人出稿，称谓跟着变"这件事自动消失了——切档案换的是整段模板，
 * 若两个档案的模板是从同一份复制来的，称谓就是同一个。要换称谓只有一条路：
 * 在那一段正文里改那几个字（或用「段落模板 → 恢复出厂」重来一遍）。
 * 这不是遗漏，是"用不到的东西不做成开关"的直接后果，改文案的人得知道这一点。
 *
 * 模板（cfg.templates）是"一天要出的几段话"，见 domain/template.js：
 *   {id, title, on, text}
 *   text 是一段自由文本，中间可以插占位符：{{seg:brief}}（整段成文）
 *   或 {{f:day.C|numUnit}}（一个数据字段 + 呈现方式）。
 *   默认四段各只有一个成文占位符，也就是原来的成文逻辑；用户想改措辞，
 *   直接在设置里编辑那段话——占位符前面的标点、中间的连接词都由他决定。
 *
 * 版本策略（0.8 起重置，改在这里，免得每次改点什么都想升大版本）
 *   0.x    尚未到 1.0：功能还会动，编号只用来对账，不用来表示"成熟度"
 *   minor  新增用户看得见的功能，或某块交互换了范式
 *   patch  视觉微调、文案、样式、bug 修复——日常改动一律走 patch
 *   1.0     留给"口径与交互都定稿、能长期不动"的那一天
 */
(function (g) {
  'use strict';
  const HT = (g.__HT = g.__HT || {});

  /**
   * 版本元数据。值全部来自 data/release.js——那边是唯一策略点，
   * 这里只是换个名字方便读。改版本别改这里，改 release.js + manifest.json。
   * homepage 取 data/contract.js 的 ORIGIN：域名只该有一处，换域名不翻两遍。
   */
  const META = {
    name: '简报助手',
    enName: 'Huotong Assistant',
    version: HT.RELEASE.version,
    build: HT.RELEASE.build,
    channel: HT.RELEASE.channel,
    homepage: HT.ORIGIN + '/'
  };

  /**
   * 人数的两个老键 → 六个新键（1.8.0 迁移用）。
   *
   * 1.7.x 里 `casualtyText` 是「整句手填」（'条目造成62人受伤，57人死亡。'），
   * `casualtyYoyText` 是「伤人数同比减少3人（下降2.1%）…」。
   * 现在的设置页只填数字（1.8.0），句子由模板与 phrases.js 拼——但**升级时不能直接丢**：
   * 用户上一期填的数就在那句话里，丢了就得凭记忆重填一次。
   *
   * 两个解析器只认出厂句式（也就是默认模板与设置页提示里写的那两种）。
   * 认不出来就返回 null：宁可让人重填，也不去猜一句自由发挥的话——
   * 猜错的数字会安安静静地进稿子，比空格子危险得多。
   */

  /** '条目造成62人受伤，57人死亡。' → { hurt:'62', dead:'57' } */
  function parseCasText(s) {
    const t = String(s == null ? '' : s);
    const h = t.match(/(\d+)\s*人受伤/);
    const d = t.match(/(\d+)\s*人死亡/);
    /* 「未造成人员人数」是**明确说零**，不是"认不出" */
    const zero = /未造成人员伤亡/.test(t);
    return {
      hurt: h ? h[1] : (zero || /未造成人员受伤/.test(t) ? '0' : null),
      dead: d ? d[1] : (zero || /未造成人员死亡/.test(t) ? '0' : null)
    };
  }

  /** 一句里的一侧：'伤人数同比减少3人（下降2.1%）' → { dir, n, p } */
  function oneYoySide(t, who) {
    const re = new RegExp(who + '人数同比(增加|减少)([\\d.]+)人(?:（(上升|下降)([\\d.]+)%）)?');
    const m = String(t || '').match(re);
    if (!m) return null;
    return { dir: m[1] === '减少' ? 'down' : 'up', n: m[2], p: m[4] || '' };
  }

  function parseYoyText(s) {
    const t = String(s == null ? '' : s);
    return { hurt: oneYoySide(t, '伤'), dead: oneYoySide(t, '亡') };
  }

  /** 只留数字与小数点：这是"填数字"的格子，粘进别的东西就丢掉别的部分 */
  const numOnly = v => String(v == null ? '' : v).replace(/[^\d.]/g, '').replace(/^\./, '');

  /**
   * 有效条目同比的**固定句式**：数字留 x，由出稿人对着报表手填。
   *
   * 用户明确「有效条目同比数据不取系统的，先用 x 代替，之后告诉你口径」。
   * 《注意：连方向也不取》——HZ_01 的方向只写在 templateContent 的字面里
   * （"条目起数下降X%"），values 里没有方向列；既然整句都是占位，
   * 把方向一起猜上就成了"一半月份写反的稿子"，不如一个字都不写。
   *
   * 以后口径定了要恢复取数：HZ_01 的 yoyNum + dirOf(content,'条目起数') 那套
   * 代码还在 report.js 里（yoyC / yoyCdir），把这里的常量换成函数即可。
   */
  const CAS_FIRE_YOY_TEXT = '同比x';

  /** 默认模板数（verify 会拿它跟 DEFAULT_TEMPLATES 对账） */
  const NSEG = 4;
  /** 模板上限：面板标题用 ①–⑥，再多就没有编号可用了。
   *  （1.14.0）它是**一份组合最多接几段**，不是库的总数——库另有一个上限。 */
  const MAX_TPL = 6;
  /** 文字模板库的上限（1.14.0）：库共用一份、可以比单份组合的段数多，
   *  八份组合（MAX_COMBOS）乘以几段各不相同，库要装得下这些"各取所需"。 */
  const MAX_LIB = 12;
  /** 组合上限（1.13.0）：一屏放得下、也拦住"一个组合一段"的误用。
   *  组合是一份完整的稿子，多于这个数就该想想是不是该合并。 */
  const MAX_COMBOS = 8;
  /** 自动成文库的四个键，见 domain/segments.js */
  const AUTO_KEYS = ['brief', 'day', 'detail', 'ytd'];

  const DEFAULT_PROFILE = { id: 'u1', name: '使用者' };

  /**
   * 默认模板 = 原来的四段，0.13 起改成**变量化正文**：
   * 文字与标点逐字保留，只把"数据"和"时间"换成 {{f:key|mode}}。
   * 这样用户看到的是一篇能直接改的公文，而不是一个"整段成文"的黑盒——
   * 想把"全市"改成"全市（含区域）"、想删掉某半句，改文字就行。
   *
   * 为什么不是把每个数都摊成最小颗粒：
   *   "只列非零项""去年为零，无同比""没有中心城区就连括号一起消失"这些
   *   是**判断**，不是取数。模板不做判断（编辑器也就不需要有 if），
   *   所以这类句子整句算好，落到 ph.* 成品句字段（见 domain/phrases.js）。
   *   要拆成最小颗粒自己拼，字段目录里的原始事实（ytd. / day. / det.）都在。
   *
   * 每段用到的数据源与改造前完全一致（brief 5 个、day 2 个、detail 5 个、ytd 2 个），
   * 模板等价性比对 会比对整段文字，verify 会核对取数计划。
   */
  const DEFAULT_TEMPLATES = [
    {
      id: 't-brief', title: '每日警情数据', on: true,
      text: '警情信息：截至{{f:W.DAY.e|cnDay}}{{f:anchor|pointCn}}，全市消防救援队伍共接处警{{f:ytd.T|num}}起' +
        '（其中火灾扑救{{f:ytd.F|num}}起，占比{{f:ytd.uF|num}}%，其中成灾火灾{{f:ytd.C|num}}起，占比{{f:ytd.uC|num}}%，' +
        '无损火警{{f:ytd.N|num}}起，占比{{f:ytd.uN|num}}%；抢险救援{{f:ytd.Q|num}}起，占比{{f:ytd.uQ|num}}%，' +
        '社会救助及其他{{f:ytd.O|num}}起，占比{{f:ytd.uO|num}}%），{{f:ph.casualty|raw}}' +
        '同比{{f:ph.yoyYear|num}}年，警情起数{{f:ytd.yoyQ|raw}}，' +
        /* 人数结句与人数同比都是"设置页填数、句子由程序拼"（1.8.0）。
           ph.casualty 按人数在四种措辞里挑一句；ph.casYoyX 用设置页那四个数字
           拼成「，伤人数同比减少3人（下降2.1%），亡人数同比增加1人」。
           想自己写句子，把这两个标签换成
           「条目造成{{f:cas.hurt}}人受伤，{{f:cas.dead}}人死亡。」即可——
           措辞归模板，数字仍归设置页。 */
        '成灾火灾{{f:ph.yoyCSen|raw}}{{f:ph.casYoyX|raw}}。\n' +
        '{{f:dayRange|rangeFull}}，队伍共处置警情{{f:day.T|num}}起' +
        '（火灾扑救{{f:day.F|num}}起，其中成灾火灾{{f:day.C|num}}起，无损火灾{{f:day.N|num}}起）。' +
        '中心城区共发生成灾火灾{{f:det.nCore|num}}起{{f:ph.coreTownDesc|raw}}。'
    },
    {
      id: 't-day', title: '每日一句', on: true,
      text: '{{f:dayRange|rangeFull}}，全市共发生成灾火灾{{f:day.C|num}}起' +
        '{{f:ph.townLeadDesc|raw}}{{f:ph.causePart|raw}}。'
    },
    {
      id: 't-detail', title: '全市火灾情况', on: true,
      /* 段首的日期就是这个日期标签，写法由标签决定（点标签能改），不必回设置页。
         默认写全「2026年11月14日」：统计报告「条目整体概况」那一句就是全写，
         稿子与平台逐字对得上，核稿时不用在脑子里换算。不要日期就把标签删掉。 */
      text: '{{f:W.DAY.e|cnFullDay}}，全市共发生成灾火灾{{f:day.C|num}}起{{f:ph.typeSeg|raw}}。' +
        '出动消防车{{f:yoy.curTruck|num}}辆次、消防指战员{{f:yoy.curPerson|num}}人次，' +
        /* 这个百分比是**全市总条目**起数同比（dayA 的 HZ_01[6] + 原文方向）。
           2026-11-16 用户裁定口径：这句跟在处置后面，但比的既不是处置、也不是有效，
           是全市总条目。平台原文模板就是「共统计条目X起…同比去年，条目起数下降X%」，
           不传 isNoDamage 的那一行才是它。
           · 最初写成动同比（车次 ÷ 去年同日车次）——统计报告里没有这个数；
           · 后来改成有效同比（dayB 的 HZ_01[6]）——口径又小了一档。
           两个都仍是可选字段（{{f:yoy.truckYoyTxt}} / {{f:yoy.dCyoyTxt}}），需要就手插。 */
        '与去年同比{{f:yoy.dCyoyAllTxt|raw}}。' +
        '其中一般及以上等级火灾{{f:det.nMajor|num}}起{{f:ph.majorDesc|raw}}，' +
        '轻微火灾{{f:det.nMinor|num}}起{{f:ph.minorDesc|raw}}。' +
        '中心城区共发生成灾火灾{{f:det.nCore|num}}起，与去年同比{{f:yoy.coreYoyTxt|raw}}，' +
        '其中一般及以上等级火灾{{f:det.nCoreMajor|num}}起{{f:ph.coreMajorDesc|raw}}，' +
        '轻微火灾{{f:det.nCoreMinor|num}}起{{f:ph.coreMinorDesc|raw}}。' +
        '市委、市政府等敏感单位周边今日未发生火灾事故。'
    },
    {
      id: 't-ytd', title: '每日主官数据', on: true,
      text: '今年以来，全市消防救援队伍共接处警{{f:ytd.T|num}}起【其中火灾扑救{{f:ytd.F|num}}起，' +
        '占比{{f:ytd.uF|num}}%；抢险救援{{f:ytd.Q|num}}起，占比{{f:ytd.uQ|num}}%；' +
        '社会救助{{f:ytd.S|num}}起，占比{{f:ytd.uS|num}}%；安保勤务{{f:ytd.A|num}}起，占比{{f:ytd.uA|num}}%；' +
        '虚假警{{f:ytd.X|num}}起，占比{{f:ytd.uX|num}}%】。' +
        '接处警起数{{f:ytd.yoyQ|raw}}，共出动车辆{{f:ytd.truckTotal|raw}}辆次，出动{{f:ytd.personTotal|raw}}人次。' +
        '无损火警{{f:ytd.N|num}}起，占火灾扑救的比例为{{f:ph.pctN|raw}}%。'
    }
  ];

  /**
   * 周报的两段（1.12.0）。与每日那四段是**两套模板**，不是一套里的两段：
   * 周报只报本周与本年两句，每日要报当日处置、分布、原因、等级，混在一张清单里
   * 会让人每次出稿都要先把不相干的那几段关掉。
   *
   * 口径与每日一致的地方：本年段的有效同比用去年**补录前**的累计（{{f:ph.yoyCSen}}），
   * 人数数字与同比取设置页（{{f:ph.casualty}} / {{f:ph.casYoyX}}）。
   * 只属于周报的两句：本周人数（{{f:ph.wkCasualty}}）与本周人数同比（{{f:ph.wkCasYoy}}，
   * 文书习惯不带百分比，人数之间用顿号）。这两句读设置页「人数」里**每周那套**数
   * （weekCasHurt / weekCasDead / weekYoy*），与每日那套（今年以来累计）各存一份。
   */
  const DEFAULT_WEEK_TEMPLATES = [
    {
      id: 'w-week', title: '本周警情数据', on: true,
      text: '▲本周警情数据（{{f:weekRange|rangeFull}}），全市消防救援队伍共接处警{{f:week.T|num}}起' +
        '（火灾扑救{{f:week.F|num}}起，占比{{f:week.uF|num}}%，其中成灾火灾{{f:week.C|num}}起，' +
        '占比{{f:week.uC|num}}%，无损火警{{f:week.N|num}}起，占比{{f:week.uN|num}}%；' +
        '抢险救援{{f:week.Q|num}}起，占比{{f:week.uQ|num}}%，社会救助及其他{{f:week.O|num}}起，' +
        '占比{{f:week.uO|num}}%），{{f:ph.wkCasualty|raw}}' +
        '同比{{f:ph.yoyYear|num}}年，警情起数同比{{f:week.yoyQ|raw}}，成灾火灾{{f:week.yoyC|raw}}' +
        '{{f:ph.wkCasYoy|raw}}。'
    },
    {
      id: 'w-ytd', title: '本年警情数据', on: true,
      text: '▲本年警情数据。截至{{f:W.DAY.e|cnDay}}{{f:anchor|pointCn}}，全市消防救援队伍共接处警{{f:ytd.T|num}}起' +
        '（其中火灾扑救{{f:ytd.F|num}}起，占比{{f:ytd.uF|num}}%，其中成灾火灾{{f:ytd.C|num}}起，' +
        '占比{{f:ytd.uC|num}}%，无损火警{{f:ytd.N|num}}起，占比{{f:ytd.uN|num}}%；' +
        '抢险救援{{f:ytd.Q|num}}起，占比{{f:ytd.uQ|num}}%，社会救助及其他{{f:ytd.O|num}}起，' +
        '占比{{f:ytd.uO|num}}%），{{f:ph.casualty|raw}}' +
        '同比{{f:ph.yoyYear|num}}年，警情起数{{f:ytd.yoyQ|raw}}，成灾火灾{{f:ph.yoyCSen|raw}}' +
        '{{f:ph.casYoyX|raw}}。'
    }
  ];

  /* ── 文字模板库（1.14.0）────────────────────────────────────
     一层是"字怎么写"，一层是"这一期用哪几段"——两件事在两页里各管各的：

       文字模板  单段文字（{id, title, on, text}）——编辑器里那张卡片，
                 开关 / 编辑 / 增删都在「文字模板」页
       文稿组合  一个名字 + 一个周期（日 / 周）+ **一串模板 id**（有序），
                 组合 / 排序 / 加减在「文稿组合」页

     两页而不是一页（1.14.0 拆开）：原来一张卡片同时长在组合里，想改一句话
     得先想清楚"我在改哪份组合里的这一段"；同一段文字在日报与周报里各是一份，
     改一处还得记得去另一处再改一遍。拆开之后文字只写一份，组合只回答
     "接哪几段、谁在前"——与用户的原话一致：「组合只负责在不同方案里，
     组合、排序、加减已有的文字模板」。

     **库是日 / 周共用的一份**：出厂六条（四条当日 + 两条本周）。日报组合引用
     那四条，周报引用全部六条。这是"文字只写一遍"的前提，代价是改一条会同时
     改到所有用到它的组合——这正是集中管理要的效果，不是副作用。

     周期放在组合上（而不是模板上）：一个组合从头到尾按一种窗口取数，
     周报要报当日，就把当日那几段**接进周组合**——它在周窗口下取数，
     W.DAY 仍然是条件时间那一天。 */
  const DEFAULT_LIB = DEFAULT_TEMPLATES.concat(DEFAULT_WEEK_TEMPLATES)
    .map(t => ({ id: t.id, title: t.title, on: t.on, text: t.text }));

  const DEFAULT_COMBOS = [
    { id: 'c-day', name: '日常简报', period: 'day', ids: DEFAULT_TEMPLATES.map(t => t.id) },
    {
      /* 周报 = 本周两段 + 当日四段：周日与周一这两天既要报本周、也要报当日，
         这是原来的手工流程，也是旧「周方案接周套件 + 日套件」的结果。
         两段周报文字在前、四段当日文字在后，与旧拼接顺序逐段一致。 */
      id: 'c-week', name: '周报', period: 'week',
      ids: DEFAULT_WEEK_TEMPLATES.concat(DEFAULT_TEMPLATES).map(t => t.id)
    }
  ];

  /* ── 界面参数（1.12.16）──────────────────────────────────────
     设置页左侧分类树、标题栏的日 / 周开关、导出菜单、查询图标和
     「恢复默认」的长按按钮，各有几个手感参数。它们放在 data 层，
     因为同一个数字要用在三处：DEFAULT_CFG.ui 的默认值、归一化时的上下限、
     设置页那一行滑杆的 min / max / step。抄三遍迟早有一处漂移，
     于是这张表是**唯一来源**，另两处都从它推出来。

     kind: 'num'（滑杆）| 'bool'（开关）。默认值一律先按项目取：
     面板只有 560px 宽、字号与间距都落在 4px 刻度上，所以默认值不是
     网页示例里那套深色大控件的数字，而是"在 560px 里还站得住"的那一档。 */
  const UI_PARAMS = {
    nav: {
      title: '设置导航',
      desc: '设置页左侧的分类树：主干线从分组折向分类名',
      items: [
        { f: 'rowHeight', k: '行高', unit: 'px', min: 22, max: 40, step: 1, def: 30, desc: '分类项每一行的高度；分组标题跟着它略高一点' },
        { f: 'trunk', k: '主干位置', unit: 'px', min: 6, max: 26, step: 1, def: 12, desc: '竖线距左边界的距离；分支从这里折向分类名' },
        { f: 'radius', k: '转折圆角', unit: 'px', min: 0, max: 16, step: 1, def: 8, desc: '分支线拐弯处的圆角' },
        { f: 'lineWidth', k: '线宽', unit: 'px', min: 1, max: 3, step: 0.5, def: 1.5, desc: '主干与分支的线宽' },
        { f: 'fontSize', k: '字号', unit: 'px', min: 11, max: 15, step: 1, def: 12, desc: '分类名的字号；比内容小一档，导航才不抢正文' }
      ]
    },
    menu: {
      title: '导出菜单',
      desc: '标题栏那颗 ⇩ 点开的两行：菜单从图标那一角长出来，高亮块在两行之间滑',
      items: [
        { f: 'rowHeight', k: '行高', unit: 'px', min: 26, max: 52, step: 1, def: 32, desc: '一行的高度；一行文件名（1.12.18 起菜单只写文件名）居中排在中间' },
        { f: 'radius', k: '圆角', unit: 'px', min: 4, max: 16, step: 1, def: 10, desc: '菜单与高亮块的圆角' },
        { f: 'menuWidth', k: '宽度', unit: 'px', min: 160, max: 280, step: 2, def: 200, desc: '菜单的最小宽度；说明文字放不下时会自己撑宽' },
        { f: 'glideDuration', k: '滑动时长', unit: 'ms', min: 0, max: 400, step: 10, def: 170, desc: '高亮块在两行之间滑过去的时长，0 = 直接跳' },
        { f: 'popDuration', k: '展开时长', unit: 'ms', min: 60, max: 400, step: 10, def: 180, desc: '菜单从图标那一角长出来的时长' }
      ]
    },
    hold: {
      title: '长按按钮',
      desc: '「恢复默认 / 还原」这类不可撤销的动作：按住不放，液面从左边推满才算确认',
      items: [
        { f: 'holdTime', k: '长按时长', unit: 'ms', min: 400, max: 3000, step: 50, def: 1300, desc: '按住多久才算确认；太短容易误触，太长按着累' },
        { f: 'radius', k: '圆角', unit: 'px', min: 4, max: 14, step: 1, def: 7, desc: '按钮与液面的圆角' },
        { f: 'pressScale', k: '按下缩放', unit: '×', min: 0.9, max: 1, step: 0.005, def: 0.965, desc: '按住时整颗按钮缩到多少，1 = 不缩' },
        { f: 'wave', k: '液面起伏', kind: 'bool', def: true, desc: '填充前沿那道流动的波峰；关掉是一条直边' },
        { f: 'waveAmplitude', k: '起伏幅度', unit: 'px', min: 0, max: 10, step: 1, def: 5, desc: '波峰的高度；按钮只有 26px 高，超过 8 会盖住字' },
        { f: 'glow', k: '推满发光', kind: 'bool', def: true, desc: '按住时按钮外圈的光随液面涨满，完成时再散一圈' },
        { f: 'releaseTime', k: '回弹时长', unit: 'ms', min: 60, max: 400, step: 10, def: 180, desc: '松手后液面退回去的时长' },
        { f: 'resetAfter', k: '完成停留', unit: 'ms', min: 0, max: 3000, step: 50, def: 1300, desc: '完成后「已恢复」留多久再变回原标题，0 = 一直留着' }
      ]
    },
    seg: {
      title: '分段开关',
      desc: '标题栏的日 / 周：滑块在两格之间先拉长、再挤进目标格',
      items: [
        { f: 'size', k: '高度', unit: 'px', min: 20, max: 32, step: 1, def: 24, desc: '整条开关的高度；标题栏那一行只有 24 的位置' },
        { f: 'radius', k: '圆角', unit: 'px', min: 4, max: 14, step: 1, def: 8, desc: '轨道圆角；滑块比它小一圈，才同心' },
        { f: 'inset', k: '内边距', unit: 'px', min: 1, max: 6, step: 1, def: 2, desc: '滑块与轨道边缘之间的空隙' },
        /* （1.13.0）格宽：一颗按钮左右各留多少。原来写死 2px，两个字挤成
           一条 36px 的小条，用户提"太窄太挤"。默认 10 = 一颗 32px 宽。 */
        { f: 'pad', k: '格宽', unit: 'px', min: 2, max: 18, step: 1, def: 10, desc: '每颗按钮左右各留的空；太小了「日 / 周」挤成一条' },
        { f: 'stretch', k: '拉伸', unit: '%', min: 0, max: 160, step: 5, def: 100, desc: '换项时滑块先横跨新旧两格再收回；0 = 纯平移' },
        { f: 'squash', k: '回弹', unit: 'px', min: 0, max: 8, step: 1, def: 3, desc: '滑块末端越过目标格再弹回来的距离' },
        { f: 'speed', k: '速度', unit: '×', min: 0.25, max: 2, step: 0.05, def: 1, desc: '整体快慢，1 是标准速度' }
      ]
    },
    mark: {
      title: '状态标记',
      desc: '标题栏那颗查询图标：静止是整圈，查询中转成一道弧，完成画对勾',
      items: [
        { f: 'size', k: '尺寸', unit: 'px', min: 14, max: 20, step: 1, def: 18, desc: '圆的外径；按钮本身只有 24px' },
        { f: 'strokeWidth', k: '线宽', unit: 'px', min: 1, max: 3, step: 0.1, def: 2, desc: '圆与对勾的线宽' },
        { f: 'dashes', k: '分段数', unit: '段', min: 1, max: 16, step: 1, def: 8, desc: '静止时的刻度段数（8 是参考实现的取值）；1 = 整圈' },
        { f: 'arcLength', k: '弧长', unit: '', min: 0.2, max: 0.9, step: 0.01, def: 0.68, desc: '查询中那道弧占整圈的比例' },
        { f: 'spinDuration', k: '转速', unit: 'ms', min: 400, max: 2000, step: 50, def: 1100, desc: '转一圈的时长' },
        { f: 'drawDuration', k: '描线时长', unit: 'ms', min: 80, max: 600, step: 10, def: 240, desc: '完成 / 出错时对勾或叉画出来的时长' },
        { f: 'fillOpacity', k: '圈内底色', unit: '', min: 0, max: 0.2, step: 0.01, def: 0.06, desc: '完成时圈里的那层淡色底' }
      ]
    }
  };

  /** 出厂值：从 UI_PARAMS 的 def 推，不另抄一份 */
  const DEFAULT_UI = {};
  Object.keys(UI_PARAMS).forEach(part => {
    const o = {};
    UI_PARAMS[part].items.forEach(it => { o[it.f] = it.def; });
    DEFAULT_UI[part] = o;
  });

  /**
   * 界面参数归一化：坏值回落默认、越界夹回区间、按 step 对齐。
   * 为什么要对齐 step：滑杆只能给到刻度，手工改配置却可能给 27.3px——
   * 不清掉这个小尾巴，面板会为了半个像素去算一次布局。
   */
  /** 步长暗示的小数位数：0.005 → 3，0.01 → 2，1 → 0 */  function uiStepDec(step) {
    const t = String(step == null ? 1 : step);
    const i = t.indexOf('.');
    return i < 0 ? 0 : t.length - i - 1;
  }

  /* 界面参数的默认值版本：每次"改掉某个默认值"就 +1，
     并在 UI_OLD_DEFAULTS 里记下那一版之前的旧值。 */
  const UI_REV = 2;
  const UI_OLD_DEFAULTS = {
    nav: { rowHeight: 28 },
    menu: { rowHeight: 40 },
    hold: { holdTime: 900, waveAmplitude: 4 },
    mark: { dashes: 1 }
  };

  /** 把"还停在旧默认"的项删掉，让 normUi 落成新默认；自己调过的不动 */
  function upgradeUi(raw) {
    const src = raw && typeof raw === 'object' ? JSON.parse(JSON.stringify(raw)) : {};
    Object.keys(UI_OLD_DEFAULTS).forEach(part => {
      const t = src[part];
      if (!t || typeof t !== 'object') return;
      Object.keys(UI_OLD_DEFAULTS[part]).forEach(k => {
        const old = UI_OLD_DEFAULTS[part][k];
        if (t[k] == null || Number(t[k]) === old) delete t[k];
      });
    });
    return src;
  }

  /* 这一次 normalizeCfg 有没有真把界面参数往上抬过。loadCfg 据此决定要不要
     顺手写回存储——不写回的话，每次打开都重升一遍，「存储里的值」与
     「界面上的出厂值」长期不是同一个数，验收脚本拿这两个对账就会红，
     而且用户点保存时写回去的是升级后的值、退出再进来又变回旧的。 */
  let uiBumped = false;

  function normUi(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const out = {};
    Object.keys(UI_PARAMS).forEach(part => {
      const s = src[part] && typeof src[part] === 'object' ? src[part] : {};
      const o = {};
      UI_PARAMS[part].items.forEach(it => {
        const v0 = s[it.f];
        if (it.kind === 'bool') { o[it.f] = v0 !== false; return; }
        let v = Number(v0);
        if (!Number.isFinite(v)) v = it.def;
        v = Math.max(it.min, Math.min(it.max, v));
        if (it.step) v = Math.round(v / it.step) * it.step;
        /* 取整到**步长的位数**，不是一律两位。
           踩过：按下缩放的步长是 0.005，按两位取整把 0.965 变成 0.97——
           滑杆的刻度与存下来的值从此对不上，往回调一格读数不动，
           看着像"滑杆坏了"。（settings.js 里 fmtV 的 stepDec 是同一个道理。） */
        o[it.f] = Number(v.toFixed(uiStepDec(it.step)));
      });
      out[part] = o;
    });
    return out;
  }

  /**
   * 段落标题的旧名 → 新名（「每日王总数据」→「每日汇总数据」）。
   *
   * 标题存在每个人的 storage 里，改了默认值只影响新装的机器；老机器读回来的
   * 还是旧标题。只认**精确旧名**：用户自己把这一段改叫别的，一律不动——
   * 那是他的稿子，不是我们的默认值。
   */
  const TITLE_ALIAS = { '每日王总数据': '每日主官数据' };

  const DEFAULT_CFG = {
    /* 自动模式下的结算时刻。1.1 起设置页不再暴露它——要指定取到哪一刻，
       点面板上的「基准时间」直接填年月日时分秒（baseAt）。留着这个键是因为
       没填 baseAt 的机器仍然按每天 18:00 结算，那是绝大多数人的用法。 */
    anchor: '18:00:00',
    /* 手填的基准时间，'YYYY-MM-DDTHH:MM:SS' 本地时间；空串 = 自动。
       它是取数的右端：当日窗口 = 它往前推 24 小时，YTD 与同比也都以它为准。 */
    baseAt: '',
    /* 文字模板库（1.14.0）：一段一段的文字本身，日 / 周共用这一份。
       改一条会同时改到所有接了它的组合——这是"文字只写一遍"的前提。
       「文稿组合」页只管接哪几段、谁在前（combos[].ids）。 */
    tpls: DEFAULT_LIB,
    /* 文稿组合：一个名字 + 一个周期 + 一串模板 id（有序）。
       出稿 = 取当前周期的那个组合，按 ids 的顺序从库里取段渲染。 */
    combos: DEFAULT_COMBOS,
    /* 每个周期当前选中的组合 id（同周期可以有多个组合）。
       标题栏那颗日 / 周切的就是这个：day 取 pick.day，week 取 pick.week。
       归一化时校验它指向的组合真的存在、且周期对得上，否则回落到该周期第一个。 */
    pick: { day: 'c-day', week: 'c-week' },
    /* 面板上的统计周期：day = 每日（滚动 24 小时），week = 每周（周一 0 时至条件时间）。
       记在配置里是为了下次打开还停在原来的周期——出周报那两天不必每次再切一次。 */
    period: 'day',
    shortTown: true,                     // 区域用简称
    /* 渝北、江北并入两江：系统里三个区域是分开的（取数、统计都不动），
       只是正文输出时合成「两江」一处，起数相加。
       关掉就照平台原值各写各的（渝北 N 起、江北 M 起、两江新区 K 起）。 */
    townMerge: true,
    causeLead: '起火原因主要为：',
    /* 句尾不带条数（2026-11-15 用户定）：这句是"其余还在查"，读者要看的是
       已列出的那几类，数字只会让人以为能和总数对账。模板里仍支持 {n}——
       谁想改回带数字，把 {n} 写回来就是。 */
    pendingTpl: '其余正在调查中',
    /* ── 人数：只填数字，措辞在模板里（1.8.0） ──
       1.7.x 之前这两项是"整句手填"：每期把「条目造成62人受伤，57人死亡。」
       整句敲一遍，数字敲错一个要等核稿才发现。现在数字与措辞分开：
         · 数字在这六格里（下面四个）；
         · 措辞是正文里那几句话，默认由模板里的 {{f:ph.casualty}} 输出。
       空 = 这次照抄平台。不是"没填就报错"——平台那几个数在报表口径上与
       支队上报的对不上，所以它是兜底而不是首选（见 docs 里那句"两个来源"。） */
    casHurt: '',
    casDead: '',
    /* 人数同比：正负由「增加 / 减少」按钮决定，不让人打负号。
       dir 只认 up / down；人数与幅度都存**绝对值**，方向只写一处——
       两处各存一个符号，迟早出现"人数减少、幅度上升"这种自相矛盾的稿子。 */
    yoyHurtDir: 'up',
    yoyHurtN: '',
    yoyHurtP: '',
    yoyDeadDir: 'up',
    yoyDeadN: '',
    yoyDeadP: '',
    /* 本周人数与本周同比（1.12.0）：与上面那两组**各存一份**。
       为什么不共用：上面那两格填的是今年以来累计（「条目造成53人受伤，
       39人死亡」），一周的人数得单独从周报上抄。共用一格的结果只有两种——
       要么把累计数写成一周的人数，要么每周改一次、改完忘了改回来。
       取值顺序同每日：设置里填了就按填的写，留空才用平台本周值。 */
    weekCasHurt: '',
    weekCasDead: '',
    weekYoyHurtDir: 'up',
    weekYoyHurtN: '',
    weekYoyHurtP: '',
    weekYoyDeadDir: 'up',
    weekYoyDeadN: '',
    weekYoyDeadP: '',
    /* 起火原因展示哪几类：勾选的列出起数，未勾选的与未填的一起归入句尾
       「其余正在调查中」（2026-11-15 用户定）。原来这里是硬编码的
       CAUSE_EXCLUDE 黑名单，只能划掉、不能选入，且看一眼代码才知道有哪些类。 */
    causePick: '生活用火不慎、电气故障、玩火、吸烟、遗留火种、自燃',
    /* 中心城区名单：**故意留空**。这是使用者所在城市的口径，不该由代码预设——
        公开分发时不带任何具体区域，首次使用由使用者在设置里按本单位口径填写。
        留空是已支持的状态：「中心城区」这个概念不存在，相关句子连括号一起去掉
        （见 domain/checks.js 里那条判据），不会写出「中心城区 0 起」。
        填法：顿号分隔的短名，与平台返回的区域名对得上即可。 */
    coreTowns: '',
    /* 导出条目清单带哪几列：顿号分隔的列名，顺序即列序（勾掉的跳过）。
       默认是站点「导出项选择」里初始勾的那 11 项，也就是手点导出默认得到的那张表。
       全不勾 = 不能导出，面板会提示——不做"空就回退全部"的隐藏兜底，
       那会让取消勾选毫无效果。 */
    exportCols: '火灾编号、警情编号、接警时间、行政区域、警情地址、是否轻微火灾、起火场所、伤亡情况、责任区大队、填报时间、报告状态',
    focusFont: 15,                       // 专注态正文字号（12–22，面板里 A− / A+ 调）
    cooldownSec: 3,                      // 生成冷却秒数（防连点）
    closeOnOutside: true,                // 点面板外空白处收起
    /* 专注态点外面：true = 只变淡（面板留着、点回即恢复）；
       false = 跟普通态一样收起。 */
    focusDim: true,
    hideSiteFab: false,                  // 屏蔽站点自带的悬浮 AI 图标
    siteFabSelectors: '',                // 附加规则；留空只用内置规则 + 自动识别
    rememberPos: true,                   // 记住面板上次的位置
    /* 模板形态版本。0.13 起默认模板是变量化正文（tplVer 2）；
       3 起「正文日期」由配置项改成模板里的日期标签；
       4 起那个标签默认写全（2026年11月14日），与统计报告条目段的写法一致。
       小于它的配置在读到时就地升级一次，升完写上它，之后不再碰——
       否则用户哪天主动插入「整段成文」标签，下次保存又被换掉。 */
    /* 界面手感（1.12.16）：设置页分类树、导出菜单、长按按钮、日 / 周开关、
       查询图标各自的几个参数。默认值在 UI_PARAMS 里按项目实际取过
       （560px 宽的面板、4px 刻度），不是网页示例那套深色大控件的数字。 */
    ui: DEFAULT_UI,
    tplVer: 4
  };

  const p2 = n => String(n).padStart(2, '0');

  /**
   * 截点统一成 HH:MM:SS。
   *
   * 早先存的是 '18:00'。读回来补成 '18:00:00'——旧配置不用迁移，也不在
   * window / background / 设置页各写一遍解析（那种重复迟早有一处漏掉秒）。
   *
   * 为什么要到秒：窗口右端是截点**前一秒**。截点只到分钟时，
   * 18:00:00–18:00:59 这一分钟悬在两个周期之间，要么重复算、要么漏掉。
   */
  function normAnchor(v) {
    const m = String(v == null ? '' : v).trim()
      .match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) return DEFAULT_CFG.anchor;
    const h = +m[1], mi = +m[2], s = +(m[3] || 0);
    if (h > 23 || mi > 59 || s > 59) return DEFAULT_CFG.anchor;
    return p2(h) + ':' + p2(mi) + ':' + p2(s);
  }

  /**
   * 手填的基准时间统一成 'YYYY-MM-DDTHH:MM:SS'（本地时间，无时区后缀）。
   *
   * 空串、认不出、日期不存在，一律回落 ''（= 自动）而不是报错：这个值来自
   * 面板上的输入框，顺手贴进一串别的东西不该让整份配置存不下来。
   * 必须回读比对——`new Date(2026, 1, 31)` 不报错，它顺延成 3 月 3 日。
   */
  function normBaseAt(v) {
    const m = String(v == null ? '' : v).trim()
      .match(/^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) return '';
    const y = +m[1], mo = +m[2], d = +m[3], h = +m[4], mi = +m[5], s = +(m[6] || 0);
    if (y < 2000 || y > 2100 || h > 23 || mi > 59 || s > 59) return '';
    const dt = new Date(y, mo - 1, d, h, mi, s, 0);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return '';
    return `${y}-${p2(mo)}-${p2(d)}T${p2(h)}:${p2(mi)}:${p2(s)}`;
  }

  /* ── 模板：结构归一 ───────────────────────────────────────
     语义校验（占位符指向的字段是否真的存在）放在 domain/template.js ——
     那一层才知道字段目录，放这里会让 data 依赖 domain。 */

  /**
   * 0.9 的块数组 → 0.10 的自由文本。
   * 只服务一个场景：老配置升上来时不能把用户自己写的模板弄丢。
   */
  function blocksToText(blocks) {
    if (!Array.isArray(blocks)) return '';
    return blocks.map(b => {
      if (!b) return '';
      if (b.t === 'text') return String(b.s == null ? '' : b.s);
      if (b.t === 'auto') return '{{seg:' + b.k + '}}';
      if (b.t === 'f') return '{{f:' + b.k + '|' + (b.v || 'num') + '}}';
      return '';
    }).join('');
  }

  /**
   * 0.13 的模板升级：正文如果**恰好**就是那一个整段成文占位符，
   * 说明这一段用户没动过，换成新的变量化正文；改过一个字的就不碰。
   * 用 AUTO_KEYS 定位而不是数组下标——段落可以被增删排序，按下标会对错段。
   */
  function upgradeSegOnly(text) {
    const m = /^\{\{seg:([a-z]+)\}\}$/.exec(String(text).trim());
    if (!m) return null;
    const i = AUTO_KEYS.indexOf(m[1]);
    if (i < 0) return null;
    const d = DEFAULT_TEMPLATES[i];
    return d ? d.text : null;
  }

  /**
   * 0.14：时间字段从"一条字段一种写法"收成"一个字段几种写法"。
   * 旧正文里留着的旧键（如 anchorText）换成新键与新写法，字面值不变。
   * 判断顺序要紧：已经是新写法的原样放过，否则每存一次都会被改回默认写法。
   */
  function migrateTokens(text) {
    const alias = HT.FIELD_ALIAS;
    if (!alias) return String(text || '');
    /* 「正文日期」原先是配置项 docDate 的出文口：模板里一个 {{f:ph.dateLead|raw}}，
       写法由那个下拉决定，tag 本身不带信息。现在写法归模板——换成日期字段，
       并把 tag 自带的那一个逗号补回去（后面若已经跟了逗号就只留一个）。 */
    let t = String(text || '').replace(/\{\{f:ph\.dateLead\|raw\}\}，?/g,
      '{{f:W.DAY.e|cnFullDay}}，');
    /* 段首日期一律写成「2026年11月14日」：统计报告的条目段就是全写，稿子要与它
       逐字对得上。**只换紧跟"全市共发生有效条目"的那一个**——「截至11月14日18时」
       那个日期是另一种读法，不能跟着变全写。 */
    t = t.replace(/\{\{f:W\.DAY\.e\|cnDay\}\}，全市共发生/g,
      '{{f:W.DAY.e|cnFullDay}}，全市共发生');
    /* 「全市条目情况」里处置后面那个同比，2026-11-16 定口径为**全市总条目**：
       · 上一版的默认句是「有效条目起数与去年同比」——比的是有效，小了一档；
       · 更早是处置同比（truckYoyTxt）——统计报告里根本没有这个数。
       两条都只动**整句仍是默认原样**的那一处：用户改过一个字就不碰，那是他的稿子。 */
    t = t.replace(/人次[；;]\s*成灾火灾起数与去年同比\{\{f:yoy\.dCyoyTxt(?:\|[^}]*)?\}\}。?/g,
      '人次，与去年同比{{f:yoy.dCyoyAllTxt|raw}}。');
    t = t.replace(/人次[，,]\s*与去年同比\{\{f:yoy\.truckYoyTxt(?:\|[^}]*)?\}\}/g,
      '人次，与去年同比{{f:yoy.dCyoyAllTxt|raw}}');
    /* 「轻微条目8起。」→「轻微条目8起（渝中、两江、沙坪坝各2起，巴南、南岸各1起）」
       （1.12.14 用户要求：轻微条目也要把区域起数列清楚）。
       老配置里存的模板是改版前那一份，只改默认值够不着它——所以这条迁移无条件跑。
       只补**整句仍是默认原样**的那一处（`起` 后紧跟句号、且后面还没有这个变量），
       用户把它改写过就不碰；已经是新写法时正则不再匹配，重复读也不会叠加。 */
    t = t.replace(/(轻微火灾\{\{f:det\.nMinor(?:\|[^}]*)?\}\}起)(?!\{\{f:ph\.minorDesc)(。)/g,
      '$1{{f:ph.minorDesc|raw}}$2');
    return t.replace(/\{\{f:([^|}]+)(?:\|([^}]*))?\}\}/g, (m, k, mode) => {
      const a = alias[k];
      if (!a) return m;
      const valid = (HT.modesOf ? HT.modesOf(a.k) : []).map(x => x.k);
      if (mode && valid.indexOf(mode) >= 0) return m;   // 已迁移过
      return '{{f:' + a.k + '|' + a.mode + '}}';
    });
  }

  /**
   * 模板数组归一化。defaults 让每日与每周共用同一套规则——
   * 两套模板的字段（id / title / on / text）与上限完全一样，差别只在出厂内容。
   * @param {Array} list 读到的那一份
   * @param {Array} [legacy] 0.8 的勾选数组（只有每日那套用得上）
   * @param {boolean} [upgrade] 是否做"整段成文 → 变量化正文"的迁移
   * @param {Array} [defaults] 出厂模板，缺省为每日四段
   */
  function normTemplates(list, legacy, upgrade, defaults) {
    const DEF = defaults || DEFAULT_TEMPLATES;
    let arr = Array.isArray(list) && list.length ? list : null;
    if (!arr) {
      arr = DEF.map(t => ({ id: t.id, title: t.title, on: t.on, text: t.text }));
      /* 从 0.8 升上来：勾选状态按位置搬到模板的 on 上 */
      if (Array.isArray(legacy) && legacy.length === arr.length) {
        arr.forEach((t, i) => { t.on = !!legacy[i]; });
      }
    }
    const out = [];
    const seen = Object.create(null);
    arr.slice(0, MAX_TPL).forEach((t, i) => {
      const o = t || {};
      let id = String(o.id || ('t' + i)).slice(0, 24) || ('t' + i);
      while (seen[id]) id = id + '_' + i;
      seen[id] = true;
      /* text 优先；只有 blocks 的老配置就地转成 text */
      const raw = typeof o.text === 'string' ? o.text : blocksToText(o.blocks);
      const text = migrateTokens((upgrade && upgradeSegOnly(raw)) || String(raw).slice(0, 4000));
      const title0 = String(o.title == null ? '' : o.title).trim().slice(0, 30)
        || (DEF[i] && DEF[i].title) || ('第' + (i + 1) + '段');
      const title = TITLE_ALIAS[title0] || title0;
      out.push({ id, title, on: o.on !== false, text });
    });
    if (!out.length) {
      return DEF.map(t => ({ id: t.id, title: t.title, on: t.on, text: t.text }));
    }
    /* 一段都没开等于没有产出，强制留第一段 */
    if (!out.some(t => t.on)) out[0].on = true;
    return out;
  }

  /** 段落开关归一化，并兼容 4.x 的 5 段配置（现在只服务"旧数据迁移"这一条路） */
  function normalizeSegments(arr) {
    if (!Array.isArray(arr)) return [true, true, true, true];
    const a = arr.map(Boolean);
    if (a.length === 5) return [a[0] || a[1], a[2], a[3], a[4]];
    if (a.length !== NSEG || !a.some(Boolean)) return [true, true, true, true];
    return a;
  }

  /* ── 文稿组合：归约与解析（1.13.0）────────────────────────
     组合 id 只认这套字符：它要进段落的 key（'c-day/t1'）与 pick，
     带空格、顿号、斜杠会让"这是哪个组合"说不清，也会把 key 拆坏。 */
  const CID_OK = /^[A-Za-z0-9_-]{1,24}$/;

  /** 组合名：压掉连续空白、截 12 字（设置页那一行放不下更多），空则给个中性名 */
  const normComboName = v => {
    const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, 12);
    return s || '未命名组合';
  };

  /** 一份组合里那串模板 id：只认库里真有的、去重、保序、截到 MAX_TPL。
   *  顺序就是出稿顺序，所以**保序**是这套里最重要的一条。 */
  const normIds = (list, lib) => {
    const has = Object.create(null);
    (lib || []).forEach(t => { has[t.id] = 1; });
    const out = [];
    (Array.isArray(list) ? list : []).forEach(x => {
      const id = String(x == null ? '' : x);
      if (!has[id] || out.indexOf(id) >= 0) return;
      out.push(id);
    });
    return out.slice(0, MAX_TPL);
  };

  /** 一个组合：一个名字 + 一个周期 + 一串模板 id（1.14.0）。
   *
   *  老配置（1.13.x 及以前）把段落**直接嵌**在组合里：那时组合是一份完整的稿子，
   *  段落是它自己的拷贝。现在库独立出来，这里把 `tpls[].id` 摘成 ids，
   *  正文由 `libFromCombos` 另行抽进库——两处各做一件事，迁移只有这一条路。 */
  const normCombo = (c, i, lib) => {
    const period = c && c.period === 'week' ? 'week' : 'day';
    const id = c && CID_OK.test(String(c.id || '')) ? String(c.id) : ('c-' + (i + 1));
    const raw = Array.isArray(c && c.ids) ? c.ids
      : ((c && Array.isArray(c.tpls)) ? c.tpls.map(t => t && t.id) : []);
    /* legacy 只在"读到的是更早那版"时有用（0.8 的勾选数组），
       它管的是段落开关，现在归库，由 libFromCombos → normLib 处理。 */
    return { id, name: normComboName(c && c.name), period, ids: normIds(raw, lib) };
  };

  /** 组合列表：丢掉认不出的项、撞 id 的加后缀；一个都没有则回落到出厂两个。
   *  并且**每个周期至少留一个**：标题栏那两颗按钮不能有任何一颗切到空稿——
   *  「切到日结果什么都没有」是最难查的一种。
   *  一段都没接的组合补上库里第一条：空组合出的是空稿，那比"接错一段"更难查。 */
  const normCombos = (raw, lib) => {
    const list = Array.isArray(raw) ? raw : [];
    const out = [];
    const seen = Object.create(null);
    list.forEach((c, i) => {
      if (!c || typeof c !== 'object') return;
      const one = normCombo(c, i, lib);
      let id = one.id;
      let k = 2;
      while (seen[id]) id = one.id + '-' + (k++);
      one.id = id;
      seen[id] = 1;
      if (!one.ids.length && lib && lib.length) one.ids = [lib[0].id];
      out.push(one);
    });
    /* 出厂那两份本身就是 raw 格式，直接再走一遍，省掉一份"复制段落"的逻辑 */
    if (!out.length) return normCombos(DEFAULT_COMBOS, lib);
    ['day', 'week'].forEach(p => {
      if (out.some(c => c.period === p)) return;
      const d = DEFAULT_COMBOS.filter(c => c.period === p)[0];
      if (!d) return;
      let id = d.id;
      let k = 2;
      while (seen[id]) id = d.id + '-' + (k++);
      seen[id] = 1;
      out.push({ id, name: d.name, period: p, ids: normIds(d.ids, lib) });
    });
    return out;
  };

  /** 把一串组合里**内嵌**的段落抽成库（1.14.0 老配置升级用）。
   *
   *  同一 id 在好几份组合里都出现时以**先遇到的为准**（日组合排在周组合前面，
   *  所以周报里那四段当日文字会让位给日报那份）。这一版的取舍是"文字只写一份"，
   *  因此老配置里"日报改了措辞、周报还是旧文案"的那种分叉会被抹平——
   *  合并后两处统一成先遇到的那份。 */
  const libFromCombos = list => {
    const out = [];
    const seen = Object.create(null);
    (Array.isArray(list) ? list : []).forEach(c => {
      ((c && Array.isArray(c.tpls)) ? c.tpls : []).forEach(t => {
        if (!t || typeof t !== 'object') return;
        const id = String(t.id || '');
        if (!id || seen[id] || out.length >= MAX_LIB) return;
        seen[id] = 1;
        out.push({ id, title: t.title, on: t.on, text: t.text });
      });
    });
    return out;
  };

  /** 库归一化：认不出的项丢掉、id 去重、占位符迁移、标题别名。
   *  与 normTemplates 的差别只有两处：没有"按位置回落出厂"（库是混合的，
   *  第 i 条不对应任何固定的出厂模板），以及上限是 MAX_LIB。 */
  const normLib = (raw, up) => {
    const list = Array.isArray(raw) ? raw : [];
    const out = [];
    const seen = Object.create(null);
    list.slice(0, MAX_LIB).forEach((t, i) => {
      if (!t || typeof t !== 'object') return;
      let id = String(t.id || ('t' + i)).slice(0, 24) || ('t' + i);
      while (seen[id]) id = id + '_' + i;
      seen[id] = 1;
      /* text 优先；只有 blocks 的老配置就地转成 text（与 normTemplates 同一条规则） */
      const src = typeof t.text === 'string' ? t.text : blocksToText(t.blocks);
      const text = migrateTokens((up && upgradeSegOnly(src)) || String(src == null ? '' : src).slice(0, 4000));
      const title0 = String(t.title == null ? '' : t.title).trim().slice(0, 30) || ('第' + (i + 1) + '段');
      out.push({ id, title: TITLE_ALIAS[title0] || title0, on: t.on !== false, text });
    });
    if (!out.length) return DEFAULT_LIB.map(t => Object.assign({}, t));
    /* 一条都不开等于没有产出，强制留第一条（与 normTemplates 同一条兜底） */
    if (!out.some(t => t.on)) out[0].on = true;
    return out;
  };

  /** 这份配置的库。cfg 没写（归一化之前的裸对象）就用出厂那份 */
  const libOf = cfg => (cfg && Array.isArray(cfg.tpls) && cfg.tpls.length) ? cfg.tpls : DEFAULT_LIB;

  /** 把一份组合的 ids 解析成模板对象（顺序即出稿顺序）。
   *  返回的是**拷贝**：组合是只读视图，改它不该动到库。 */
  const comboTpls = (cfg, c) => {
    if (!c) return [];
    const by = Object.create(null);
    libOf(cfg).forEach(t => { by[t.id] = t; });
    return (Array.isArray(c.ids) ? c.ids : [])
      .map(id => by[id]).filter(Boolean)
      .map(t => Object.assign({}, t));
  };

  /** 对外暴露的组合对象带 tpls：读稿子的地方（report / segments / checks）
   *  只关心"这一期有哪几段、什么顺序"，不该各自去实现一遍"ids → 模板"。
   *  存储里仍然只有 ids，tpls 是解析出来的，不写回。 */
  const withTpls = (cfg, c) => (c ? Object.assign({}, c, { tpls: comboTpls(cfg, c) }) : null);

  /** 全部组合（解析后）。按 id 找一份时用它——直接翻 cfg.combos 拿到的是 raw，
   *  上面没有 tpls（1.14.0 踩过：segments 的 byId 分支会拿到 undefined）。 */
  const combosAll = cfg => {
    const cs = (cfg && Array.isArray(cfg.combos) && cfg.combos.length) ? cfg.combos : DEFAULT_COMBOS;
    return cs.map(c => withTpls(cfg, c));
  };

  /** 旧形态 → 组合（内嵌段落的那种，1.13.x 的存储形态）。三条来源：
   *
   *   ① （1.12.15）~（1.12.18）：groups + plans。
   *      方案按序接的组**合成一个组合**（周方案 = 周套件 + 日套件 → 周组合六段）；
   *      方案没接到的组各自成一个组合、名字用组名——升级时不能悄悄删掉别人的稿子。
   *   ② （1.12.12） 及以前：templates + weekTemplates（还有更早的 daySets / weekSets）。
   *      weekSets 里写着 day 的，周组合要带上日那几段，那是那时默认值的含义。
   *   ③ 全空（新装 / 恢复默认传入空对象）：出厂两个组合。
   *
   *  （1.14.0）这里产出的仍然是"段落嵌在组合里"的中间态，交给 normalizeCfg 的
   *  那一步拆成"库 + ids"——迁移只写一遍，别在这里又拆一次。 */
  const combosFromLegacy = c => {
    const groups = (c && Array.isArray(c.groups) ? c.groups : [])
      .filter(g => g && typeof g === 'object');
    const out = [];
    const add = (id, name, period, tpls, legacy) => {
      const one = { id, name, period, tpls: Array.isArray(tpls) ? tpls.slice() : [] };
      if (Array.isArray(legacy)) one.legacy = legacy;
      out.push(one);
    };
    if (groups.length) {
      /* absorbed：这个组已经进了哪一份组合（只用于"没被任何方案接到的组"那条兜底）。
         local：**这一份组合里**有没有接过它——同一个组可以同时出现在日方案与
         周方案里（出厂值就是"周方案接周套件 + 日套件"），跨周期不该算重复。 */
      const absorbed = Object.create(null);
      ['day', 'week'].forEach(p => {
        const plan = c && c.plans && c.plans[p] && Array.isArray(c.plans[p].groups)
          ? c.plans[p].groups : null;
        /* 没写方案（或方案里一个组都不剩）→ 这个周期自己的第一个组 */
        const ids = (plan && plan.length) ? plan
          : groups.filter(g => (g.period === 'week' ? 'week' : 'day') === p)
            .slice(0, 1).map(g => g.id);
        const tpls = [];
        const local = Object.create(null);
        ids.forEach(id => {
          const g = groups.filter(x => x.id === id)[0];
          if (!g || local[g.id]) return;
          local[g.id] = 1;
          absorbed[g.id] = 1;
          (Array.isArray(g.tpls) ? g.tpls : []).forEach(t => tpls.push(t));
        });
        if (!tpls.length) return;
        add(p === 'week' ? 'c-week' : 'c-day', p === 'week' ? '周报' : '日常简报', p, tpls);
      });
      groups.forEach(g => {
        if (absorbed[g.id]) return;
        const p = g.period === 'week' ? 'week' : 'day';
        add('c-x' + (out.length + 1), normComboName(g.name), p, g.tpls);
      });
      if (out.length) return out;
    }
    /* 全空（新装 / 恢复默认传空对象）：交给 normCombos 回落到出厂那两份。
       不在这里拼一份 weekT 为空的周报——那会得到"只有两段周报、没有当日"，
       而（1.13.0）的出厂周报是六段。 */
    const none = t => !(Array.isArray(t) && t.length);
    if (none(c && c.templates) && none(c && c.weekTemplates)) return out;
    const clone = a => a.map(t => Object.assign({}, t));
    const dayT = none(c && c.templates) ? clone(DEFAULT_TEMPLATES) : c.templates;
    const weekT = none(c && c.weekTemplates) ? clone(DEFAULT_WEEK_TEMPLATES) : c.weekTemplates;
    /* 更早那两版把"周报也带当日"写在 weekSets 里 */
    const weekAlsoDay = !!(c && /(^|[、,，;；\s])day([、,，;；\s]|$)/.test(String(c.weekSets || '')));
    add('c-day', '日常简报', 'day', dayT, c && c.segments);
    add('c-week', '周报', 'week', weekAlsoDay ? weekT.concat(dayT) : weekT);
    return out;
  };

  /** 周期参数缺省时取配置里的那个（cfg.period）。
   *  少了这一句，`buildSegments(cfg)`、`report.run()` 里那句"不传周期"
   *  的调用会一律落到 day——周周期下出来的还是日报那四段，而且不报错。 */
  const periodOfArg = (cfg, period) => ((period || (cfg && cfg.period)) === 'week' ? 'week' : 'day');

  /** 当前周期的所有组合（设置页那一行按周期过滤后列出来；带解析好的 tpls）。 */
  const combosOf = (cfg, period) => {
    const p = periodOfArg(cfg, period);
    const cs = (cfg && Array.isArray(cfg.combos) && cfg.combos.length) ? cfg.combos : DEFAULT_COMBOS;
    const out = cs.filter(c => c.period === p);
    return (out.length ? out : cs.slice(0, 1)).map(c => withTpls(cfg, c));
  };

  /** 这一期出哪个组合：pick → 该周期第一个 → 第一个。
   *  名字里不带 groups：render.js 已经有一个 `HT.groupsOf`（字段目录的分组，
   *  参数是分类名），同名的话后加载的那份会把这份覆盖掉，
   *  表现是"组合永远解析成空"而两个文件单独看都对。 */
  const comboOf = (cfg, period) => {
    const p = periodOfArg(cfg, period);
    const cs = (cfg && Array.isArray(cfg.combos) && cfg.combos.length) ? cfg.combos : DEFAULT_COMBOS;
    const want = cfg && cfg.pick && cfg.pick[p];
    const hit = want ? cs.filter(c => c.id === want && c.period === p)[0] : null;
    return withTpls(cfg, hit || cs.filter(c => c.period === p)[0] || cs[0] || null);
  };

  /** 每个周期选中的组合：pick 指向的不存在 / 周期对不上时，回落到该周期第一个。 */
  const normPick = (raw, combos) => {
    const out = {};
    ['day', 'week'].forEach(p => {
      const want = raw && raw[p];
      const hit = want ? combos.filter(c => c.id === want && c.period === p)[0] : null;
      const first = hit || combos.filter(c => c.period === p)[0] || combos[0];
      out[p] = first ? first.id : '';
    });
    return out;
  };

  /** 所有组合的所有原子模板（扁平）。
   *  校验类判断要问的是"正文到底用不用这个字段"——问的是整份配置里
   *  所有可能进正文的段，不是一个组合当前的这几段。 */
  /** 整份配置里所有可能进正文的段（1.14.0 起就是库本身）。
   *  校验类判断要问的是"正文到底用不用这个字段"——问的是所有可能进正文的段，
   *  不是当前这一份组合当前接的那几段。库是共用的一份，正好是这个问题。 */
  const tplsAll = cfg => libOf(cfg).map(t => Object.assign({}, t));

  /** 这一期的周期（导出文件名与校验口径用它）。
   *  一个组合只有一种周期，所以这里恒为一个值；留着这个函数是因为
   *  report.meta 与导出都按"可能多个"在读。 */
  const setsOf = (cfg, period) => [periodOfArg(cfg, period)];

  /** 任意来源的配置对象 → 合法配置（不抛错，坏值静默回落默认） */
  function normalizeCfg(c) {
    /* 模板形态只有在"读到的配置还是旧形态"时升一次，升完即写 tplVer。
       必须先看 c 本身：Object.assign 已经把缺失的 tplVer 补成新值了，
       拿 cfg.tplVer 去比永远相等，迁移会静默不执行。 */
    const tplUpgrade = !(c && c.tplVer === DEFAULT_CFG.tplVer);
    const cfg = Object.assign({}, DEFAULT_CFG, c || {});

    /* ── 文字模板库 + 文稿组合（1.14.0）─────────────────────
       一层是"字怎么写"（库：cfg.tpls），一层是"这一期接哪几段、谁在前"
       （组合：cfg.combos[].ids）。两个真源，各写各的，谁也不派生谁。

       迁移只有一条路：
         · 老配置（1.13.x 及以前）把段落嵌在组合里 → libFromCombos 抽成库，
           normCombo 那边同时把 `tpls[].id` 摘成 ids；
         · 更老的 groups/plans、templates/weekTemplates 先由 combosFromLegacy
           拼成"内嵌段落"的组合，再走上面那一条。
       幂等：升级完 cfg.tpls 一定有值、组合一定只有 ids，下次读回来走不到迁移。 */
    const rawCombos = (c && Array.isArray(c.combos) && c.combos.length)
      ? c.combos : combosFromLegacy(c);
    const rawLib = (c && Array.isArray(c.tpls) && c.tpls.length) ? c.tpls : null;
    cfg.tpls = normLib(rawLib || libFromCombos(rawCombos), tplUpgrade);
    cfg.combos = normCombos(rawCombos, cfg.tpls);
    cfg.pick = normPick(c && c.pick, cfg.combos);
    /* 老键全删：留着会被下次 saveCfg 原样写回去，然后某天又被读出来用一遍。
       templates / weekTemplates 曾经是"与组合里那份同一个数组"的派生视图，
       最容易被误改，（1.14.0）连组合里的段落也不再存一份，只存 ids。 */
    ['groups', 'plans', 'templates', 'weekTemplates', 'daySets', 'weekSets']
      .forEach(k => { delete cfg[k]; });
    cfg.period = cfg.period === 'week' ? 'week' : 'day';
    cfg.tplVer = DEFAULT_CFG.tplVer;
    delete cfg.segments;
    cfg.anchor = normAnchor(cfg.anchor);
    cfg.baseAt = normBaseAt(cfg.baseAt);
    /* 到点提醒整套已撤（见上一版）。老配置里留着的两个键在这里清掉，
       免得存进存储后又被当成"有效字段"读回来。 */
    delete cfg.remind;
    delete cfg.remindOffset;
    cfg.cooldownSec = Math.max(0, Math.min(30, Number(cfg.cooldownSec)));
    if (!Number.isFinite(cfg.cooldownSec)) cfg.cooldownSec = 3;
    cfg.closeOnOutside = cfg.closeOnOutside !== false;
    cfg.focusDim = cfg.focusDim !== false;
    cfg.townMerge = cfg.townMerge !== false;
    /* 「正文日期」不再是一个配置项：它现在是模板里那个日期标签的写法
       （cnDay / cnFullDay / md），用户点一下标签就能换，不必分两个地方改。
       老配置里的 docDate 键在这里清掉，免得被当成"有效字段"读回来；
       老模板里的 {{f:ph.dateLead|raw}}（自带尾随逗号）由 migrateTokens 换成日期标签。 */
    delete cfg.docDate;
    /* 单位称谓 / 敏感单位结句 / 结尾补充句自 0.17 起不再是配置项：
       它们是模板正文里的几个字，想改就改那几个字。
       老配置里若还留着这三个键，这里不删也不补——AUTO 那几段历史成文
       还在用它们（见 segments.js 的兜底常量），删掉会让老稿子换一个称谓。 */
    cfg.hideSiteFab = cfg.hideSiteFab === true;
    cfg.rememberPos = cfg.rememberPos !== false;
    cfg.siteFabSelectors = String(cfg.siteFabSelectors || '').trim().slice(0, 600);
    cfg.focusFont = Math.max(12, Math.min(22, Number(cfg.focusFont) || DEFAULT_CFG.focusFont));
    /* 界面参数：老配置没有这一个键，normUi 会给整份默认值；
       半个 ui（只改过导航）也补齐，缺的那几项一样落回默认。

       （1.12.17）默认值升级过一次：1.12.16 的默认值是"先按项目取"的初稿，
       这一版按参考实现重取（长按 0.9→1.3 秒、刻度圈 1→8 段、行高 28→30、
       起伏 4→5）。**默认值改不到已经存过配置的人手上**，所以这里逐项判断：
       值仍等于旧默认（或压根没写）才换；已经自己调过的不动。
       用 uiRev 记一次，之后不再跑——否则用户把长按改回 0.9 秒，
       下次读配置又被"升"成 1.3。 */
    if (!(c && Number(c.uiRev) >= UI_REV)) {
      const before = JSON.stringify(cfg.ui === undefined ? null : cfg.ui);
      cfg.ui = upgradeUi(cfg.ui);
      if (JSON.stringify(cfg.ui) !== before) uiBumped = true;
    }
    cfg.ui = normUi(cfg.ui);
    cfg.uiRev = UI_REV;

    /* ── 人数：老句子拆成数字（1.8.0） ──────────────────────
       只在"新键还空着"时填，避免把用户已经填过的新数覆盖掉
       （云端取回、导入备份都可能带来半新半老的一份配置）。 */
    if (c && (c.casualtyText !== undefined || c.casualtyYoyText !== undefined)) {
      const a = parseCasText(c.casualtyText);
      const b = parseYoyText(c.casualtyYoyText);
      if (!String(cfg.casHurt).trim() && a.hurt !== null) cfg.casHurt = a.hurt;
      if (!String(cfg.casDead).trim() && a.dead !== null) cfg.casDead = a.dead;
      if (!String(cfg.yoyHurtN).trim() && b.hurt) {
        cfg.yoyHurtDir = b.hurt.dir; cfg.yoyHurtN = b.hurt.n; cfg.yoyHurtP = b.hurt.p;
      }
      if (!String(cfg.yoyDeadN).trim() && b.dead) {
        cfg.yoyDeadDir = b.dead.dir; cfg.yoyDeadN = b.dead.n; cfg.yoyDeadP = b.dead.p;
      }
    }
    /* 老键删掉：留着会被下次 saveCfg 原样写回去，然后某天又被读出来用一遍 */
    delete cfg.casualtyText;
    delete cfg.casualtyYoyText;

    cfg.casHurt = numOnly(cfg.casHurt);
    cfg.casDead = numOnly(cfg.casDead);
    cfg.yoyHurtN = numOnly(cfg.yoyHurtN);
    cfg.yoyHurtP = numOnly(cfg.yoyHurtP);
    cfg.yoyDeadN = numOnly(cfg.yoyDeadN);
    cfg.yoyDeadP = numOnly(cfg.yoyDeadP);
    cfg.yoyHurtDir = cfg.yoyHurtDir === 'down' ? 'down' : 'up';
    cfg.yoyDeadDir = cfg.yoyDeadDir === 'down' ? 'down' : 'up';
    /* 本周那一套同规：数字只留数字，方向只认 up / down。新键没有历史包袱，
       所以不参与上面那段老句子拆解——只做清洗。 */
    cfg.weekCasHurt = numOnly(cfg.weekCasHurt);
    cfg.weekCasDead = numOnly(cfg.weekCasDead);
    cfg.weekYoyHurtN = numOnly(cfg.weekYoyHurtN);
    cfg.weekYoyHurtP = numOnly(cfg.weekYoyHurtP);
    cfg.weekYoyDeadN = numOnly(cfg.weekYoyDeadN);
    cfg.weekYoyDeadP = numOnly(cfg.weekYoyDeadP);
    cfg.weekYoyHurtDir = cfg.weekYoyHurtDir === 'down' ? 'down' : 'up';
    cfg.weekYoyDeadDir = cfg.weekYoyDeadDir === 'down' ? 'down' : 'up';
    /* 导出列按站点那张清单过一遍：云端取回、导入备份都可能带来这一版没有的列名
       （站点删了列、或换了叫法），留着会让 header 拼出一个服务端不认的字段。
       顺序保持用户勾的顺序，重复的只留一次。 */
    cfg.exportCols = String(cfg.exportCols || '').split(/[、,，;；]+/).map(x => x.trim())
      .filter((x, i, a) => x && HT.EXPORT.keyOf(x) && a.indexOf(x) === i).join('、');
    return cfg;
  }

  /**
   * 导出列清单。配置里是顿号串，拆成数组交给取数层；顺序就是列序。
   * 全不勾返回空数组——调用方据此提示"没有勾选导出列"，不替人做主。
   */
  function exportColsOf(cfg) {
    const c = cfg || DEFAULT_CFG;
    return String(c.exportCols || '').split(/[、,，;；]+/).map(x => x.trim()).filter(Boolean);
  }

  /* ── 用户档案存储 ─────────────────────────────────────── */
  const KEY = { cfg: 'cfg', profiles: 'profiles', active: 'activeProfile', cfgOf: 'cfgOf' };

  /** 有没有可用的扩展存储。离线预览 / Node 测试里没有，那不是"读失败"。 */
  function hasStore() {
    try { return !!(g.chrome && g.chrome.storage && g.chrome.storage.local); }
    catch (e) { return false; }
  }

  /**
   * 读四把键。
   *
   * 这里曾经把"读不到"和"没有数据"当成同一件事：超时或报错都 resolve({})，
   * 于是 pack({}) 得出一份单用户空档案，下一次 saveCfg 就把它整份写回去——
   * 其余档案与模板全部消失，界面还显示"已保存"。读失败必须是失败。
   *
   * 三种情况分开：
   *   没有 storage 扩展环境（预览、Node） → 返回 {}，这是正常降级；
   *   有 storage 但回调报错            → reject，让上层说"读不到，别保存"；
   *   有 storage 但 1500ms 没回调      → reject，同上（超时同样是没读到）。
   *
   * 这个兜底原先是 500ms。本地读通常在 20ms 内回来，但冷启动（扩展刚装上、
   * 杀毒软件在扫、机械盘、休眠唤醒）会慢上一个量级；500ms 一到就判失败，
   * 面板会说"配置读不到，别保存"，而实际上再等一会儿就读到了——**假警报比慢更糟**，
   * 它会让人以为配置坏了，转头去恢复备份。
   * 1500ms 是"真卡死"和"只是慢"之间的折中：失败路径只晚出现一秒，
   * 而正常路径一秒都不会等（回调先到就先结束）。
   */
  /**
   * 读/写存储失败。统一走 errors.js 的 STORAGE 卡——
   * 面板据此显示「配置读不到」，而不是笼统的「数据不完整」。
   * 事实部分只说发生了什么（被拒绝 / 超时 / 写入失败），
   * 「关掉面板重开、别保存」这类处置语在卡里，不在这里重复。
   */
  function storeErr(fact, cause) {
    return HT.err('STORAGE', fact, cause ? { cause } : null);
  }

  function readStore() {
    if (!hasStore()) return Promise.resolve({});
    return new Promise((resolve, reject) => {
      let done = false;
      const fin = (o, err) => {
        if (done) return;
        done = true;
        if (err) reject(err); else resolve(o || {});
      };
      try {
        g.chrome.storage.local.get([KEY.cfg, KEY.profiles, KEY.active, KEY.cfgOf], r => {
          const le = g.chrome.runtime && g.chrome.runtime.lastError;
          fin(r, le ? storeErr('读取被拒绝（' + (le.message || '未知原因') + '）') : null);
        });
      } catch (e) {
        fin(null, storeErr('读取被拒绝（' + ((e && e.message) || e) + '）', e));
      }
      setTimeout(() => fin(null, storeErr('读取超时（1.5 秒）')), 1500);
    });
  }

  function normProfiles(list) {
    const out = [];
    const seen = Object.create(null);
    (Array.isArray(list) ? list : []).forEach((p, i) => {
      const o = p || {};
      /* 不再 slice(0,24)：档案 id 与 cfgOf 的键必须逐字相等，这边截一刀、
         那边截一刀，遇到超长 id 就会两边不一致，那个用户的模板会静默变回出厂。
         只设一个上限防超长脏数据。 */
      let id = String(o.id || ('u' + (i + 1))).slice(0, 64);
      while (seen[id]) id = id + '_' + i;
      seen[id] = true;
      const name = String(o.name == null ? '' : o.name).trim().slice(0, 16) || ('用户' + (i + 1));
      out.push({ id, name });
    });
    return out;
  }

  /** 把存储读出来的四把键拼成一份可用的档案包（含迁移） */
  function pack(o) {
    const list = normProfiles(o[KEY.profiles]);
    const cfgOf = Object.assign({}, o[KEY.cfgOf] || {});
    if (!list.length) list.push({ id: DEFAULT_PROFILE.id, name: DEFAULT_PROFILE.name });
    let activeId = String(o[KEY.active] || '');
    if (!list.some(p => p.id === activeId)) activeId = list[0].id;
    /* 首次升级：老数据只有 cfg，把它落到当前用户名下 */
    if (cfgOf[activeId] == null) cfgOf[activeId] = o[KEY.cfg] || null;
    return { list, activeId, cfgOf };
  }

  function writePack(p) {
    return new Promise(resolve => {
      const payload = {};
      payload[KEY.profiles] = p.list;
      payload[KEY.active] = p.activeId;
      payload[KEY.cfgOf] = p.cfgOf;
      /* 镜像：background.js 只认 cfg，它不加载分层脚本 */
      payload[KEY.cfg] = normalizeCfg(p.cfgOf[p.activeId]);
      try {
        g.chrome.storage.local.set(payload, () => {
          /* 写失败多半是配额满（chrome.storage.local 默认 10MB）或磁盘问题。
             不查 lastError 就会一路 resolve(true)，界面说"已保存"而实际没写进去。 */
          const le = g.chrome.runtime && g.chrome.runtime.lastError;
          const ok = !le;
          /* 自动上传只有一个触发点：写成功这里。放在配置层而不是各个界面里，
             是因为"改配置"的入口不止一个——设置页保存、面板改基准时间、
             导入备份、模板恢复出厂，漏掉哪一条都会出现"改了但没同步"，
             而这种漏不会报错，只会让人在另一台机器上看到旧配置。 */
          if (ok) {
            try {
              if (HT.cloud && HT.cloud.onCfgSaved) HT.cloud.onCfgSaved();
            } catch (e) { }
          }
          resolve(ok);
        });
      } catch (e) { resolve(false); }
    });
  }

  /**
   * 读配置。优先当前用户档案；非扩展环境（离线预览、Node 测试）退回内存值，
   * 1.5 秒兜底，绝不因为回调不来而卡住启动。
   */
  function loadCfg() {
    return readStore().then(o => {
      const p = pack(o);
      uiBumped = false;
      const cfg = normalizeCfg(p.cfgOf[p.activeId]);
      /* 界面参数刚被抬到新默认：把结果写回存储。
         失败不算错——升级是"顺手做的好事"，写不进去下次再升一遍即可，
         千万别因此让整个面板读不到配置。 */
      if (!uiBumped) return cfg;
      uiBumped = false;
      p.cfgOf[p.activeId] = cfg;
      return writePack(p).then(() => cfg, () => cfg);
    });
  }

  /**
   * 写配置。仍然写进 profiles 那份结构里的当前档案——
   * 存储形状不改，只为兼容：老机器上那份档案还在原地，
   * 新版本读它、写它，升级不会把配置读成出厂值。
   */
  function saveCfg(cfg) {
    return readStore().then(o => {
      const p = pack(o);
      p.cfgOf[p.activeId] = normalizeCfg(cfg);
      return writePack(p);
    });
  }

  /* 1.2 起没有"切人/建人/删人"这几个动作了：一台机器一套配置。
     存储里那份 profiles 仍然照原样读写（老机器升级过来不会丢配置），
     只是不再对外提供切换入口——少一层"换人之后旧稿怎么办"的时序问题。 */

  /**
   * 只把文稿组合恢复成出厂（日常文稿 + 周报），其它配置一律不动。
   *
   * 为什么不提供"全部恢复默认"：模板改坏是最常见的误操作，而框选区域、
   * 屏蔽规则、字号这些是长期攒出来的，一起清掉等于让人重配一遍——
   * 用户会因此不敢点这个按钮，那它就没用了。
   */
  function resetTemplates() {
    return loadCfg().then(cfg => {
      cfg.combos = freshCombos();
      cfg.pick = { day: 'c-day', week: 'c-week' };
      cfg.tplVer = DEFAULT_CFG.tplVer;
      return saveCfg(cfg).then(() => normalizeCfg(cfg));
    });
  }

  /* ── 备份 ─────────────────────────────────────────────── *
   * chrome.storage 没有自动备份：换机器、清缓存、浏览器重置，
   * 模板与用户档案全部消失。所以给一份能存进 U 盘 / 发给自己的纯文本。 */

  function exportCfg() {
    return readStore().then(o => {
      const p = pack(o);
      return {
        app: '简报助手',
        version: META.version,
        at: new Date().toISOString(),
        profiles: p.list,
        activeId: p.activeId,
        cfgOf: p.cfgOf
      };
    });
  }

  /**
   * 导入备份。宁可整份拒绝，也不要导入一半——
   * 半份配置比没有配置更难排查（用户会以为恢复成功了，其实模板少了三段）。
   */
  function importCfg(input) {
    let o = input;
    if (typeof o === 'string') {
      try { o = JSON.parse(o); } catch (e) {
        return Promise.reject(new Error('不是合法的 JSON 文本'));
      }
    }
    if (!o || typeof o !== 'object' || !o.cfgOf || typeof o.cfgOf !== 'object') {
      return Promise.reject(new Error('不是简报助手的配置文件（缺少 cfgOf）'));
    }

    const list = normProfiles(o.profiles);
    if (!list.length) list.push({ id: DEFAULT_PROFILE.id, name: DEFAULT_PROFILE.name });

    const cfgOf = {};
    Object.keys(o.cfgOf).forEach(k => {
      if (!o.cfgOf[k]) return;
      cfgOf[String(k).slice(0, 64)] = normalizeCfg(o.cfgOf[k]);
    });
    /* 名单里的每个人都要有配置，否则切过去是一片空白 */
    list.forEach(p => { if (!cfgOf[p.id]) cfgOf[p.id] = normalizeCfg(null); });

    let activeId = String(o.activeId || '');
    if (!list.some(x => x.id === activeId)) activeId = list[0].id;

    return writePack({ list, activeId, cfgOf }).then(ok => {
      if (!ok) throw HT.err('STORAGE', '写入被拒绝，可能是空间不足');
      return { list, activeId };
    });
  }

  /**
   * 用了多少存储。chrome.storage.local 默认上限 10MB。
   * 实测四段模板加几个用户也就几十 KB，远不到上限——
   * 但"远不到"得能显示出来，否则用户只能凭感觉担心。
   */
  function storageInfo() {
    return new Promise(resolve => {
      const fail = () => resolve({ used: 0, quota: 10 * 1024 * 1024, unknown: true });
      try {
        g.chrome.storage.local.getBytesInUse(null, n => {
          if (g.chrome.runtime.lastError) return fail();
          resolve({ used: n || 0, quota: 10 * 1024 * 1024 });
        });
      } catch (e) { fail(); }
    });
  }

  Object.assign(HT, {
    META, NSEG, MAX_TPL, MAX_LIB, MAX_COMBOS, AUTO_KEYS, DEFAULT_TEMPLATES, DEFAULT_WEEK_TEMPLATES,
    DEFAULT_LIB, DEFAULT_COMBOS, DEFAULT_CFG, DEFAULT_PROFILE,
    UI_PARAMS, DEFAULT_UI, normUi,
    CAS_FIRE_YOY_TEXT,
    normAnchor, normBaseAt, normalizeCfg, normalizeSegments, normTemplates, normLib,
    blocksToText, exportColsOf,
    normComboName, normCombos, normCombo, combosFromLegacy, libFromCombos,
    combosOf, comboOf, normPick, combosAll, comboTpls, libOf, normIds,
    tplsAll, setsOf,
    loadCfg, saveCfg,
    resetTemplates, exportCfg, importCfg, storageInfo
  });
})(typeof window !== 'undefined' ? window : globalThis);
