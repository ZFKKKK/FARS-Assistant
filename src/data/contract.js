/**
 * src/data/contract.js —— 站点契约（唯一来源）
 *
 * @layer  data（数据源层）
 * @file   src/data/contract.js
 * @since  0.20.0
 *
 * 这个文件只回答一个问题：**目标站点说了什么。**
 *
 * 域名、接口路径、请求参数名、请求体形状、响应里的列语义与下标、明细的必填字段名——
 * 全部是"对方一改，我就必须跟着改"的东西，因此全部集中在这里。
 * 站点改版时只改这一个文件，取数逻辑、体检、文稿生成、面板都不该动。
 *
 * 它不做的事（也别让它做）：
 *   · 不发请求            → http.js
 *   · 不校验、不判断       → schema.js
 *   · 不造错              → errors.js
 *   · 不生成任何句子       → domain/*
 *   · 不记任何用户配置     → config.js
 *
 * 站点改版时的动作清单（就三步）：
 *   1. 改这里的地址 / 参数名 / 列下标 / 字段名
 *   2. 若列的位置变了，同步改 REPORT_FIELDS 的 count 下标
 *   3. 跑 node 离线回归 —— 它拿真实快照比对列语义，对不上会红
 * 其余文件都不该动。如果动了，说明有别的"站点知识"漏在别处，回头把它搬回来。
 *
 * 为什么单独一个文件而不是留在 http.js 里：
 *   http.js 是"怎么取"，contract.js 是"取的是什么"。混在一起时，站点改一列，
 *   要在一个 389 行的取数文件里翻参数名、再到另一个文件里数下标，两次改、两次漏。
 */
