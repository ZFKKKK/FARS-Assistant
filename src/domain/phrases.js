/**
 * src/domain/phrases.js —— 模板变量用的成品字符串（条件措辞的收口处）
 *
 * @layer  domain（领域层）
 * @file   src/domain/phrases.js
 * @since  0.13.0
 *
 * 模板只做替换，不做判断。可是公文里有一半句子是"看情况才这么写"的：
 *   有人数 / 无人数          → 四种措辞
 *   有中心城区 / 没有         → 整段括号消失
 *   有原因 / 全在调查中       → 引导语的冒号都跟着变
 *   去年为零 / 去年有数       → "无同比"与前缀方向词
 *   类型占比只列非零项        → 整句由数据决定长度
 * 这些判断如果留在模板里，模板就得有 if，编辑器也就没法做到"随便改文字"。
 * 所以判断全部提前到这一层，吐出一整串字符串，模板里只留一个 {{f:ph.x|raw}}。
 *
 * 命名空间统一挂在 ph. 下，不往 ytd / day / det 里掺：
 *   那几个是**原始事实**（起数、占比单位、分组明细），谁都可以拿来自己拼；
 *   ph. 是**已经排好版的中文**，只给模板消费，改了它就等于改公文措辞。
 *
 * 与 segments.js 的 AUTO 是两份独立实现：AUTO 是改造前的黄金基线，
 * 一行都不动；这里是从基线誊出来的变量化版本。两边输出必须逐字相同，
 * 模板等价性比对 每次都会比。改措辞要同时改两边，否则那脚本立刻变红。
 */
