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
  /** 模板上限：面板标题用 ①–⑥，再多就没有编号可用了 */
  const MAX_TPL = 6;
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
        '轻微火灾{{f:det.nMinor|num}}起。' +
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
   * 旧默认标题 → 新标题。
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
    templates: DEFAULT_TEMPLATES,        // 段落模板（标题 + 块）
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
    return t.replace(/\{\{f:([^|}]+)(?:\|([^}]*))?\}\}/g, (m, k, mode) => {
      const a = alias[k];
      if (!a) return m;
      const valid = (HT.modesOf ? HT.modesOf(a.k) : []).map(x => x.k);
      if (mode && valid.indexOf(mode) >= 0) return m;   // 已迁移过
      return '{{f:' + a.k + '|' + a.mode + '}}';
    });
  }

  function normTemplates(list, legacy, upgrade) {
    let arr = Array.isArray(list) && list.length ? list : null;
    if (!arr) {
      arr = DEFAULT_TEMPLATES.map(t => ({ id: t.id, title: t.title, on: t.on, text: t.text }));
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
        || (DEFAULT_TEMPLATES[i] && DEFAULT_TEMPLATES[i].title) || ('第' + (i + 1) + '段');
      const title = TITLE_ALIAS[title0] || title0;
      out.push({ id, title, on: o.on !== false, text });
    });
    if (!out.length) {
      return DEFAULT_TEMPLATES.map(t => ({ id: t.id, title: t.title, on: t.on, text: t.text }));
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

  /** 任意来源的配置对象 → 合法配置（不抛错，坏值静默回落默认） */
  function normalizeCfg(c) {
    /* 模板形态只有在"读到的配置还是旧形态"时升一次，升完即写 tplVer。
       必须先看 c 本身：Object.assign 已经把缺失的 tplVer 补成新值了，
       拿 cfg.tplVer 去比永远相等，迁移会静默不执行。 */
    const tplUpgrade = !(c && c.tplVer === DEFAULT_CFG.tplVer);
    const cfg = Object.assign({}, DEFAULT_CFG, c || {});
    cfg.templates = normTemplates(cfg.templates, cfg.segments, tplUpgrade);
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
    return cfg;
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
      return normalizeCfg(p.cfgOf[p.activeId]);
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
   * 只把段落模板恢复成出厂四段，其它配置一律不动。
   *
   * 为什么不提供"全部恢复默认"：模板改坏是最常见的误操作，而框选区域、
   * 屏蔽规则、字号这些是长期攒出来的，一起清掉等于让人重配一遍——
   * 用户会因此不敢点这个按钮，那它就没用了。
   */
  function resetTemplates() {
    return loadCfg().then(cfg => {
      cfg.templates = DEFAULT_TEMPLATES.map(t => Object.assign({}, t));
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
    META, NSEG, MAX_TPL, AUTO_KEYS, DEFAULT_TEMPLATES, DEFAULT_CFG, DEFAULT_PROFILE,
    CAS_FIRE_YOY_TEXT,
    normAnchor, normBaseAt, normalizeCfg, normalizeSegments, normTemplates, blocksToText,
    loadCfg, saveCfg,
    resetTemplates, exportCfg, importCfg, storageInfo
  });
})(typeof window !== 'undefined' ? window : globalThis);