(function (g) {
  'use strict';
  const HT = (g.__HT = g.__HT || {});

  /* ── 地址 ────────────────────────────────────────────── */

  /* 站点根地址是构建期占位符：源码不带具体域名，`debug/dist.js` 生成成品时注入。
     真值在本机 `ops/host.json` 的 `site` 字段，或环境变量 `SITE_ORIGIN`。 */
  const ORIGIN = '__SITE_ORIGIN__';

  const API = {
    /** 统计报告：GET，一次返回当天全部段落模板 */
    report: ORIGIN + '/acws/rest/biz/analysis/firereportstatistic/list',
    /** 有效明细：POST，路径后再拼 query */
    comprehensive: ORIGIN + '/acws/rest/biz/analysis/comprehensive/',
    /** 报表统计（固定报表）：POST，一次回一整张交叉表。2026-11-16 抓包确认 */
    reportGen: ORIGIN + '/acws/rest/biz/analysis/firereport/generate'
  };

  /* ── 报表：请求参数 ──────────────────────────────────── */
  /**
   * 这几个是固定值，与时间窗口无关。beginTime / endTime 由 win 现算，
   * isNoDamage 按口径可选，所以不放在这张表里。
   *
   * 两个来自页面本身的取值（对照统计报告页看过，不再靠猜）：
   *
   *   paragraphType '1,2,3'
   *     对应页面上「选择段落模板」的三块标签：**记录 / 处置 / 条目**。
   *     它不是"前三段"，所以不存在"4 以后是什么"——一共就三个类别。
   *     页面上每个类别下还有十几个可选模板（同比、环比、区域、处置次数等），
   *     全开会让返回变长、请求变慢；现在只要这三类里的常用段落。
   *
   *   dataTimeSource ''
   *     对应页面上的「数据石化口径 / 数据迁移口径」下拉，空串 = 页面默认那一个。
   *     **它选的是数据来源库，不是时间戳口径**——跨零点记录归哪天由报表服务端
   *     按发生时间决定，跟这个参数无关；时间窗只看 beginTime / endTime。
   *     曾经把它当成"按哪个时间切窗"查了很久，方向是错的。
   */
  /**
   * 报表互校用的固定参数：分区划分等级表 + **区域档**。
   *
   * 2026-11-16 实测（接口实测记录 §5）：
   *   - `templateCode` 定模板，`queryType` 定区划算到哪一层，两个值是唯一的两个旋钮；
   *   - 区域档 `…007` 45 行 / 9.8 KB，与下级区域档 `…015`（1102 行 / 154 KB）的数逐位相同，
   *     但没有跨区重名下级区域、没有开州区那些带前导空格的下级区域名。正文只到区域，用这一档；
   *   - `isNoDamage='0'` 与统计报告 `HZ_01` 同义（只要有效），
   *     此时「条目概况」那一列就是「一般及以上」。
   */
  const REPORT_CROSS = {
    templateCode: 'GD_HZ202310080001',
    queryType: '2023101100007',
    staticFlag: 1,
    noDamage: '0'
  };

  /** 报表互校请求体的字段名。名字只在这张表里出现一次——
      在调用处自拼 beginTime / deactivateFlag 之类，会被交付前自检拦下。 */
  const REPORT_CROSS_FIELDS = {
    queryType: 'queryType',
    typeId: 'boFireReportTypeId',
    templateCode: 'templateCode',
    title: 'excelTitle',
    down: 'isDown',
    start: 'beginTime',
    end: 'endTime',
    staticFlag: 'staticFlag',
    dataSource: 'dataTimeSource',
    deactivate: 'deactivateFlag',
    noDamage: 'isNoDamage'
  };

  /**
   * 报表互校的请求体：模板与档位取 REPORT_CROSS，时间由调用方给格式化好的字符串。
   * @param {string} begin 'YYYY-MM-DD HH:mm:ss'
   * @param {string} end   同上
   * @param {string} title 导出的表名（平台只是把它回显在 excelTitle 里）
   */
  function reportCrossBody(begin, end, title) {
    const F = REPORT_CROSS_FIELDS;
    const b = {};
    b[F.queryType] = REPORT_CROSS.queryType;
    b[F.typeId] = REPORT_CROSS.queryType;
    b[F.templateCode] = REPORT_CROSS.templateCode;
    b[F.title] = title;
    b[F.down] = false;
    b[F.start] = begin;
    b[F.end] = end;
    b[F.staticFlag] = REPORT_CROSS.staticFlag;
    b[F.dataSource] = '';
    b[F.deactivate] = '';
    b[F.noDamage] = REPORT_CROSS.noDamage;
    return b;
  }

  const REPORT_QUERY = {
    searchFlag: '1',
    /* 段落分块，逗号分隔，按块返回——**只拉用得到的那几块**。
       实测（2026-11-15，三个值各发一次）：
         1 → 30 条 JQ_01…JQ_30（记录）    2 → 9 条 CD_01…CD_09（处置）
         3 → 21 条 HZ_01…HZ_21（条目）    三块合计正好 60 条
       代码只用到 5 个模板码：JQ_01 JQ_04 / CD_01 / HZ_01 HZ_21，
       所以绝大多数请求只需要其中一块或两块；全拉等于白算 39～55 段聚合。
       具体给哪几块由 domain/report.js 的 SOURCE.types 声明，这里只放默认值。 */
    paragraphType: '1,2,3',
    /* 段名筛：逗号分隔的段名，空 = 不筛（整块返回）。
       页面「选择段落模板」勾几个就填几个——实测请求
       `paragraphType=3&paragraphName=条目整体概况,条目类型占比情况` 只回那两段。
       具体值由下面的 REPORT_NAMES 按模板码换出来，调用处不写中文。 */
    paragraphName: '',
    staticFlag: '1',
    dataTimeSource: '',
    deactivateFlag: '1'
  };

  /**
   * 段落编号 → 接口认的段名。
   *
   * 报表接口的 `paragraphType` 只能选**块**（1 记录 / 2 处置 / 3 条目），块内
   * 30/9/21 段会全部现算并返回。想只要其中一两个，唯一的口子是 `paragraphName`：
   * 页面「选择段落模板」勾选模板时就是这么发的（2026-11-16 抓包：
   * `paragraphType=3&paragraphName=条目整体概况,条目类型占比情况`，只回两段）。
   *
   * 之前一直传空串，等于把整块拉回来再丢掉。四个报表请求实测合计 174 段，
   * 代码只用其中 5 个模板码——其余 169 段的聚合是白算的。
   *
   * 段名是平台上的中文标题，改版时可能变。所以请求处**只写模板码**，
   * 名字只在这张表里出现一次；名字对不上时 fetchReport 会退回整块（见那里的自愈），
   * 后果是慢一点，不是出不了稿。新增模板码未登记时按下表取不到名字，
   * 同样退回整块——代价可控，不至于静默少取。
   */
  const REPORT_NAMES = {
    JQ_01: '警情整体概况',
    JQ_04: '警情类型占比情况',
    CD_01: '出动整体概况',
    HZ_01: '火灾整体概况',
    HZ_21: '火灾类型占比情况'
  };

  /** 报表响应：段落数组挂在哪个字段上；每段用哪个字段做键、哪个字段放列值 */
  const REPORT_SHAPE = {
    list: 'data',            // 响应体里的段落数组
    key: 'templateCode',     // 每段的编号（JQ_01 / HZ_01 …）
    value: 'templateValue',  // 每段的列值，逗号分隔的字符串
    name: 'paragraphName',   // 每段的人话名，报错时用
    content: 'templateContent'  // 每段的列名行，与 value 一一对应
  };

  /* ── 报表：列契约 ────────────────────────────────────── */
  /**
   *   code   接口里的 templateCode
   *   label  人话名称，报错时说"哪一段"用它
   *   min    用到的最大下标 + 1，少于此数说明末尾列被删
   *   count  必须能解析成数字的关键计数列（下标）
   *
   * 下标含义由 domain/report.js 的取值处反推，并与 报文快照 下的
   * 真实快照（HZ_01 的 templateContent）对过：
   *   JQ_01  [2]接处警总起数 [5][6]同比方向与数值 [7]其中一类
   *          [23]处置车辆 [24]处置人员
   *   JQ_04  [2]总起数 [3]一类 [5][7][9][11]其余四类（占比在 [4][6][8][10][12]）
   *   HZ_01  [2]有效起数 [3]死亡 [4]受伤 [5]直接经济金额
   *          [6]起数同比 [7][8]死亡/受伤人数的同比增减（已停用）
   *          ——注意 [7][8] 是「同比增减」，不是「当日数」，且**不带方向**：
   *          接口的"下降为正"口径让正数既可能是增也可能是减，方向只写在
   *          templateContent 的字面里（"死亡人数增加X人"）。要恢复这两列，
   *          必须先过 dirOf(content, '死亡人数') 拿方向，不能直接相减。
   *   HZ_21  [2]–[15]六类条目的起数与占比，[4]居住场所
   *   CD_01  [2]共处置队次 [3]共处置业务车车次 [4]共处置业务指战员人次
   *          [5][6][7] 其中一类任务的队次/车次/人次
   *          ——正文"处置业务车X辆次"取的是 [3]，不是 [6]。
   *          [6][7] 只是"其中一类任务"这一个子集（约四分之一）。
   */
  const REPORT_FIELDS = {
    JQ_01: { label: '接处警与火灾扑救', min: 25, count: [2] },
    JQ_04: { label: '警情类型占比', min: 12, count: [2, 3, 5, 7, 9, 11] },
    HZ_01: { label: '成灾火灾与伤亡', min: 9, count: [2, 3, 4] },
    HZ_21: { label: '火灾类型构成', min: 16, count: [2, 4, 6, 8, 10, 12, 14] },
    CD_01: { label: '出动力量', min: 5, count: [2, 3, 4] }
  };

  /**
   * 每一列叫什么、在第几位（语义名 → 下标）。
   *
   * 这张表存在的唯一理由：让「列位置」成为契约，而不是散在文稿生成代码里的
   * `values[2]` / `values[23]`。站点把某列往前挪一格，改这里就够了，
   * domain/report.js 一个字都不用动——那边只写 `values[C.JQ_01.total]`。
   *
   * 名字是业务的（"我要接处警总起数"），值是站点的（"它在第 2 列"）。
   * 两者分开，是这一层唯一的价值。
   *
   * 对不上的时候的症状：某个数字写成 0 或 "—"，校验却全绿——
   * 因为数量关系仍然自洽（比如同比基准和本期取错到同一列）。
   * 所以加了 verify 断言：report.js 里不允许再出现裸下标。
   */
  const REPORT_COLS = {
    /** 接处警：总起数、其中一类、记录同比方向与数值、处置车辆/人员（今年以来全口径） */
    JQ_01: { total: 2, fire: 7, yoyDir: 5, yoyNum: 6, truck: 23, person: 24 },
    /**
     * JQ_04「记录类型占比情况」：
     *   [2]总起数 [3]一类 [5]二类 [7]三类 [9]安保勤务 [11]虚假警
     *   五类在这张表里**严格**加总等于 [2]（快照实测 7498 = 817+1105+4850+101+625）。
     *   所以「五类加总」这条只能用它自己的 [2] 对账；HZ_01 的条目数是另一套口径
     *   （条目统计 vs 接处警记录），混一次加法就差几十起，红灯天天亮。
     */
    JQ_04: { total: 2, fire: 3, rescue: 5, socialAid: 7, security: 9, falseAlarm: 11 },
    /**
     * 有效：起数 / 死亡 / 受伤 / 起数同比数值。
     * [7][8] 是"死亡/受伤人数同比增减"，**不取**——那个数没有方向，
     * 接口的"下降为正"口径与字面方向对不上，取来只会写反（详见 report.js 取值处）。
     * min 仍保留 9：这两列在不在，是判断站点有没有改这一段结构的依据。
     */
    HZ_01: { total: 2, dead: 3, hurt: 4, yoyNum: 6 },
    /**
     * 条目类型构成里"居住场所"的起数，以及它的占比列。
     * [4] 是"其中居住场所"的起数（含在建构筑物里，不单列成第七类），
     * [5] 是它自己的占比——**与 [3] 同一个分母**，不是另算的。
     */
    HZ_21: { dwelling: 4, dwellingShare: 5 },
    /** 处置力量全口径：队次 / 车次 / 人次（[5][6][7] 是"其中一类任务"，不要用） */
    /* [2][3][4] 是"共处置"（全部任务）；[5][6][7] 是"其中一类任务"。
       正文那句「处置业务车X辆次、业务指战员X人次」写在一段讲**条目**的话里，
       取一类那一组（见 domain/report.js 的说明）。 */
    CD_01: { team: 2, truck: 3, person: 4, fTeam: 5, fTruck: 6, fPerson: 7 }
  };

  /**
   * HZ_21 里六类条目的列位置，顺序即正文里的列举顺序（不要重排）。
   *   label 业务名 ｜ count 起数下标 ｜ share 占比下标
   *
   * **占比照抄 share，不要自己除**。2026-11-14 在浏览器里逐值核过两遍：
   *
   *   全部口径（不传 isNoDamage，HZ_01[2]=26）：
   *     22 / 84.62 ｜ 11 / 42.31 ｜ 3 / 11.54 ｜ 0 / 0 ｜ 2 / 7.69 ｜ 1 / 3.85 ｜ 0 / 0
   *   有效口径（isNoDamage=0，HZ_01[2]=20）：
   *     18 / 90.00 ｜ 8 / 40.00 ｜ 1 / 5.00 ｜ 0 / 0 ｜ 0 / 0 ｜ 1 / 5.00 ｜ 0 / 0
   *
   * 22/26=84.62、11/26=42.31、2/26=7.69、1/26=3.85；18/20=90.00、8/20=40.00 —— 
   * **分母一律是同一响应里的 HZ_01[2]**，不是六类之和。
   * 用六类之和当分母（再凑成 100.00%）是另一套算法，只在"六类加总恰好等于有效"时
   * 与平台一致。10 月快照（551=551）与 11-13 有效口径（20=20）都恰好相等，
   * 所以这个错一直没暴露；但 11-13 全部口径实测 28 ≠ 26 —— 相等不是保证。
   * 一旦不等，正文那句就会与页面差出几个百分点（全部口径 22/28=78.57 对页面 84.62），
   * 而同一句里「居住场所」那一项又是除以有效的，一句话两个分母。
   *
   * 六类**不是互斥划分**：11-13 全部口径 22+3+0+2+1+0=28 而总数 26，
   * 有效口径 18+1+0+0+1+0=20 刚好等于总数。所以
   *   · 占比合计不一定是 100.00%（11-13 有效口径 90+40+5+5=140）；
   *   · 六类加总也不一定等于有效起数（10 月快照 551=434+25+6+2+78+6 是相等的）。
   * 两条都不能当不变式去卡，只能当提示。
   */
  const FIRE_TYPES = [
    { label: '建构筑物火灾', count: 2, share: 3 },
    { label: '室外设施设备火灾', count: 6, share: 7 },
    { label: '露天场所火灾', count: 8, share: 9 },
    { label: '户外植被火灾', count: 10, share: 11 },
    { label: '交通工具火灾', count: 12, share: 13 },
    { label: '垃圾及废弃物火灾', count: 14, share: 15 }
  ];

  /* ── 明细：请求体 ────────────────────────────────────── */
  /**
   * 除时间窗与分页外，请求体的其余部分照抄站点自己发出的那份。
   * 四个 *QueryReq 只有 warning 那个带条件——其余三个空对象不能省：
   * 实测缺字段会 400，站点不接受"只给一部分"。
   */
  const DETAIL_BODY = {
    comprehensiveDispatchQueryReq: {},
    comprehensiveDispatchHeadQueryReq: {},
    fireType: 4,
    time: [],
    dataTimeSource: '',
    staticFlag: 1
  };

  /** 时间窗在这两处的参数名不一样：报表是 beginTime/endTime，明细是 *DateStart/*DateEnd */
  const TIME_PARAMS = {
    report: { start: 'beginTime', end: 'endTime' }
  };

  /** 明细请求体里，时间窗写在哪几个字段上 */
  const DETAIL_WINDOW = {
    warning: { key: 'comprehensiveWarningQueryReq', start: 'warningDateStart', end: 'warningDateEnd' },
    fire: { key: 'comprehensiveFireQueryReq', start: 'fireDateStart', end: 'fireDateEnd' }
  };

  /** 明细响应：外层包一层 data，再包一层 payload，列表与总数在 payload 里 */
  const DETAIL_SHAPE = {
    payload: 'data',
    list: 'fireInfoList',
    total: ['total', 'totalCount', 'totalNum', 'totalElements', 'totalRows', 'totalSize']
  };

  /**
   * 明细行的稳定主键候选（按优先级）。
   * 跨页去重只认这个——不能拿整行内容当指纹：同区域、同等级、同起火原因的行
   * 本来就会有多条（轻微条目尤其常见），按内容去重会把真实的重复记录当成重复数据
   * 吃掉，条数直接对不上。
   */
  const DETAIL_KEYS = ['id', 'warningId', 'fireInfoId', 'comprehensiveId', 'rowId'];

  /* ── 综合查询：汇总（页面上「查询结果：共查询到…」那一行） ──────── */
  /**
   * 综合查询页面顶部那行字，是**服务端算好的汇总**，不是把列表行加起来：
   *
   *   查询结果：共查询到 1234 起记录记录，同比上升 4.21%；其中一类 210 起，
   *   同比上升 5.70%；二类 175 起，同比上升 0.38%；三类 849 起、
   *   安保勤务 27 起、虚假记录 65 起。共处置队伍 946 队次，处置车辆 1496
   *   辆次，处置人员 9416 人次…
   *
   * 它和统计报表（JQ_01 的 1236、JQ_04[3] 的 212）是**两套账**：同一个窗口、
   * 同一批记录，报表按日结汇总算，综合查询按明细记录数。差 2 起、2 起，0.1% 量级。
   * 两个都是平台给的，谁也证明不了谁更对——但使用者核对的是页面上这一行，
   * 所以正文取这一行（见 domain/report.js 的取值处与 口径实测记录 §14）。
   *
   * 响应里它在 `data.data` 下的汇总对象里，记录域叫 fireWarning
   * （条目域是另一个，叫 fireInfo，装的是有效起数/死亡/受伤/金额）。
   * 其中 `fireFighting` 是实测确认过的「一类」；其余字段没有文档，
   * 候选名按同一套命名习惯列出来。**认不出来不猜**——退回报表数，
   * 并在校验 ytd.head 里把"认到几项"写出来。
   */
  const HEAD_QUERY = {
    /**
     * 记录域 = fireType 1，条目域 = 4（实测：4 走 fireInfo/fireInfoList，
     * 1 走 fireWarning/fireWarningList）。取汇总是记录域，所以是 1。
     * 上一版这里漏了，沿用了明细请求体的 fireType=4，
     * 拿的是条目域的条数——与「记录记录」不是同一个数。
     */
    fireType: 1,
    /** 只要汇总，不要行：limit 给 1，省带宽也省时间 */
    limit: 1,
    /**
     * 页面上那个「共查询到 N 起记录记录」的请求，warningReq 里还带着这个开关。
     * **少了它，同样的 fireType=1 只回「一类」一类**，其余四类是 0，
     * warningCount 也与 fireFighting 相等——等于拿不到总数。
     *
     * 2026-11-15 靠页面报文对比才发现：大小写、拼写都对，就是缺这一个字段，
     * 而且平台不报错，只是默默按另一套口径统计。这类"少一个参数换个答案"的事
     * 只有把两边报文摆在一起逐字段比才看得出来。
     */
    areaGroupStaticFlag: 1,
    /** 汇总是响应里的哪个对象（按顺序试，命中即止） */
    boxes: ['fireWarning', 'warningInfo', 'warningStat', 'headInfo', 'warningSummary'],
    /**
     * 业务名 → 对方可能用的字段名（按可能性排序）。
     * 一列多候选不是偷懒：这些名字没有文档，是从真实响应里认出来的。
     * 认错一个同名字段的后果由 report.js 的 0.5% 比对兜住——
     * 同一段时间、同一批记录，两个模块不可能差出几成。
     */
    fields: {
      T: ['warningCount', 'warningTotal', 'warningNum', 'totalCount', 'total', 'count', 'jqTotal'],
      F: ['fireFighting', 'fireFightingCount', 'fireCount'],
      Q: ['emergencyRescue', 'emergencyRescueCount', 'rescue', 'rescueCount', 'rescueNum'],
      S: ['socialAid', 'socialAidCount', 'socialAssistance', 'socialAssistanceCount', 'socialRescue'],
      /* 真名是 securityService。旧候选里一个都不存在，于是这一项恒为 null ——
         而 headOk 要求六项全认得，缺一项就整块退回报表。**正文一直用报表口径，
         根子就在这里**：参数早改对了，也是白搭。名字放前面，旧候选留着兜老版本。 */
      A: ['securityService', 'security', 'securityCount', 'securityDuty', 'securityDutyCount', 'guardCount', 'safeguard'],
      X: ['falseAlarm', 'falseAlarmCount', 'falseWarning', 'falseWarningCount', 'fakeAlarm'],
      /* 处置三项在汇总里是**复数**：dispatchGroups / dispatchTrucks / dispatchNums。
         以前全写成 dispatchGroupCount 这种单数+Count 的形式，一个都没命中。 */
      team: ['dispatchGroups', 'dispatchGroupCount', 'dispatchTeamCount', 'groupCount', 'teamCount'],
      truck: ['dispatchTrucks', 'dispatchTruckCount', 'truckCount', 'dispatchCarCount'],
      person: ['dispatchNums', 'dispatchPersonCount', 'personCount', 'firemanCount', 'dispatchFiremanCount'],
      /* 同比：页面上写「同比上升 9.46%」「同比上升 51.70%」。接口给的是
         **带方向词的百分比串**（"上升9.45%" / "-"），pickNum 读不动，
         所以 key 以 yoy 开头的走 headPct（见 http.js）。 */
      yoyT: ['warningCountTb', 'warningYoy', 'warningYoyRate', 'yoy', 'yoyRate', 'tongbi', 'tbRate'],
      yoyF: ['hzCountTb', 'fireFightingYoy', 'fireYoy', 'fireYoyRate']
    }
  };

  /* ── 区域：系统里分开取，正文里并成两江 ───────────────────── */

  /**
   * 区域只有一个来源：平台明细里的「区域」字段。
   *
   * 曾经反过来做过一次——从行政区划/地址里把「两江新区」拆回渝北、江北，
   * 那是把方向搞反了。平台在系统里本来就是**分开**的：渝北区、江北区、
   * 两江新区是三个值，请求与统计都按这三个值走；并了以后就再也分不清
   * 哪起在渝北、哪起在江北，「两江到底多少起」也就查不出来了。
   *
   * 只有**输出文本**时才合成一处：正文里凡出现渝北、江北，一律写「两江」，
   * 起数相加。所以这里只描述"平台怎么给"，合并规则在 TOWN_OUT 里。
   */
  const TOWN_FIELD = 'warningTown';

  /**
   * 正文合并表：统计口径 → 输出口径。
   *
   * 为什么合并：两江新区直管区跨渝北、江北、北碚的下级区域，实际工作里三处当成
   * 一个整体说，稿子里写三个名字反而要解释"为什么渝北只有 3 起"。
   * 为什么不在取数时就并：并了就丢掉了分辨能力，
   * 而明细层的「一般及以上」「中心城区」这些筛选还要按**真区域**判断——
   * 三个值各自都算中心城区（同一起只属一个值，不重复计），但判断要拿原值
   * 归一到简称（「两江新区」→「两江」），因为名单里存的是简称。
   * **数据处理分开，输出才合并。**
   *
   * 只认全名与简称，不做模糊匹配：区域名是平台原值，多一种写法就是多一处来源。
   */
  const TOWN_OUT = {
    '渝北区': '两江新区', '渝北': '两江新区',
    '江北区': '两江新区', '江北': '两江新区',
    '两江新区': '两江新区', '两江': '两江新区'
  };

  /** 明细行的区域原值（平台给什么就是什么，只去空白） */
  function townOf(row) {
    if (!row) return '';
    const v = row[TOWN_FIELD];
    return v === null || v === undefined ? '' : String(v).trim();
  }

  /**
   * 正文里怎么写这个区域。
   * @param {string} name 平台原值
   * @param {object} [cfg] cfg.townMerge === false 时原样返回（各写各的）
   */
  function townOut(name, cfg) {
    const s = String(name || '').trim();
    if (!s) return '';
    if (cfg && cfg.townMerge === false) return s;
    return TOWN_OUT[s] || s;
  }

  /**
   * 明细必填字段。
   * 0.17 之前只查 warningTown：区域能统计，可等级与起火原因两个字段改名后
   * 正文会写"一般及以上0起""起火原因主要为正在调查中"，而校验 13/15 全绿——
   * 一个看起来完全正常的稿子，两句话是错的。
   * 所以这里逐列点名：区域、等级、起火原因，缺一个就报结构变更。
   * 区域只认平台那个字段：没有它，区域分布与中心城区两句都写不出来，
   * 而正文看上去仍然通顺——所以必须在这里拦。
   */
  const DETAIL_FIELDS = [
    [TOWN_FIELD, '区县'],
    ['severity', '火灾等级'],
    /* 起火原因的真名是 **fireCauseValue**，值是「一级/二级/三级」用斜杠连起来的路径，
       例如「生活用火不慎/油锅起火」「生产作业不当/烘烤/烘烤物距火源近」。
       **不是 fireCauseLvl1Name**——那个字段在真实报文里 42 行全是 null，
       而本文件上面那条校验只判"键在不在"（因为曾经把"未填"误判成"改版"、
       整份稿子出不来），所以键在、值为 null 的错字段名一路溜过：
       正文那句「起火原因主要为…」会永远退化成「正在调查中」。
       取一级分类用 causeOf()。 */
    ['fireCauseValue', '起火原因']
  ];

  /**
   * 起火原因的**一级分类选项**：设置页据此画勾选框。
   *
   * 平台没有字典接口，但筛选面板是**三级级联**（2026-11-15 截图确认）：
   * 一级 → 二级 → 三级，例如 `电气故障 → 短路`、`电气故障 → 电器设备引起条目 → 电器设备自身故障`。
   * 明细里 `fireCauseValue` 存的是完整路径串，所以正文只能按**一级**合并——
   * 子类有的两级、有的三级，只有一级能跨层级汇总。
   *
   * 这份名单有两个来源，都写清出处，不靠"常见值"猜：
   * ① 本期明细里真实出现过的（2026-11-01～11-09，170 条，2026-11-15 实测）：
   *    电气故障 65、生活用火不慎 40、吸烟 17、自燃 7、机械设备故障 5、
   *    遗留火种 3、外来火源 1、生产作业不当 1、玩火 1；
   * ② 平台筛选面板一级列上确证存在、但本期没有记录的（同日截图）：
   *    放火、静电、雷击、光源聚焦，以及三个"未查明"类。
   *
   * 顺序按本期起数降序，**三个"未查明"类排在最后**：它们不是原因，是"不知道原因"，
   * 与"未填"同义——默认不勾，正文归入「其余正在调查中」。
   */
  const CAUSE_OPTIONS = [
    '电气故障', '生活用火不慎', '吸烟', '自燃', '机械设备故障',
    '遗留火种', '外来火源', '生产作业不当', '玩火',
    '放火', '静电', '雷击', '光源聚焦',
    '不排除原因', '不明火灾原因', '其他火灾原因'
  ];

  /** 一级值里"未查明"的那三类：语义等于"没有原因"，不是一种原因 */
  const CAUSE_UNKNOWN = ['不排除原因', '不明火灾原因', '其他火灾原因'];

  /**
   * 勾选名单 → 数组。设置页存的是顿号分隔的串，人手工改配置时用逗号/空格也认。
   * 空串 = 一个都不点名（正文只写「其余正在调查中」）——不做"空就回退全部"的
   * 隐藏兜底，否则"取消勾选"会看起来毫无效果。
   */
  function causePickList(cfg) {
    const raw = String((cfg && cfg.causePick) || '').trim();
    if (!raw) return [];
    return raw.split(/[、,，;；\s]+/).map(s => s.trim()).filter(Boolean);
  }

  /**
   * 起火原因的一级分类：`生活用火不慎/油锅起火` → `生活用火不慎`。
   * 只切第一段——有些值有三层（`生产作业不当/烘烤/烘烤物距火源近`）。
   * 空值返回 null（countBy 会跳过），正文据此判"还有没查清的"。
   * 兜底读 fireCauseLvl1Name 只为兼容旧报文与旧测试桩，不是第二来源。
   */
  function causeOf(row) {
    if (!row) return null;
    let v = row.fireCauseValue;
    if (v === null || v === undefined || v === '') v = row.fireCauseLvl1Name;
    if (v === null || v === undefined || v === '') return null;
    const s = String(v).split('/')[0].trim();
    return s || null;
  }

  /** 等级字段的合法取值。出现别的值说明对方加了新等级，而我们的统计会漏算 */
  const SEVERITY_VALUES = ['非轻微火灾', '轻微火灾'];

  /** 有效标记：接口在明细里用 isNoDamage 表示"未有效"，取数时再兜一次 */
  const NO_DAMAGE_FIELD = 'isNoDamage';
  const NO_DAMAGE_YES = '1';

  /* ── 取数策略（不是契约，但同样只该有一处）──────────────── */
  const POLICY = {
    /** 5 分钟缓存：重复点击不重复打接口；设置变更时 clearCache 主动失效 */
    cacheTtl: 5 * 60 * 1000,
    /** 单页条数 */
    detailLimit: 500,
    /**
     * 单页 500 条在有效高峰日不够用：台风过境、春节期间一天有效上千起。
     * 只取第一页时，从明细派生的"一般及以上""中心城区""区域分布"会一起偏小，
     * 而报表那边的有效起数是对的——于是校验只亮一条黄提示，正文数字看着正常。
     * 翻页上限 10 页（5000 条）：一天的有效量到不了这个量级，到了基本可以断定
     * 接口没按页返回，继续翻只是空转。
     */
    detailMaxPages: 10,
    /**
     * 代理环境、网络切换时 fetch 可能一直不返回。没有超时，界面上就是永远转圈，
     * 使用者分不清是"在算"还是"死了"。20 秒足够慢网，也短到人能等。
     * 只用于明细、汇总、翻页这些轻请求；报表另有更长的预算，见 reportTimeout。
     */
    fetchTimeout: 20000,
    /**
     * 统计报告的超时，比别的重得多：一次要现算「今年以来」整年的聚合。
     *
     * 实测（2026-11-15 00:36–01:21，本机诊断日志，十次出稿 9 个请求、并发 3）：
     * 整轮 40.8 / 41.7 / 42.1 / 44.9 / 46.8 / 48.0 / 49.2 / 52.3 秒，
     * 其中 01:04:59 那一次有一条超过 60 秒被掐。F12 单条最慢 43.6 秒
     * （当日·全部段落），响应只有 58 KB——**慢与响应大小无关**。
     *
     * 也就是说整轮时长基本等于"最慢的那一条"。20 秒当上限是零余量（00:25 起
     * 连续四次 NET-TIMEOUT 都栽在这条）；60 秒的余量是 8～20 秒，够，但不宽裕。
     */
    reportTimeout: 60000,
    /** 失败重试前等多久（AUTH 不重试，超时不重试） */
    retryDelay: 400
  };

  Object.assign(HT, {
    ORIGIN, API, TIME_PARAMS, REPORT_QUERY, REPORT_NAMES, REPORT_SHAPE, REPORT_FIELDS, REPORT_COLS, FIRE_TYPES,
    DETAIL_BODY, DETAIL_WINDOW, DETAIL_SHAPE, DETAIL_KEYS, DETAIL_FIELDS,
    TOWN_FIELD, TOWN_OUT, townOf, townOut, causeOf, causePickList, CAUSE_OPTIONS, CAUSE_UNKNOWN,
    HEAD_QUERY, REPORT_CROSS, REPORT_CROSS_FIELDS, reportCrossBody,
    SEVERITY_VALUES, NO_DAMAGE_FIELD, NO_DAMAGE_YES, POLICY
  });
})(typeof window !== 'undefined' ? window : globalThis);
