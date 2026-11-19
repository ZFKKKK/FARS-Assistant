/**
 * src/domain/render.js —— 字段取值与占位符渲染：把事实对象变成文字片段
 *
 * @layer  domain（业务规则）
 * @since  0.22.0（0.21.0 及以前是 fields.js / template.js 两个文件）
 *
 * 为什么合成一个：两者是同一件事的两端——fields 定义"有哪些字段、每种写法
 * 怎么呈现"，template 负责找出正文里的 {{f:key|mode}} 并交给 fields 渲染。
 * 改一个字段的呈现方式，两个文件都要看；分开时最常犯的错是改了 fields、
 * 忘了 template 里那个兼容分支。
 *
 * 组内顺序：fields → template。template 顶层不读 fields 的常量（都在函数体内
 * 现取 HT.FIELD_INDEX），所以这个顺序只是为了让读者先看见"有什么字段"。
 */

/**
 * src/domain/fields.js —— 可插入模板的数据字段目录（唯一来源）
 *
 * @layer  domain（领域层）
 * @file   原 src/domain/fields.js（0.22.0 并入 render.js）
 * @since  0.9.0
 *
 * 模板由「文本 + 数据」拼成，这个文件就是"数据"那半边的清单：
 * 每一项 = 一个能从事实对象 c（report.js 的 buildContext）里取到的值，
 * 外加它能怎么呈现（写法）。
 *
 * 层级是：大类（c）→ 小类（g）→ 字段（k）→ 写法（modes）。
 *   大类 = 写稿时"我想说什么"（时间 / 记录 / 条目 / 分布 / 类型 / 处置 / 同比），
 *          点一下就插该类默认项（CATS[].def），不必先在三层下拉里挑。
 *   小类 = 同一件事的几面（今年以来 vs 当日；起数 vs 占比 vs 整句）。
 *   写法 = 同一个数的几种呈现（纯数字 / 数字带单位 / 整句）。
 *
 * 一条铁律：**能取到数才叫字段**。写死的固定用语（单位称谓、敏感单位结句、
 * 结尾补充句）不是字段——它们在模板里就是纯文本，想改就改那几行字。
 * 0.17 把这三条从目录里删掉了：一个永远只是一个值的"变量"，
 * 除了多一步点击之外没有任何用处。
 *
 * 每条都带 needs：某个字段被插进模板，取数计划才会包含它依赖的数据源。
 * needs 写漏的症状很隐蔽——不报错，只是那个数一直是「—」。
 */
