/**
 * src/domain/segments.js —— 自动成文库 + 由模板生成段落
 *
 * @layer  domain（领域层）
 * @file   src/domain/segments.js
 * @since  5.0.0
 *
 * 两个职责，都在这一层，不要外溢：
 *   1. AUTO —— 四套"整段公文成文"逻辑（brief/day/detail/ytd）。
 *      它们是模板里 `{t:'auto'}` 块的实现，也是默认模板的唯一内容。
 *      这些措辞是有条件的（只列非零项、零值另给口径、分类加总严格 100%），
 *      所以留成代码而不是纯字段拼接；用户想自定义，把它拆成字段块即可。
 *   2. buildSegments(cfg, group) —— 把**一个片段组**的原子模板组装成
 *      本次要出的段落：{i, key, title, needs, render(c)}，report.js 只认这个结果。
 *      一轮出稿由 report 按文稿方案接起若干组，每组各调一次。
 *
 * 段落顺序口径（0.8 起）：按"从当日到年度"递减——记录 → 每日一句 → 全市条目 → 全年累计。
 * 组内顺序在设置页可调，组之间的顺序由方案决定，这里不再写死。
 */
(function (g) {
  'use strict';
  const HT = (g.__HT = g.__HT || {});

  /* 条目类型：顺序即行文顺序，不要重排。
     每一项 = [业务名, 起数列, 占比列]。列位置来自 data/contract.js 的 FIRE_TYPES——
     站点调整列序时改那张表，这里与 phrases.js 都不用动。
     保持 [label, count, share] 这个三元组形状，是因为 phrases.js 按 [0] 取名字、
     report.js 按解构取列号；改变形状要同步动两个文件，不划算。 */
  const TYPE_DEFS = HT.FIRE_TYPES.map(t => [t.label, t.count, t.share]);

  /* 固定用语（0.17）：这两个兜底常量以前是 DEFAULT_CFG 的 unitName /
     sensitiveLine 两个配置项，用户在设置里能看到、在模板里能插成变量。
     现在它们只是模板正文里的几个字，改称谓 = 改那几个字。
     这里保留一份常量，是因为 AUTO 还要给历史 {{seg:xxx}} 标签出文：
     老配置里自定义过称谓的，历史段仍按老样子渲染，不因为这次改版换称谓。 */
  const UNIT_NAME = '全市消防救援队伍';
  const SENSITIVE = '市委、市政府等敏感单位周边今日未发生火灾事故。';

  /**
   * 变化率 → 公文措辞。v 是"今年相对去年的变化率"，正=上升、负=下降。
   *
   * 两个边界不能按算式写，虽然算式没错：
   *   今年归零（v = -100）→ 写"下降100.00%"。读起来像"降了，但还剩一点"，
   *     实际是今年没有；而且前一句已经说了"减少5人"，再说一遍百分比是重复。
   *     公文里这种情形写"今年未发生"。
   *   持平（v = 0）→ 写"持平"，不写"上升0.00%"。
   *
   * 判断用 0.005 而不是 === 0：v 是浮点数，(0-5)/5*100 恰好是 -100，
   * 但别的分母会算出 -99.99999999，肉眼是 -100，程序里不等。
   */
  function yoyWord(v) {
    if (Math.abs(v) < 0.005) return '持平';
    if (v <= -99.995) return '今年未发生';
    return (v >= 0 ? '上升' : '下降') + Math.abs(v).toFixed(2) + '%';
  }

  /**
   * 从报表正文模板里读同比方向。
   *
   * 为什么不能按数值正负判：HZ_01 的 templateContent 是
   *   "……同比去年，条目起数下降X%，死亡人数增加X人……"
   * 方向写在**字面文本**里，values 里只有那个数字。而接口的历史口径是
   * "下降为正"——也就是说数值符号与方向无关：上升的月份 values 里仍是正数。
   * 0.17 之前用 `yoyC > 0 ? '下降' : '上升'` 猜，遇上升月份必定写反。
   * JQ_01 有独立的方向列（[5]），HZ_01 没有，所以只能读原文。
   *
   * @param {string} content 报表的 templateContent
   * @param {string} key     方向词前面的锚点，如 "条目起数"
   * @returns {string} '上升' | '下降' | '增长' | '减少' | ''（读不到）
   */
  function dirOf(content, key) {
    const s = String(content || '');
    if (!s || !key) return '';
    const i = s.indexOf(key);
    if (i < 0) return '';
    const m = /(上升|下降|增长|减少)/.exec(s.slice(i + key.length, i + key.length + 16));
    return m ? m[1] : '';
  }

  /**
   * 方向 + 幅度 → "下降4.89%"。方向由 dirOf 从原文读出，读不到才按
   * 历史口径（下降为正）退回 yoyWord。
   * @param {number|null} v   幅度（正数，不带符号）
   * @param {string} dir      方向词
   */
  function yoyDirWord(v, dir) {
    const n = Number(v);
    if (!Number.isFinite(n)) return '';
    const d = String(dir || '');
    if (Math.abs(n) < 0.005) return '持平';
    /* 幅度到 100% 且原文写的是"下降"：今年没有，公文里写"今年未发生" */
    if (n >= 99.995 && /下降|减少/.test(d)) return '今年未发生';
    if (/上升|增长/.test(d)) return '上升' + n.toFixed(2) + '%';
    if (/下降|减少/.test(d)) return '下降' + n.toFixed(2) + '%';
    return yoyWord(-n);
  }

  /**
   * 接口原样给出的"方向 + 数值"两列 → "下降2.1%"。
   *
   * 严格按原文拼（不重算、不补零）：接口写的是 2.1 就写 2.1，改成 2.10
   * 会与平台上看到的数不一致。任一列取不到就返回空串——绝不让裸的 "%"
   * 落进正文（"记录起数%"这种句子出现过）。
   */
  function yoyPlain(dir, val) {
    const d = String(dir == null ? '' : dir).trim();
    const v = String(val == null ? '' : val).trim();
    /* 两列缺一不可：只有数值没有方向，写出来是"记录起数2.1%"这种残缺句；
       只有方向没有数值，是"记录起数下降%"。缺了就整句空着，让人一眼看出没取到。 */
    if (!d || !/^[-+]?\d+(\.\d+)?$/.test(v)) return '';
    return d + v + '%';
  }

  /*
   * 删除 yoyPeople / chgText：
   *   这两个函数把接口给的"同比增减"当成**有符号数**（delta > 0 → 增加）。
   *   但 HZ_01 的 [7][8] 是"下降为正"的绝对值，方向只写在 templateContent
   *   的字面里（"死亡人数增加X人"），所以减少的月份一定写成增加、反推的去年
   *   人数也跟着差一倍。正文已不再出现人数同比，两个函数再留着就是陷阱。
   *
   *   真有哪天要恢复这句，顺序是：
   *     ① HT.dirOf(hz01B.content, '死亡人数') 拿方向词
   *     ② 把增减量乘上方向变成有符号数
   *     ③ 再套 yoyWord（它只处理幅度边界，不碰方向）
   *   不要直接相减。
   */

  /**
   * 四套自动成文。键与 config.AUTO_KEYS 必须一致（verify 会查）。
   * needs 是"这段话用到了哪些数据源"，模板里插了 auto 块就自动并入取数计划。
   */
  const AUTO = {
    brief: {
      label: '每日警情数据',
      desc: '累计接处警、五类占比、伤亡人数 + 当日处置与中心城区（两段）',
      needs: ['ytdA', 'ytdB', 'ytdLast', 'dayA', 'dayB', 'detD'],   // ytdLast 只给句尾那句有效同比当分母
      render(c) {
        const y = c.ytd, d = c.day, e = c.det;

        /* 人数结句：与 phrases.js 的 casSentence 同一套规矩——数字取设置页那两格、
           空则用平台的，措辞四种组合严格判等。两处渲染必须同源，
           否则同一段话在 AUTO 与模板两条路上会写出两个版本（模板等价性比对 每次会比）。 */
        const casualty = HT.casSentence(c.cfg, y);

        /* 人数同比整句：同样与 phrases.js 同源，方向来自设置页那个按钮。 */

        const p1 =
          `警情信息：截至${HT.cnDay(c.W.DAY.e)}${c.anchorText}，${c.cfg.unitName || UNIT_NAME}共接处警${y.T}起` +
          `（其中火灾扑救${y.F}起，占比${HT.fmtUnit(y.uF)}%，其中成灾火灾${y.C}起，占比${HT.fmtUnit(y.uC)}%，` +
          `无损火警${y.N}起，占比${HT.fmtUnit(y.uN)}%；抢险救援${y.Q}起，占比${HT.fmtUnit(y.uQ)}%，` +
          `社会救助及其他${y.O}起，占比${HT.fmtUnit(y.uO)}%），${casualty}` +
          `同比${c.W.DAY.s.getFullYear() - 1}年，警情起数${y.yoyQ}，` +
          `成灾火灾${c.ph.yoyCSen}${HT.casYoySentence(c.cfg)}。`;

        const core = e.nCore
          ? `（${HT.groupDesc(e.coreTownList, 5, c.cfg.shortTown !== false)}）` : '';
        const p2 =
          `${c.dayRange}，队伍共处置警情${d.T}起` +
          `（火灾扑救${d.F}起，其中成灾火灾${d.C}起，无损火灾${d.N}起）。` +
          `中心城区共发生成灾火灾${e.nCore}起${core}。`;

        return p1 + '\n' + p2;
      }
    },

    day: {
      label: '每日一句',
      desc: '当日成灾火灾起数、区县分布、起火原因',
      needs: ['dayB', 'detD'],
      render(c) {
        const d = c.day, e = c.det;
        /* 与 phrases.js 的 causePart 逐字一致：只列 `cfg.causePick` 勾选的类别，
           未勾选与未填的一起归句尾「其余正在调查中」。两处曾经一处列全、一处只取前
           两项，同一个「每日一句」在两套渲染下写出两句话——这类分叉最难发现，
           所以过滤与拼法必须同源。 */
        const pick = HT.causePickList(c.cfg);
        const shown = e.causeList.filter(x => pick.indexOf(x.name) >= 0);
        const causeTop = shown.map(x => `${x.name}（${x.n}起）`).join('，');
        const rest = Math.max(0, (e.count || 0) - HT.sum(shown.map(x => x.n)));
        const pend = rest > 0 ? c.cfg.pendingTpl.replace('{n}', rest) : '';

        return `${c.dayRange}，全市共发生成灾火灾${d.C}起` +
          (e.count ? `，${HT.groupDesc(e.townList, 5, c.cfg.shortTown !== false)}` : '') +
          (causeTop
            ? `，${c.cfg.causeLead}${causeTop}` + (pend ? `，${pend}` : '')
            : `，${String(c.cfg.causeLead).replace(/[：:]\s*$/, '')}正在调查中`) +
          `。`;
      }
    },

    detail: {
      label: '全市火灾情况',
      desc: '火灾类型占比、出动与同比、等级拆分、中心城区、敏感单位',
      needs: ['dayA', 'dayB', 'detD', 'detL', 'dayHf', 'lastHf'],
      render(c) {
        const d = c.day, e = c.det, ty = c.ty, y = c.yoy;

        /* 类型占比：只列非零项；建构筑物带"其中居住场所" */
        let typeSen = '';
        if (ty.sum) {
          const parts = [];
          const dwUnits = ty.dwellingUnits === null || ty.dwellingUnits === undefined
            ? 0 : ty.dwellingUnits;
          if (ty.nums[0] > 0) {
            parts.push(`建构筑物火灾${ty.nums[0]}起，占${HT.fmtUnit(ty.units[0])}%，` +
              `其中居住场所${ty.dwelling}起，占火灾总数的${HT.fmtUnit(dwUnits)}%`);
          }
          for (let t = 1; t < TYPE_DEFS.length; t++) {
            if (ty.nums[t] > 0) {
              parts.push(`${TYPE_DEFS[t][0]}${ty.nums[t]}起，占${HT.fmtUnit(ty.units[t])}%`);
            }
          }
          typeSen = parts.join('；');
        }

        /* 正文日期必须与默认模板逐字相同，否则同一份稿子走两条路径会出两种日期。
           模板那边是 `{{f:W.DAY.e|cnFullDay}}` →「2026年11月12日」，这里就得同步。
           以前这里是 cnDay（「11月12日」）：2026-11-16 用户要求开头带年份时只改了模板，
           这条老标签路径漏了——`模板等价性比对` 的基线比对把它照了出来。 */
        /* 取结算日（DAY.e），不是窗口起点（DAY.s） */
        const lead = HT.cnFullDay(c.W.DAY.e);
        const head = lead ? `${lead}，` : '';

        const s = [];
        s.push(`${head}全市共发生成灾火灾${d.C}起`);
        if (typeSen) s.push(`，经初步核查火灾类型占比情况：${typeSen}`);
        /* 缺 CD_01 时 curTruck / curPerson 是 null（不是 0）：模板那边渲染成「—」，
           这里必须同一种呈现，否则两张写法会分叉（模板等价性比对 逐字比对）。 */
        const nz = v => (v === null || v === undefined ? '—' : v);
        /* 这个同比的口径是**全市总条目**（2026-11-16 定）：与默认模板同一句、同一个字段。
           以前这里是处置同比（车次 ÷ 去年同日车次），统计报告里没有这个数。 */
        s.push(`。出动消防车${nz(y.curTruck)}辆次、消防指战员${nz(y.curPerson)}人次，与去年同比${y.dCyoyAllTxt}。`);
        s.push(`其中一般及以上等级火灾${e.nMajor}起` +
          (e.nMajor ? `（${HT.groupDesc(e.majorList, 999, c.cfg.shortTown !== false)}）` : '') +
          `，轻微火灾${e.nMinor}起` +
          (e.nMinor && e.minorListOk
            ? `（${HT.groupDesc(e.minorList, 999, c.cfg.shortTown !== false)}）` : '') + `。`);
        s.push(`中心城区共发生成灾火灾${e.nCore}起，与去年同比${y.coreYoyTxt}，` +
          `其中一般及以上等级火灾${e.nCoreMajor}起` +
          (e.nCoreMajor ? `（${HT.groupDesc(e.coreMajorList, 999, c.cfg.shortTown !== false)}）` : '') +
          `，轻微火灾${e.nCoreMinor}起` +
          (e.nCoreMinor ? `（${HT.groupDesc(e.coreMinorList, 999, c.cfg.shortTown !== false)}）` : '') + `。`);
        s.push(c.cfg.sensitiveLine || SENSITIVE);
        s.push(c.cfg.tailNote || '');
        return s.join('');
      }
    },

    ytd: {
      label: '每日主官数据',
      desc: '今年以来五类警情占比、出动车辆与人次、无损火警占比',
      needs: ['ytdA', 'ytdB'],
      render(c) {
        const y = c.ytd;
        return `今年以来，${c.cfg.unitName || UNIT_NAME}共接处警${y.T}起【其中火灾扑救${y.F}起，占比${HT.fmtUnit(y.uF)}%；` +
          `抢险救援${y.Q}起，占比${HT.fmtUnit(y.uQ)}%；社会救助${y.S}起，占比${HT.fmtUnit(y.uS)}%；` +
          `安保勤务${y.A}起，占比${HT.fmtUnit(y.uA)}%；虚假警${y.X}起，占比${HT.fmtUnit(y.uX)}%】。` +
          `接处警起数${y.yoyQ}，共出动车辆${y.truckTotal}辆次，出动${y.personTotal}人次。` +
          `无损火警${y.N}起，占火灾扑救的比例为${HT.pct(y.N, y.F)}%。`;
      }
    }
  };

  /**
   * 模板 → 本次要出的段落。顺序、标题、正文全部来自 cfg.templates，
   * 这里只负责：把正文里的占位符交给 template.js 渲染、把 needs 汇总去重。
   * @param {object} cfg normalizeCfg 之后的配置
   */
  /**
   * 这一轮的模板从哪来（1.13.0 两层结构）。
   *
   *   原子模板 → 文稿组合
   *
   * 出稿时由 report 按 pick 取**一个组合**，组合直接交出一串模板。
   * 组合自带周期，它决定这些段按哪个窗口取数。
   *
   * ref 允许四种写法，都是为了兼容旧调用：
   *   · 组合对象          —— report 传进来的，正常路径
   *   · 组合 id            —— 设置页预览、按 id 取
   *   · 'day' / 'week'    —— 旧调用（verify 与几处老代码），取该周期选中的那个
   *   · 省略              —— 取 cfg.period 那个周期选中的那个
   */
  function comboRef(cfg, ref) {
    if (ref && typeof ref === 'object') return ref;
    if (typeof ref === 'string' && ref && ref !== 'day' && ref !== 'week') {
      /* 按 id 找要经过 combosAll：cfg.combos 里存的只有 ids（1.14.0），
         直接翻 raw 拿到的那份没有 tpls，buildSegments 会静默退到出厂模板——
         表现是"按 id 取组合，出来的却是默认那四段"。 */
      const all = (cfg && HT.combosAll) ? HT.combosAll(cfg) : [];
      const byId = all.filter(c => c.id === ref)[0];
      if (byId) return byId;
    }
    if (cfg && HT.comboOf) return HT.comboOf(cfg, (ref === 'week' || ref === 'day') ? ref : undefined);
    const cs = (cfg && Array.isArray(cfg.combos) && cfg.combos.length) ? cfg.combos : [];
    const p = (ref === 'week' || ref === 'day') ? ref
      : (cfg && cfg.period === 'week' ? 'week' : 'day');
    return cs.filter(c => c.period === p)[0] || cs[0] || null;
  }

  /** 取这个组合的模板列表。组合认不出来时退回出厂模板，至少不会是空稿。
   *
   *  「组合对象」有两种：解析过的（带 `tpls`）与存储里的 raw（只有 `ids`）。
   *  raw 那份以前会掉进下面那条兜底，**静默换成出厂模板**——周报接两段却出来
   *  日的四段，页面上没有任何异常（2026-11-27 用户报的就是这个：标题栏切到周，
   *  段落与设置里的周组合对不上）。所以这里补一条：有 ids 就现从库里拼。
   *  兜底只在"真的没有组合信息"时才走。 */
  function tplListOf(cfg, ref) {
    const c = comboRef(cfg, ref);
    if (c && Array.isArray(c.tpls)) return c.tpls;
    if (c && Array.isArray(c.ids) && HT.comboTpls) {
      const got = HT.comboTpls(cfg, c);
      if (Array.isArray(got) && got.length) return got;
    }
    if (!cfg) return HT.DEFAULT_TEMPLATES || [];
    const week = ref === 'week' || (!ref && cfg.period === 'week');
    return (week ? HT.DEFAULT_WEEK_TEMPLATES : HT.DEFAULT_TEMPLATES) || [];
  }

  function buildSegments(cfg, ref) {
    const tpls = tplListOf(cfg, ref);
    return tpls.filter(t => t.on !== false).map((t, i) => {
      const text = String(t.text == null ? '' : t.text);
      return {
        i,
        key: t.id,
        label: t.title,
        needs: HT.needs(text),
        render(c) {
          return HT.render(text, c);
        }
      };
    });
  }

  Object.assign(HT, {
    AUTO, TYPE_DEFS, yoyWord,
    dirOf, yoyDirWord, yoyPlain,
    tplListOf, comboRef, groupOf: comboRef, buildSegments
  });
})(typeof window !== 'undefined' ? window : globalThis);