(function (g) {
  'use strict';
  const HT = (g.__HT = g.__HT || {});

  /* ── 人数：设置页只填数字，句子在这一层拼（1.8.0 用户定） ──────
     1.7.x 时这两句是"整句手填"，每期都得把「条目造成62人受伤，57人死亡。」
     敲一遍，数字敲错一个要等核稿才发现。现在拆开：
       · 数字 —— 设置页里六格（受伤 / 死亡 / 同比人数与幅度）；
       · 措辞 —— 下面这几句，也在默认模板里以 {{f:ph.casualty}} 的形式出现，
                 想换写法就把它换成「条目造成{{f:cas.hurt}}人受伤，…」。
     数字留空 = 这次照抄平台。不是"没填就报错"：平台那几个数在报表口径上与
     支队上报的对不上，所以它是兜底，不是首选。 */
  const numOf = (v, dft) => {
    const s = String(v == null ? '' : v).trim();
    if (!s) return dft;
    const n = Number(s);
    return Number.isFinite(n) ? n : dft;
  };

  /** 人数：设置页优先，空则用平台的。两个都取不到时按 0 算（宁可少写，不写「NaN人」）。 */
  function casNumbers(cfg, y) {
    const yy = y || {};
    const h = numOf(cfg && cfg.casHurt, yy.hurt);
    const d = numOf(cfg && cfg.casDead, yy.dead);
    return { hurt: Number.isFinite(h) ? h : 0, dead: Number.isFinite(d) ? d : 0 };
  }

  /**
   * 人数结句。四种组合仍是严格判等：伤 0 亡 2 与 伤 2 亡 0 是两句不同的话，
   * 按"有没有"分支写，比套一个填空模板更像人话。
   */
  function casSentence(cfg, y) {
    const c = casNumbers(cfg, y);
    return (c.hurt === 0 && c.dead === 0) ? '火灾未造成人员伤亡。'
      : c.hurt === 0 ? `火灾未造成人员受伤，造成${c.dead}人死亡。`
        : c.dead === 0 ? `火灾造成${c.hurt}人受伤，未造成人员死亡。`
          : `火灾造成${c.hurt}人受伤，${c.dead}人死亡。`;
  }

  /**
   * 「，伤人数同比减少3人（下降2.1%），亡人数同比增加1人」
   *
   * 方向只由设置页那个「增加 / 减少」按钮给，**不按数值符号判**——
   * 这里填的是人对着报表抄的数，不是接口那个"下降为正"的增减量
   * （那个的方向只写在 report 原文的字面里，按符号判必有一半月份写反）。
   * 人填的按按钮走，永远不会反。
   * 某一侧没填人数就整侧不出现；两侧都没填返回空串，让模板自然衔接。
   */
  function casYoySentence(cfg) {
    const c = cfg || {};
    const one = (who, dir, n, p) => {
      const num = String(n == null ? '' : n).trim();
      if (!num) return '';
      const up = dir !== 'down';
      let s = who + '人数同比' + (up ? '增加' : '减少') + num + '人';
      const pc = String(p == null ? '' : p).trim();
      if (pc) s += '（' + (up ? '上升' : '下降') + pc + '%）';
      return s;
    };
    const parts = [
      one('伤', c.yoyHurtDir, c.yoyHurtN, c.yoyHurtP),
      one('亡', c.yoyDeadDir, c.yoyDeadN, c.yoyDeadP)
    ].filter(Boolean);
    return parts.length ? '，' + parts.join('，') : '';
  }

  /**
   * 由事实对象算出全部成品字符串。
   * @param {object} c buildContext 已经填好的事实对象（本函数不改它，返回新对象）
   * @returns {object} ph 命名空间
   */
  function tplFacts(c) {
    const y = c.ytd, d = c.day, e = c.det, ty = c.ty, yo = c.yoy, cfg = c.cfg;

    /* ── 有效条目同比 ────────────────────────────────────
       分母是**去年年初至今**的有效累计，按同一窗口从平台查回来的（以 W.YTDL 取数）。
       不维护手工月度数：2025 年那一份是补录造成的特例，不为每年都建一张账。
       分母没取到（接口出错）就留空，正文退回「同比x」，不拿别的数顶。 */
    const lastCas = y.CLast;
    const casYoy = HT.casYoyWord(y.C, lastCas);

    /* ── 人数：设置页那两格数字优先（1.8.0），空则用平台的 ──
       平台 HZ_01 的人数人数是报表口径，与支队上报的对不上，所以配置优先；
       留空不是"没配"，而是"这次照抄平台"。四种组合仍严格判等。 */
    const casualty = casSentence(cfg, y);

    /* ── 条目类型占比：只列非零项，建构筑物带"其中居住场所" ──
       顺序即 TYPE_DEFS 顺序，不重排；零值项整句不出现。
       句读照报表原文（HZ_21 的 templateContent）：建构筑物那句后面一个「；」，
       其余五类之间全是「，」。以前六项一律用「；」，与报表页并排看会对不上。 */
    let typeSen = '';
    if (ty.sum) {
      let first = '';
      const rest = [];
      /* 居住场所的占比照抄 HZ_21[5]（分母与建构筑物同一个，见 report.js 取值处）。
         不再用 起数/有效 现算：两者只在六类加总恰好等于有效时才相等。 */
      const dwUnits = ty.dwellingUnits === null || ty.dwellingUnits === undefined
        ? 0 : ty.dwellingUnits;
      if (ty.nums[0] > 0) {
        first = `建构筑物火灾${ty.nums[0]}起，占${HT.fmtUnit(ty.units[0])}%，` +
          `其中居住场所${ty.dwelling}起，占火灾总数的${HT.fmtUnit(dwUnits)}%`;
      }
      for (let t = 1; t < HT.TYPE_DEFS.length; t++) {
        if (ty.nums[t] > 0) {
          rest.push(`${HT.TYPE_DEFS[t][0]}${ty.nums[t]}起，占${HT.fmtUnit(ty.units[t])}%`);
        }
      }
      typeSen = first
        ? first + (rest.length ? '；' + rest.join('，') : '')
        : rest.join('，');
    }

    /* ── 起火原因：勾选的列起数，未勾选与未填的一起归「其余正在调查中」 ──
       （2026-11-15 用户定）原来是一份硬编码黑名单（CAUSE_EXCLUDE），只能划掉、
       不能选入，而且系统里出现新类别时正文照样点名。现在改成白名单：
       `cfg.causePick` 勾了哪些就列哪些，其余全部并进句尾那句。

       「其余」的算法由此变了：以前是"未填"（明细条数 − 全部原因之和），
       现在是"未勾选 + 未填"（明细条数 − 勾选项之和）。两种都自洽，
       区别是读者看到的"其余"不再暗示"这些还在查"——勾掉的类别也在里面，
       所以句尾只写「其余正在调查中」、不带条数（用户同时定的）。 */
    const causePick = HT.causePickList(cfg);
    const causeShown = e.causeList.filter(x => causePick.indexOf(x.name) >= 0);
    const causeTop = causeShown.map(x => `${x.name}（${x.n}起）`).join('，');
    const causeRest = Math.max(0, (e.count || 0) - HT.sum(causeShown.map(x => x.n)));
    const pend = causeRest > 0 ? cfg.pendingTpl.replace('{n}', causeRest) : '';
    const causePart = causeTop
      ? `，${cfg.causeLead}${causeTop}` + (pend ? `，${pend}` : '')
      : `，${String(cfg.causeLead).replace(/[：:]\s*$/, '')}正在调查中`;

    /* 分布括号：有内容才有括号，没有就整段消失（连括号都不留） */
    /* 第三参把「区域用简称」这个设置传下去。以前所有调用点都没传，
       groupDesc 里 shortOn 恒为 undefined，那个开关形同虚设：
       关掉它，正文照样写「万州3起」。 */
    const shortOn = cfg.shortTown !== false;
    const wrapAll = list => (list && list.length ? `（${HT.groupDesc(list, 999, shortOn)}）` : '');

    return {
      /* 时间 */
      yoyYear: c.W.DAY.s.getFullYear() - 1,
      /* 段首那句的日期不在这里出：它是模板里的 {{f:W.DAY.e|...}} 标签，
         写法（11月11日 / 2026年11月11日 / 11/11）由标签本身决定。
         以前这里按 cfg.docDate 拼一个带逗号的串，实际上是"第二个地方决定同一件事"。
         取 DAY.e 而不是 DAY.s 的理由没变：那一段写的是**结算到的那一天**，
         DAY 窗口起点是前一天，用起点会写出「11月12日，全市…」，
         与「每日记录数据」开头的「截至11月13日18时」差一天。 */

      /* 今年以来 · 人数。
         只保留**人数**，同比整句撤掉：HZ_01 的 [7][8] 是"下降为正"的
         增减量，方向只写在 templateContent 的字面里，按符号判必有一半月份写反，
         反推的去年人数会跟着差一倍。用户明确不要这句，dDead/dHurt 也不再取。 */
      casualty,
      /* 方向从报表 templateContent 里读（见 segments.js 的 dirOf）：
         HZ_01 的 values 只有幅度，没有方向列，按符号猜会把上升写下降。 */
      /* 人数同比：四个数字由设置页给，方向由那个「增加 / 减少」按钮给。
         这句接在人数结句后面，所以自带前导逗号；两侧都没填时返回空串，
         模板里「有效条目同比x。」照样读得通。 */
      casYoyX: casYoySentence(cfg),
      /* 有效条目同比：今年 YTD 有效比**去年 YTD 有效**，两个数都按同一窗口
         从平台实查（后者见 report.js 的 ytdLast 数据源）。
         分母取不到时退回「同比x」，出稿人自己填——宁缺毋滥。 */
      yoyCSen: casYoy ? '同比' + casYoy : HT.CAS_FIRE_YOY_TEXT,
      /* 去年同期累计的起数：模板想写「（去年同期 N 起）」时用这个 */
      lastCas: lastCas == null ? '' : String(lastCas),
      yoyCabs: y.yoyC === null ? '' : Math.abs(y.yoyC).toFixed(2),
      pctN: HT.pct(y.N, y.F),

      /* 当日明细 · 分布 */
      coreTownDesc: e.nCore ? `（${HT.groupDesc(e.coreTownList, 5, shortOn)}）` : '',
      townLeadDesc: e.count ? `，${HT.groupDesc(e.townList, 5, shortOn)}` : '',
      causePart,
      majorDesc: wrapAll(e.majorList),
      coreMajorDesc: wrapAll(e.coreMajorList),
      coreMinorDesc: wrapAll(e.coreMinorList),

      /* 条目类型整句 */
      typeSeg: typeSen ? `，经初步核查火灾类型占比情况：${typeSen}` : ''
    };
  }

  /** 把 ph.* 合并进事实对象，供 valueOf(c, 'ph.xxx') 取到 */
  function attachPhrases(c) {
    c.ph = tplFacts(c);
    return c;
  }

  Object.assign(HT, {
    tplFacts, attachPhrases, casNumbers, casSentence, casYoySentence
  });
})(typeof window !== 'undefined' ? window : globalThis);