(function (g) {
  'use strict';
  const HT = (g.__HT = g.__HT || {});

  /** 写法：四级结构的最后一层 */
  const MODES = {
    num: { k: 'num', label: '数字' },
    numUnit: { k: 'numUnit', label: '数字+单位' },
    raw: { k: 'raw', label: '原文' },
    cnDay: { k: 'cnDay', label: '11月11日' },
    cnFullDay: { k: 'cnFullDay', label: '2026年11月11日' },
    md: { k: 'md', label: '11/11' },
    listCity: { k: 'listCity', label: '全部区县' },
    listCity5: { k: 'listCity5', label: '前5个区县' },
    listNames: { k: 'listNames', label: '只列名' },
    /* 时间：一种写法一个 mode。以前这三种写法是三条独立字段，标签里得写着
       「本期窗口（公文：11月11日18时至…）」，而且「数据」菜单里也能选到——
       同一段时间两个入口、两份清单，想改写法等于换一个字段。 */
    rangeFull: { k: 'rangeFull', label: '公文写法' },
    rangeDay: { k: 'rangeDay', label: '只日期' },
    rangeShort: { k: 'rangeShort', label: '短写法' },
    pointCn: { k: 'pointCn', label: '18时' },
    pointClock: { k: 'pointClock', label: '18:00:00' },
    pointCnFull: { k: 'pointCnFull', label: '18时00分00秒' }
  };

  const N = (k, label, needs, unit) => ({ k, label, needs, kind: 'num', unit: unit || '' });
  const U = (k, label, needs) => ({ k, label, needs, kind: 'unit' });
  const T = (k, label, needs) => ({ k, label, needs, kind: 'text' });
  /* 时间字段：一个字段 + 几种写法。src 就是"哪种写法取哪一个成品串"——
     window.js 早把三种写法都算好了，这里只是把它们挂到 mode 上。
     模板里存 {{f:anchor|pointCn}}，换写法只换 mode，字段不变。 */
  const TW = (k, label, src) => ({ k, label, needs: [], kind: 'text', src });
  const L = (k, label, needs) => ({ k, label, needs, kind: 'list' });
  const D = (k, label) => ({ k, label, needs: [], kind: 'date' });
  /* B 是"成品句"：值已经是排好版的中文，可能整句消失（空串），
     所以空值输出空串而不是破折号——破折号会把标点顶出一个孤零零的「—」。
     成品句不单独成类：它们各自归到语义所属的小类里（人数结句在「人员人数」、
     区域整句在「区域」），写稿的人按"我要说哪件事"找，而不是按"这是不是整句"找。 */
  const B = (k, label, needs) => ({ k, label, needs, kind: 'blank' });

  /**
   * 大类 = 插入菜单的第一级，也是唯一一级：点一下直接插入 def 那个默认项，
   * 插进来之后再点正文里的标签，才展开该类的小类与全部字段。
   *
   * 为什么大类要少（七个而不是二十个）：这一级是"我现在想插句话，
   * 缺的是哪一类东西"。七个正好一屏，不用滚动，也不用再记二级页签。
   * def 必须是该类里最常用的那个——点错了能改，点对了省三步。
   */
  const CATS = [
    { c: 'time', label: '时间', hint: '时段 · 截点 · 日期', def: 'dayRange|rangeFull' },
    { c: 'alarm', label: '警情', hint: '接处警总量与五类拆分', def: 'ytd.T|num' },
    { c: 'fire', label: '火灾', hint: '成灾 · 无损 · 伤亡 · 等级', def: 'ytd.C|num' },
    { c: 'dist', label: '分布', hint: '区县 · 中心城区 · 起火原因', def: 'det.townList|listCity5' },
    { c: 'type', label: '类型', hint: '六类火灾与占比', def: 'ph.typeSeg|raw' },
    { c: 'force', label: '出动', hint: '消防车 · 指战员', def: 'yoy.curTruck|num' },
    { c: 'yoy', label: '同比', hint: '变化幅度与整句措辞', def: 'ph.yoyCSen|raw' }
  ];

  const GROUPS = [
    /* ══ 时间 ══ */
    {
      c: 'time', g: '统计时段',
      items: [
        TW('dayRange', '本期时段', {
          rangeFull: 'dayRange', rangeDay: 'dayRangeDay', rangeShort: 'dayRangeShort'
        }),
        TW('lastRange', '去年同期时段', { rangeFull: 'lastRange' })
      ]
    },
    {
      c: 'time', g: '基准时间',
      items: [
        TW('anchor', '基准时间', {
          pointCn: 'anchorText', pointClock: 'anchorClock', pointCnFull: 'anchorCnFull'
        })
      ]
    },
    {
      c: 'time', g: '日期',
      items: [
        D('W.DAY.s', '本期开始日期'),
        D('W.DAY.e', '本期结束日期'),
        D('W.LAST.s', '去年同期日期')
      ]
    },

    /* ══ 记录：接处警总量与五类拆分 ══ */
    {
      c: 'alarm', g: '今年以来',
      items: [
        N('ytd.T', '接处警总数', ['ytdA'], '起'),
        N('ytd.F', '其中火灾扑救', ['ytdA'], '起'),
        N('ytd.Q', '抢险救援', ['ytdA'], '起'),
        N('ytd.S', '社会救助', ['ytdA'], '起'),
        N('ytd.A', '安保勤务', ['ytdA'], '起'),
        N('ytd.X', '虚假警', ['ytdA'], '起'),
        N('ytd.O', '社会救助及其他', ['ytdA'], '起')
      ]
    },
    {
      c: 'alarm', g: '今年以来占比',
      items: [
        U('ytd.uF', '火灾扑救占比', ['ytdA']),
        U('ytd.uQ', '抢险救援占比', ['ytdA']),
        U('ytd.uS', '社会救助占比', ['ytdA']),
        U('ytd.uA', '安保勤务占比', ['ytdA']),
        U('ytd.uX', '虚假警占比', ['ytdA']),
        U('ytd.uO', '社会救助及其他占比', ['ytdA'])
      ]
    },
    {
      c: 'alarm', g: '当日',
      items: [
        N('day.T', '当日接处警', ['dayA'], '起'),
        N('day.F', '当日火灾扑救', ['dayA'], '起'),
        N('day.C', '当日成灾火灾', ['dayB'], '起'),
        N('day.N', '当日无损火灾', ['dayB'], '起')
      ]
    },

    /* ══ 条目：有效、无损、人数、等级 ══ */
    {
      c: 'fire', g: '成灾与无损',
      items: [
        N('ytd.C', '今年以来成灾火灾', ['ytdA', 'ytdB'], '起'),
        N('ytd.N', '今年以来无损火警', ['ytdA', 'ytdB'], '起'),
        U('ytd.uC', '成灾火灾占比', ['ytdA', 'ytdB']),
        U('ytd.uN', '无损火警占比', ['ytdA', 'ytdB']),
        B('ph.pctN', '无损火警占火灾扑救比例', ['ytdA', 'ytdB'])
      ]
    },
    {
      c: 'fire', g: '人员伤亡',
      items: [
        /* 这两个数是**最终值**：设置页填了就用设置页的，没填才用平台的。
           想自己写人数那句（而不是领 ph.casualty 那四种现成措辞），
           用这两个标签拼：「条目造成{{f:cas.hurt}}人受伤，{{f:cas.dead}}人死亡。」 */
        N('cas.hurt', '受伤人数（设置页优先）', ['ytdB'], '人'),
        N('cas.dead', '死亡人数（设置页优先）', ['ytdB'], '人'),
        N('ytd.dead', '亡人数（平台原值）', ['ytdB'], '人'),
        N('ytd.hurt', '伤人数（平台原值）', ['ytdB'], '人'),
        /* 四种组合（无人数 / 只亡 / 只伤 / 都伤）在 phrases.js 判好，
           模板这里拿到的就是一整句成品话，不带破折号、不用管标点 */
        B('ph.casualty', '伤亡结句', ['ytdB'])
      ]
    },
    {
      c: 'fire', g: '火灾等级',
      items: [
        N('det.nMajor', '一般及以上等级', ['detD'], '起'),
        N('det.nMinor', '轻微火灾', ['detD'], '起'),
        L('det.majorList', '一般及以上分布', ['detD']),
        B('ph.majorDesc', '一般及以上分布（含括号）', ['detD'])
      ]
    },

    /* ══ 分布：区域、中心城区、起火原因 ══ */
    {
      c: 'dist', g: '区县',
      items: [
        L('det.townList', '区县分布', ['detD']),
        N('det.count', '成灾明细条数', ['detD'], '条'),
        N('det.townSum', '区县加总', ['detD'], '起'),
        B('ph.townLeadDesc', '区县分布（含前导逗号）', ['detD'])
      ]
    },
    {
      c: 'dist', g: '中心城区',
      items: [
        N('det.nCore', '中心城区成灾火灾', ['detD'], '起'),
        L('det.coreTownList', '中心城区分布', ['detD']),
        N('det.nCoreMajor', '中心城区一般及以上', ['detD'], '起'),
        N('det.nCoreMinor', '中心城区轻微火灾', ['detD'], '起'),
        L('det.coreMajorList', '中心城区一般及以上分布', ['detD']),
        L('det.coreMinorList', '中心城区轻微分布', ['detD']),
        B('ph.coreTownDesc', '中心城区分布（含括号）', ['detD']),
        B('ph.coreMajorDesc', '中心城区一般及以上（含括号）', ['detD']),
        B('ph.coreMinorDesc', '中心城区轻微（含括号）', ['detD'])
      ]
    },
    {
      c: 'dist', g: '起火原因',
      items: [
        L('det.causeList', '起火原因分布', ['detD']),
        N('det.causeSum', '已查明原因', ['detD'], '起'),
        N('det.caused', '待查原因', ['detD'], '起'),
        B('ph.causePart', '起火原因整句', ['detD'])
      ]
    },

    /* ══ 类型：六类条目 ══ */
    {
      c: 'type', g: '六类起数',
      items: [
        N('ty.sum', '六类加总', ['dayB'], '起'),
        N('ty.dwelling', '其中居住场所', ['dayB'], '起'),
        N('ty.nums.0', '建构筑物', ['dayB'], '起'),
        N('ty.nums.1', '室外设施设备', ['dayB'], '起'),
        N('ty.nums.2', '露天场所', ['dayB'], '起'),
        N('ty.nums.3', '户外植被', ['dayB'], '起'),
        N('ty.nums.4', '交通工具', ['dayB'], '起'),
        N('ty.nums.5', '垃圾及废弃物', ['dayB'], '起')
      ]
    },
    {
      c: 'type', g: '六类占比',
      items: [
        U('ty.units.0', '建构筑物占比', ['dayB']),
        U('ty.units.1', '室外设施设备占比', ['dayB']),
        U('ty.units.2', '露天场所占比', ['dayB']),
        U('ty.units.3', '户外植被占比', ['dayB']),
        U('ty.units.4', '交通工具占比', ['dayB']),
        U('ty.units.5', '垃圾及废弃物占比', ['dayB'])
      ]
    },
    {
      c: 'type', g: '整句',
      items: [
        /* 只列非零项、建构筑物带"其中居住场所"、全零整句消失——
           这些判断在 phrases.js，模板拿到的是排好版的整句 */
        B('ph.typeSeg', '火灾类型占比整句', ['dayB'])
      ]
    },

    /* ══ 处置：业务车与指战员 ══ */
    {
      c: 'force', g: '当日出动',
      items: [
        /* 处置统一取综合查询（记录查询）那一行：dayHf = 当日·一类，
           lastHf = 去年同日·一类。报表 CD_01 只作兜底，不再声明为来源——
           声明了就会去取那 9 段，而正文已经不用它。 */
        N('yoy.curTruck', '出动消防车辆', ['dayHf'], '辆次'),
        N('yoy.curPerson', '出动指战员', ['dayHf'], '人次'),
        N('yoy.lastTruck', '去年同期出动车辆', ['lastHf'], '辆次')
      ]
    },
    {
      c: 'force', g: '今年以来',
      items: [
        T('ytd.truckTotal', '今年以来出动车辆', ['ytdA']),
        T('ytd.personTotal', '今年以来出动人次', ['ytdA'])
      ]
    },

    /* ══ 同比：变化幅度与措辞 ══
       单列一类，是因为公文里"同比"常常自成一句，而且它的边界措辞
       （持平 / 今年未发生 / 去年为零无同比）需要整句成品，不属于单纯取数。 */
    {
      c: 'yoy', g: '警情同比',
      items: [
        T('ytd.yoyQ', '接处警同比（原文）', ['ytdA']),
        N('ph.yoyYear', '去年年份', [])
      ]
    },
    {
      c: 'yoy', g: '成灾同比',
      items: [
        /* 一句里带方向、幅度和边界，模板不该自己拼"方向 + 幅度 + %"——
           拼出来的"下降100.00%"在清零时是病句 */
        /* ytdLast：去年年初至今的有效数，只给这句当分母。
           写在字段层而不是"取了有效就顺手取"——模板删掉这句话时，
           那一个请求就不该发出去。 */
        B('ph.yoyCSen', '成灾火灾同比整句', ['ytdB', 'ytdLast']),
        /* 当日窗口那一份（2026-11-15）。「全市条目情况」里那个百分比原先错用了
           **处置**同比，可统计报告的条目段只有"条目起数下降X%"，没有处置同比。
           现在这一段取报表同一句：幅度 HZ_01[6]、方向读 templateContent。 */
        B('yoy.dCyoyTxt', '当日起数同比措辞（成灾口径）', ['dayB']),
        /* 「全市条目情况」里处置后面那个同比，口径是**全市总条目**
           （2026-11-16 用户裁定），取 dayA 的 HZ_01[6]。与上面有效口径的
           dCyoyTxt 不是一个数，两个都留着。 */
        B('yoy.dCyoyAllTxt', '当日全部火灾起数同比措辞', ['dayA']),
        T('yoy.dCyoyDir', '当日起数同比方向', ['dayB']),
        /* 人数同比整句：设置页四个数字 + 那个「增加 / 减少」按钮，拼成
           「，伤人数同比减少3人（下降2.1%），亡人数同比增加1人」。
           放在字段目录里是为了能在「插入」里找到它、也为了它跟模板同一个来源。 */
        B('ph.casYoyX', '伤亡同比整句（设置页填数）', ['ytdB']),
        B('ph.yoyCabs', '同比幅度（两位小数）', ['ytdB']),
        T('ytd.yoyCdir', '同比方向', ['ytdB']),
        N('ytd.yoyC', '同比幅度（原文，下降为正）', ['ytdB'], '%')
      ]
    },
    {
      c: 'yoy', g: '出动同比',
      items: [
        T('yoy.truckYoyTxt', '出动同比措辞', ['dayHf', 'lastHf']),
        T('yoy.coreYoyTxt', '中心城区同比措辞', ['detD', 'detL']),
        N('yoy.lCoreN', '去年同期中心城区成灾', ['detL'], '起')
      ]
    }
  ];

  /** 扁平索引：k → 字段定义 */
  const INDEX = Object.create(null);
  GROUPS.forEach(grp => grp.items.forEach(f => {
    f.group = grp.g;
    f.cat = grp.c;
    INDEX[f.k] = f;
  }));

  /**
   * 呈现方式清单。数字默认给「纯数字 / 数字+单位」两种；
   * 文本、日期、列表各按自己的语义给两三种，避免下拉里出现一堆没意义的选择。
   */
  function modesOf(k) {
    const f = INDEX[k];
    if (!f) return [];
    /* 时间字段自己带写法清单（src 的键就是 mode） */
    if (f.src) return Object.keys(f.src).map(m => MODES[m]).filter(Boolean);
    switch (f.kind) {
      case 'num':
      case 'unit':
        return f.unit || f.kind === 'unit'
          ? [MODES.num, MODES.numUnit] : [MODES.num];
      case 'date':
        return [MODES.cnDay, MODES.cnFullDay, MODES.md];
      case 'list':
        return [MODES.listCity, MODES.listCity5, MODES.listNames];
      default:
        return [MODES.raw];
    }
  }

  /** 取任意深度的值：'ty.nums.0' 这种也认 */
  function valueOf(c, k) {
    const seg = String(k || '').split('.');
    let v = c;
    for (let i = 0; i < seg.length; i++) {
      if (v == null) return null;
      v = v[seg[i]];
    }
    return v == null ? null : v;
  }

  /**
   * 缺值时的占位。**不用「—」**：破折号在公文里既可能是"没有这一项"，
   * 也可能是人写的时候留下的待填标记，稿子发出去以后没人分得清这一处
   * 是取数失败、还是模板写错了字段名。
   *
   * 换成把"缺的是哪一项"写在自己身上的占位：它自解释，能一眼看出该去补什么；
   * 也便于事后全文搜「未取到」，一次找出所有没填上的位置。
   */
  const miss = f => '〔未取到：' + ((f && f.label) || '该项') + '〕';

  function fmtNum(f, v) {
    if (v === null || v === undefined || v === '') return miss(f);
    if (typeof v === 'number') {
      /* 占比以 0.01% 为单位存（1090 = 10.90%），呈现前换算 */
      return f.kind === 'unit' ? HT.fmtUnit(v) : String(v);
    }
    return String(v);
  }

  function fmtList(c, f, mode) {
    const list = valueOf(c, f.k);
    if (!Array.isArray(list) || !list.length) return miss(f);
    const cut = mode === 'listCity5' ? list.slice(0, 5) : list;
    /* 与 groupDesc 用同一个开关。以前这里是裸的 x.name（恒用全称），
       而成品句走简称，于是同一段正文里「甲区13起」和「甲区1起」并存——
       写的人以为设置没生效，实际是两条路径各读各的。 */
    const shortOn = !(c && c.cfg && c.cfg.shortTown === false);
    const txt = cut.map(x => {
      const name = HT.shortTown(x.name, shortOn);
      return mode === 'listNames' ? name : `${name}${x.n}起`;
    }).join('、');
    return (mode === 'listCity5' && list.length > 5) ? txt + '等' : txt;
  }

  /**
   * 渲染一个字段块。
   * @param {object} c    事实对象
   * @param {string} k    字段键
   * @param {string} v    呈现方式
   */
  function renderField(c, k, v) {
    const f = INDEX[k];
    if (!f) return '';
    const mode = v || 'num';
    if (f.kind === 'list') return fmtList(c, f, mode);
    /* 时间：写法 → 成品串。window.js 里那几种写法都算好了，这里只做转接。 */
    if (f.src) {
      const key = f.src[mode] || f.src[Object.keys(f.src)[0]];
      const tv = valueOf(c, key);
      return tv == null ? miss(f) : String(tv);
    }
    const raw = valueOf(c, k);
    /* 成品句允许为空，空就是空——这里插入的是句子里的一个小片段，
       给"破折号"会变成"中心城区共发生有效条目5起—。" */
    if (f.kind === 'blank') return raw == null ? '' : String(raw);
    if (f.kind === 'date') {
      const d = raw;
      if (!(d instanceof Date)) return miss(f);
      if (mode === 'cnFullDay') return HT.cnFullDay(d);
      if (mode === 'md') return HT.pad(d.getMonth() + 1) + '/' + HT.pad(d.getDate());
      return HT.cnDay(d);
    }
    if (f.kind === 'text') return raw == null ? miss(f) : String(raw);
    const base = fmtNum(f, raw);
    if (mode === 'numUnit') {
      const unit = f.kind === 'unit' ? '%' : (f.unit || '');
      return base + unit;
    }
    return base;
  }

  /**
   * 老字段键 → 新字段键 + 写法。0.14 把「同一段时间的三种写法」从三条字段收成
   * 一个字段的三个 mode，旧模板里必然留着旧键。改键不改写法的话，
   * prune 会在下次保存时把这些占位符当成"字段不存在"整段删掉——用户会少半句话。
   * 迁移只换键、不改字：值仍然是原来那串文字。
   */
  const FIELD_ALIAS = {
    dayRange: { k: 'dayRange', mode: 'rangeFull' },
    dayRangeDay: { k: 'dayRange', mode: 'rangeDay' },
    dayRangeShort: { k: 'dayRange', mode: 'rangeShort' },
    lastRange: { k: 'lastRange', mode: 'rangeFull' },
    anchorText: { k: 'anchor', mode: 'pointCn' },
    anchorClock: { k: 'anchor', mode: 'pointClock' },
    anchorCnFull: { k: 'anchor', mode: 'pointCnFull' }
  };

  /**
   * 已经撤掉的字段：键 → 一句话死因（+ 现在该用什么）。
   *
   * 老模板里会留着这些占位符，保存时被 prune 清掉，然后弹一句"清掉 1 个失效项"。
   * 只报"清掉了"等于让人自己去猜"是不是我写错了"——所以这里给出原因，
   * 设置页把它拼进提示里。撤字段时必须同时在这一张表里留一行。
   */
  const RETIRED = {
    'ph.yoyCasSen': '伤亡同比整句已经撤掉了——报表给的增减量不带方向，'
      + '按符号判会把"减少"写成"增加"。要这句请用「伤亡同比（X 待手填）」',
    'day.C2': '这个字段已经合并进 day.C（成灾起数）',
    'ph.yoyC': '成灾火灾同比整句已改成 yoyCSen（数字留 x 手填）'
  };

  /** 某个大类下的组（只画自己那一类的，数据里不会出现时间） */
  function groupsOf(c) {
    return GROUPS.filter(grp => grp.c === c);
  }

  /** 某个字段属于哪个大类 */
  function catOf(k) {
    const f = INDEX[k];
    return f ? f.cat : (CATS[0] ? CATS[0].c : '');
  }

  /**
   * 某大类的默认插入项：点大类卡片直接插它。
   * def 里写的是 "键|写法"；写法不存在时退回该字段的第一种写法，
   * 免得改目录时漏改 def，插进去一个渲染成「—」的空标签。
   */
  function defaultOf(cat) {
    const x = CATS.find(y => y.c === cat);
    if (!x) return null;
    const bar = String(x.def || '').indexOf('|');
    const k = bar < 0 ? String(x.def || '') : x.def.slice(0, bar);
    const want = bar < 0 ? '' : x.def.slice(bar + 1);
    const f = INDEX[k];
    if (!f) return null;
    const modes = modesOf(k).map(m => m.k);
    return { k, mode: modes.indexOf(want) >= 0 ? want : (modes[0] || 'raw') };
  }

  /** 某个字段声明的数据源依赖 */
  function needsOfField(k) {
    const f = INDEX[k];
    return f ? f.needs.slice() : [];
  }

  Object.assign(HT, {
    FIELD_GROUPS: GROUPS, FIELD_INDEX: INDEX, FIELD_MODES: MODES, FIELD_ALIAS, RETIRED,
    INS_CATS: CATS, modesOf, renderField, needsOfField, valueOf, groupsOf, catOf, defaultOf
  });
})(typeof window !== 'undefined' ? window : globalThis);

/**
 * src/domain/template.js —— 模板正文：占位符的解析、渲染、依赖汇总与清理
 *
 * @layer  domain（领域层）
 * @file   原 src/domain/template.js（0.22.0 并入 render.js）
 * @since  0.9.0
 *
 * 0.10 起模板不再是"块的列表"，而是**一段自由文本**，文本里可以插入占位符：
 *
 *   {{seg:brief}}            整段成文（segments.js 的 AUTO）
 *   {{f:day.C|numUnit}}      一个数据字段 + 呈现方式（fields.js）
 *
 * 为什么换成这种：块的模型逼着人"先想结构再写字"，而实际写法是反过来的——
 * 先有句子，句子中间缺个数，把数填进去。占位符就是"句子里的空"，
 * 位置、前后的标点、要不要加"其中"，全部由写的人决定。
 * 于是"起火原因引导语""待查后缀""固定结尾句"这些半成品开关全部不需要了：
 * 想改那句话，直接改那句话。
 *
 * 解析与渲染都在这一层：config.js 只保证 text 是字符串（数据层不认识字段目录），
 * 面板与设置页都调这里的同一份实现，所以"设置里看到什么"和"生成出什么"不会分叉。
 */
(function (g) {
  'use strict';
  const HT = (g.__HT = g.__HT || {});

  /** 占位符：{{类型:内容}}。类型只有 seg / f 两种，别的原样留着 */
  const TOK_RE = /\{\{([a-z]+):([^}]*)\}\}/g;

  /** 一个模板正文最长多少字——够写三段公文，又不至于让存储里塞进一篇文章 */
  const MAX_LEN = 4000;

  /** 整段成文的下拉项 */
  function autoOptions() {
    const A = HT.AUTO || {};
    return Object.keys(A).map(k => ({ k, label: A[k].label, desc: A[k].desc || '' }));
  }

  const modeLabel = k => {
    const m = (HT.FIELD_MODES || {})[k];
    return m ? m.label : k;
  };

  /** 把一个占位符拆成结构化描述；不认识的返回 null */
  function parseTok(body) {
    const s = String(body || '');
    const i = s.indexOf(':');
    if (i < 0) return null;
    const kind = s.slice(0, i);
    const rest = s.slice(i + 1);
    if (kind === 'seg') {
      const A = (HT.AUTO || {})[rest];
      return A ? { k: 'seg', key: rest, label: A.label } : null;
    }
    if (kind === 'f') {
      const bar = rest.indexOf('|');
      const key = bar < 0 ? rest : rest.slice(0, bar);
      const f = (HT.FIELD_INDEX || {})[key];
      if (!f) return null;
      let mode = bar < 0 ? '' : rest.slice(bar + 1);
      const modes = (HT.modesOf ? HT.modesOf(key) : []).map(m => m.k);
      if (modes.indexOf(mode) < 0) mode = modes[0] || 'num';
      return { k: 'f', key, mode, label: f.label, modeLabel: modeLabel(mode) };
    }
    return null;
  }

  /** 占位符在正文里的样子（raw 存储形态），编辑器序列化时用 */
  function tokRaw(t) {
    if (!t) return '';
    if (t.k === 'seg') return '{{seg:' + t.key + '}}';
    return '{{f:' + t.key + '|' + (t.mode || 'num') + '}}';
  }

  /** 切分成片段：{t:'text',s} / {t:'seg',...} / {t:'f',...}；坏占位符当普通文字 */
  function parse(text) {
    const out = [];
    const src = String(text == null ? '' : text);
    let last = 0;
    src.replace(TOK_RE, (m, kind, body, off) => {
      if (off > last) out.push({ t: 'text', s: src.slice(last, off) });
      const tok = parseTok(kind + ':' + body);
      // t 与 k 同时给：t 是"这是哪种片段"（text/seg/f），k 是"哪种占位符"。
      // 少了 t 会让 needs / summary / prune 全部认不出来（曾经就是这么瞎的）。
      if (tok) out.push({ t: tok.k, k: tok.k, key: tok.key, mode: tok.mode,
                          label: tok.label, modeLabel: tok.modeLabel });
      else out.push({ t: 'text', s: m, bad: true });   // 不认识的占位符原样留着，别静默吃掉
      last = off + m.length;
      return m;
    });
    if (last < src.length) out.push({ t: 'text', s: src.slice(last) });
    return out;
  }

  /** 渲染成文 */
  function render(text, c) {
    return parse(text).map(p => {
      if (p.t === 'text') return p.s;
      if (p.t === 'seg') {
        const A = (HT.AUTO || {})[p.key];
        return A ? A.render(c) : '';
      }
      return HT.renderField ? HT.renderField(c, p.key, p.mode) : '';
    }).join('');
  }

  /** 这段文本要用到哪些数据源（取数计划靠它，写漏不报错只是取不到数） */
  function needs(text) {
    const out = [];
    const add = list => (list || []).forEach(k => { if (out.indexOf(k) < 0) out.push(k); });
    parse(text).forEach(p => {
      if (p.t === 'seg') {
        const A = (HT.AUTO || {})[p.key];
        if (A) add(A.needs);
      } else if (p.t === 'f') {
        add(HT.needsOfField ? HT.needsOfField(p.key) : []);
      }
    });
    return out;
  }

  /** 一句话摘要：模板列表里那一行 */
  function summary(text) {
    const ps = parse(text);
    let nF = 0, nSeg = 0;
    ps.forEach(p => {
      if (p.bad) return;
      if (p.t === 'f') nF++;
      else if (p.t === 'seg') nSeg++;
    });
    /* 只报"这段里插了几个变量"。字数不算了（0.19.0）：
       模板是给人改、给机器读的，写的人关心的是"数齐了没有"，
       一旁不停跳动的字数只会让人以为它在限制什么。 */
    const parts = [];
    if (nSeg) parts.push(nSeg + ' 段成文');
    if (nF) parts.push(nF + ' 个数据');
    return parts.length ? parts.join(' · ') : '空模板';
  }

  /**
   * 保存前清理：去掉已失效的占位符（字段被删、成文键被改），保留文字。
   * 失效项**整段删除**而不是留个坏 token——留着的话生成时会蹦出 `{{f:xxx}}`，
   * 那比少一句话更难看。返回 {text, dropped}，设置页据此提示"清掉 n 个失效项"。
   *
   * 这里不再二次 slice(0, MAX_LEN)：调用方（settings.js 的 collect）已经
   * 在保存前用 tooLong 挡下超长段落，再剪一刀只会把占位符剪成 "{{f" 这种
   * 认不出的半截文字，然后原样进正文。长度上限只留一处判断。
   */
  function prune(text) {
    let dropped = 0;
    const gone = [];
    const out = parse(text).map(p => {
      if (p.bad) { dropped++; gone.push(String(p.s || '').slice(0, 40)); return ''; }
      if (p.t === 'text') return p.s;
      if (p.t === 'seg' && !(HT.AUTO || {})[p.key]) { dropped++; gone.push('seg:' + p.key); return ''; }
      if (p.t === 'f' && !(HT.FIELD_INDEX || {})[p.key]) { dropped++; gone.push(p.key); return ''; }
      return tokRaw(p);
    }).join('');
    /* gone 里是被删掉的那些键：只报"清掉 3 个"的话，用户不知道少的是哪半句话，
       也不知道该去哪一段找。设置页会把段标题和这几个键一起说出来。 */
    return { text: out, dropped, gone };
  }

  /**
   * 编辑器显示用的短标签（chip 上的字）。
   *
   * 只有"存在第二种写法"时才补后缀。默认四段里有二十来个标签，
   * 若每个都挂着「· 数字」「· 原文」，一段正文读起来像串了杂音——
   * 而那两个词只是说"这里是个数""这里是一句排好版的话"，
   * 正文本身已经说明这件事了。真正在选的是时间（11月11日 / 2026年11月11日 /
   * 11/11）和列表（全部 / 最多5个 / 只列名），那些地方才需要后缀。
   */
  function chipLabel(t) {
    if (!t) return '';
    if (t.k === 'seg') return '整段 · ' + t.label;
    const modes = (HT.modesOf ? HT.modesOf(t.key) : []).map(m => m.k);
    const isDefault = !modes.length || modes[0] === t.mode;
    return t.label + (!isDefault && t.modeLabel ? ' · ' + t.modeLabel : '');
  }

  Object.assign(HT, {
    TPL_MAX: MAX_LEN, autoOptions, parseTok, tokRaw, parse, render, needs,
    summary, prune, chipLabel, modeLabel
  });
})(typeof window !== 'undefined' ? window : globalThis);
