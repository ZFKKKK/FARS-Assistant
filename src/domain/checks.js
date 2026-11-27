/**
 * src/domain/checks.js —— 校验：结构体检 + 数字互校
 *
 * @layer  domain（业务规则）
 * @since  0.22.0（0.21.0 及以前是 data/schema.js 与 domain/checks.js 两个文件）
 *
 * 为什么合成一个：两个文件回答的是同一个问题——"这批数据能不能拿来写稿"。
 * schema 判形状对不对（少列、空表、未登录、返回不是列表），checks 判数字自不
 * 自洽（占比合计、明细与合计、同比基准）。面板只显示一组结果，人不会关心哪条
 * 是形状错、哪条是算术错。分开的代价是改一条判据要先想"该放哪个文件"。
 *
 * schema 原本在 data 层，因为它只读契约、只抛错、不发请求。并进来之后它依然
 * 不碰 DOM、不联网，分层守卫对 domain/ 的那两条仍然管着它。
 *
 * 组内顺序：schema（形状）→ checks（算术）。checks 用 schema 判过的结果继续算。
 */

/**
 * src/data/schema.js —— 数据源结构契约与体检
 *
 * @layer  domain（0.22.0 起并入，原在 data 层）
 * @file   原 src/data/schema.js（0.22.0 并入 checks.js）
 * @since  0.15.0
 *
 * 为什么需要这一层：
 *   接口返回的是一段模板里 comma 分隔的字符串，代码按**下标**取值（values[2]）。
 *   平台一旦改版——删一列、加一列、改 templateCode——取值不会报错，只会取到
 *   undefined，而 num() 把非法值兜成 0，于是生成一份"共接处警 0 起"的文稿。
 *   这比抛错危险得多：错得看不出来，使用者照着上报。
 *
 * 所以取数返回后先体检，体检不过一律当"结构变更"处理，宁可不出稿。
 *
 * 契约尺度（重要）：
 *   只校验**能确凿判定**的三件事——段落还在不在、列数够不够、关键计数列能不能解析。
 *   至于"新增一列导致原有列整体后移"，从下标这一侧无法识别（列数会变多，看着合法），
 *   这类只能靠 domain/checks.js 的自洽校验兜底（有效 ≤ 总起数、分类加总 = 合计）。
 *   这个局限必须写在这里，免得后来人以为有了体检就万无一失。
 */
(function (g) {
  'use strict';
  const HT = (g.__HT = g.__HT || {});

  /* 报表列契约（templateCode → label/min/count）已搬到 data/contract.js：
     站点改版时列下标要跟着变，那份文件是唯一该动的地方。 */
  const REPORT_CONTRACT = HT.REPORT_FIELDS;

  /** 严格取数：解析不成就返回 null（num() 兜 0，这里不能兜） */
  function numOrNull(v) {
    if (v === null || v === undefined) return null;
    const s = String(v).replace(/[,\s%]/g, '');
    if (s === '') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * 体检一份报表映射（fetchReport 的返回值）。
   *
   * want 分两级，因为"缺一段就整份不出"太粗暴：
   *   required  少了这个数就没法出稿的重点段 → 阻断
   *   optional  只影响某一句的旁支段 → 不阻断，但必须显式记下来给用户看
   * 两级都不允许静默——optional 的缺口一样要在面板上说出来。
   *
   * @param {object} map          templateCode → {values:[]}
   * @param {string[]|{required:string[],optional:string[]}} want
   * @param {string} srcLabel     数据源名称（"当日 · 条目统计"），用于报错定位
   * @returns {{ok:boolean, missing:string[], notices:string[], detail:string}}
   */
  function checkReport(map, want, srcLabel) {
    const req = Array.isArray(want) ? want : ((want && want.required) || []);
    const opt = Array.isArray(want) ? [] : ((want && want.optional) || []);
    const missing = [];
    const notices = [];
    const short = [];
    const bad = [];

    /* 旁支段单独过一遍：缺了只记 notice */
    opt.forEach(code => {
      const c = REPORT_CONTRACT[code];
      const p = map && map[code];
      if (!p) {
        notices.push(`${c ? c.label : code} 本次没有返回，相关句子会缺`);
        return;
      }
      const vals = p.values || [];
      if (c && vals.length < c.min) {
        notices.push(`${c.label} 列数由 ${c.min} 减为 ${vals.length}，相关句子可能缺`);
      }
    });

    req.forEach(code => {
      const c = REPORT_CONTRACT[code];
      const p = map && map[code];
      if (!p) { missing.push(code); return; }
      const vals = p.values || [];
      /* 列数不够：末尾被删，或整段换成了另一种报表 */
      if (c && vals.length < c.min) {
        short.push({ code, need: c.min, got: vals.length, label: c.label });
        return;
      }
      /* 关键计数列解析不出数字：可能被换成了文本列，或分隔符改了 */
      (c ? c.count : []).forEach(i => {
        if (numOrNull(vals[i]) === null) bad.push({ code, i, raw: vals[i] });
      });
    });

    const ok = !missing.length && !short.length && !bad.length;
    let detail = '';
    if (!ok) {
      const parts = [];
      if (missing.length) {
        parts.push(`缺少段落 ${missing.map(c => c + (REPORT_CONTRACT[c] ? `（${REPORT_CONTRACT[c].label}）` : ''))
          .join('、')}`);
      }
      if (short.length) {
        parts.push(short.map(s => `${s.code} 列数 ${s.got}，至少需 ${s.need}`).join('；'));
      }
      if (bad.length) {
        parts.push(bad.map(b => `${b.code} 第 ${b.i + 1} 列取不到数字`).join('；'));
      }
      /* 只拼事实：数据源前缀由 HT.err(..., {source}) 统一加，
         这里再拼一遍会让红框里出现「当日 · 条目统计：当日 · 条目统计：…」 */
      detail = parts.join('；');
    }
    return { ok: !missing.length && !short.length && !bad.length, missing, notices, short, bad, detail };
  }

  /**
   * 体检不通过就抛 SCHEMA。
   * 用 SCHEMA 而不是 DATA：DATA 意味着"数有了但不对劲"（可重试、可核对），
   * SCHEMA 意味着"这一版接口不是我们认识的那个"，重试无用，必须改代码。
   */
  function assertReport(map, want, srcLabel) {
    const r = checkReport(map, want, srcLabel);
    if (r.ok) return r;
    const e = HT.err('SCHEMA', r.detail, { source: srcLabel });
    e.check = r;
    throw e;
  }

  /* 明细必填字段与等级取值同样在 data/contract.js——那边是「站点说了什么」，
     这边只负责「对不上就报」。 */
  const DETAIL_FIELDS = HT.DETAIL_FIELDS;
  const SEVERITY_VALUES = HT.SEVERITY_VALUES;

  function assertDetail(list, srcLabel) {
    if (!Array.isArray(list)) {
      throw HT.err('SCHEMA', '返回的不是列表', { source: srcLabel });
    }
    if (!list.length) return true;          // 空列表是合法结果（当日无有效）

    /* 判「键在不在」，不判「值空不空」——这两件事的处置正好相反。
       上一版这里把 undefined 与 null 一视同仁，只要有 1 条为空就抛 SCHEMA：
       某天 500 条里有 17 条起火原因未填，整份文稿直接不出，提示「接口已改版，
       请手工取数上报」。而它并不需要改代码：
         · 字段改名 → **每一条**都没有这个键
         · 数据未填 → 键在、值为 null/空串
       下游本来就算得对（phrases.js 的 caused = detailCount - causeSum，
       正文照常写「其余正在调查中」），只有这一处把「未填」升级成了「改版」。
       所以只有「一条都没有这个键」才阻断；部分缺键记一笔本机日志，不打断出稿。 */
    DETAIL_FIELDS.forEach(([key, name]) => {
      const absent = list.filter(x => !x || !(key in x)).length;
      if (absent === list.length) {
        throw HT.err('SCHEMA',
          `${list.length} 条明细都没有${name}字段（${key}），接口可能已改版`, { source: srcLabel });
      }
      /* 键在、但整批值都是空——两种可能：真的没填，或者**字段名写错**（写成了另一个
         同样存在、恒为 null 的字段）。后者不报错、不缺段，只会让正文悄悄退化
         （起火原因那句永远写"正在调查中"）。判不出来就不要判，留一条本机日志即可：
         这类问题靠"看起来正常"是发现不了的，只能靠有人去翻日志。 */
      const blank = list.filter(x => x && (key in x) &&
        (x[key] === null || x[key] === undefined || x[key] === '')).length;
      if (blank === list.length && HT.obs && HT.obs.note) {
        HT.obs.note({ code: 'DET-EMPTY', mod: 'checks', fact: key });
      }
      if (absent) {
        /* 不是改名，是接口对这批数据少给了字段。断不了案，但值得留痕。 */
        try {
          if (HT.obs && HT.obs.note) {
            HT.obs.note({ code: 'DET-PARTIAL', mod: 'checks', fact: key });
          }
        } catch (e) { }
      }
    });
    /* 等级字段在、但取值不是我们认识的那两个：同样按结构变更处理，
       否则所有条目都会被算成轻微条目，"一般及以上"永远是 0。
       值为空的记录不在此列——那不是"不认识的值"，是没填，由 det.sevblank 提示。 */
    const unknown = list.filter(x => {
      const v = x && x.severity;
      /* 空值走 det.sevblank（可出稿、只提示），不在这里当"改版"。
         String(null) 会得到 "null"，那是个合法字符串，会一路蒙混过关。 */
      if (v === null || v === undefined || v === '') return false;
      return SEVERITY_VALUES.indexOf(String(v)) < 0;
    });
    if (unknown.length) {
      throw HT.err('SCHEMA',
        `${unknown.length} 条明细的等级值无法识别（${String(unknown[0].severity)}），接口可能已改版`,
        { source: srcLabel });
    }
    return true;
  }

  /**
   * 页面是否就绪。
   * 与登录态分开判：没 token 是"没登录"，有 token 但文档还在加载是"页面没好"，
   * 两者对用户的处置完全不同（前者刷新重登，后者等两秒）。
   */
  function pageState() {
    const li = HT.loginInfo ? HT.loginInfo() : { ready: true, hasToken: true, onLoginPage: false };
    let state = 'ok';
    if (!li.hasToken) state = li.onLoginPage ? 'login' : 'notoken';
    else if (li.onLoginPage) state = 'login';
    else {
      try {
        if (g.document && g.document.readyState === 'loading') state = 'loading';
      } catch (e) { }
    }
    return { state, ready: state === 'ok' };
  }

  Object.assign(HT, {
    REPORT_CONTRACT, numOrNull, checkReport, assertReport, assertDetail, pageState
  });
})(typeof window !== 'undefined' ? window : globalThis);

/**
 * src/domain/checks.js —— 交叉校验
 *
 * @layer  domain（0.22.0 起并入，原在 data 层）
 * @file   原 src/domain/checks.js（0.22.0 并入 checks.js）
 * @since  0.5.0
 *
 * 只做一件事：拿事实对象算"数据自洽吗"，不拼句子。
 * 三级结果：ok 通过 / bad 必须查（不可用） / warn 提示（可用但要留意）。
 * 校验项随选中的段落增减——没取的数据不参与核对，避免假红。
 *
 * 每条都带一个 **稳定的 key**（如 `ytd.sum`、`det.core`）。key 是面板与 FAQ
 * 之间的契约：说明文案统一放在 src/data/faq.js 的 CHECK_DOCS 里，按 key 索引，
 * 校验规则改了只改这一个文件，解释不会跟着漂。verify 会检查两边是否对齐。
 */
(function (g) {
  'use strict';
  const HT = (g.__HT = g.__HT || {});

  /**
   * @param {object} c      buildContext 产出的事实对象
   * @param {object} need   本次实际取过的数据源（键存在即已取）
   * @returns {Array<{key:string, name:string, ok:boolean, detail:string,
   *                  level:'ok'|'bad'|'warn'}>}
   */
  /**
   * 造一条校验项。
   *
   * 提到模块级是为了让**出稿后才回填的那条**（报表口径互校）用同一套语义：
   * note 一律 ok:true、不计入待核；level 缺省由 ok 推。
   * key 必须写成字面量——交付前自检靠这个函数名加引号的形式，把校验项和问答词条对齐。
   */
  function ckOf(out) {
    return (key, name, ok, detail, level) => {
      const lv = level || (ok ? 'ok' : 'bad');
      out.push({
        key, name, ok: lv === 'note' ? true : !!ok, detail: detail || '',
        level: lv, note: lv === 'note'
      });
    };
  }

  function buildChecks(c, need) {
    const out = [];
    /* 第四态 note（附注）：陈述一个口径事实，不是要人处理的问题。
       「待填报」这类事每期都有——若每次亮黄，黄的就不再等于"异常"，
       而且连带把摘要改成「N 项待核」、默认展开、在复制出的正文末尾挂一条
       「校验提示」。所以 note 一律 ok:true，不参与判定，也不进「仅问题」。 */
    const ck = ckOf(out);

    const y = c.ytd, d = c.day, e = c.det, ty = c.ty;
    const u = HT.fmtUnit;
    const has = v => v !== null && v !== undefined;

    /* 这一栏只列**需要人看一眼**的事。三类东西不再进来：
         ① 恒等式 —— 「无损 = 火扑 − 有效」这种由减法定义的项永远成立，
            校验它只是给自检凑条数；
         ② 已知口径差 —— 明细与报表差几起、六类交叉归类加总不等、
            两套账的一类差几十起，都是系统本身的样子，不是错；
         ③ 平台给的百分比 —— 占比原样照抄，它自己的四舍五入不归我们管。
       留下来的每一条都**能在真出问题时变红**，红得有意义。 */

    if (need.ytdA && y.T !== null) {
      /* 五类加总 = **同一张表**的总数。
         跨表（汇总 ↔ 接处警报表）那几十起的差是两套账，不在这里报——
         报了只会天天黄。这里判的是「有没有哪一类读错了」：同一个来源里
         五个数加不回自己的总数，只可能是字段认错。 */
      const five = [y.F, y.Q, y.S, y.A, y.X];
      const sum5 = five.some(v => !has(v)) ? null : five.reduce((a, b) => a + b, 0);
      const usingHead = has(y.Th);
      const ownT = usingHead ? y.T : y.JT;
      ck('ytd.sum', '五类警情之和等于总数',
        sum5 !== null && has(ownT) && sum5 === ownT,
        sum5 === null ? '五类中有数值未取到，无法核对'
          : !has(ownT) ? '警情总数未取到'
            : `五类合计 ${sum5}，${usingHead ? '汇总' : '报表'}总数 ${ownT}`
              + (sum5 === ownT ? '' : `（差 ${sum5 - ownT}）`));

      /* 正文的记录数吃的是「汇总」还是「报表」——这件事决定稿子与页面能不能对上。
         认到几项、差多少起都摆出来；只有「差得离谱」才是红（那说明字段认错了，
         拿的是别的同名字段）。 */
      const hd = y.head;
      if (hd) {
        /* 只拿**正文真正依赖的 8 项**判生死：总数、一类、其余四类、
           处置车辆与人次。同比与队次不进这张表：前者取不到就退回报表的，
           后者正文从不引用，缺了不影响任何一个字。 */
        const CORE = ['T', 'F', 'Q', 'S', 'A', 'X', 'truck', 'person'];
        const missAll = hd.miss || [];
        const miss = missAll.filter(k => CORE.indexOf(k) >= 0);
        const gotCore = CORE.filter(k => missAll.indexOf(k) < 0).length;
        const CORE_NAME = { T: '警情总数', F: '火灾扑救', Q: '抢险救援', S: '社会救助及其他',
          A: '安保勤务', X: '虚假警', truck: '出动车辆', person: '出动人次' };
        /* 差额要用**汇总原样给的总数**（rawT）来算，不能用 y.Th：
           Th 是「过了 0.5% 过滤才算数」的那个值，差得越远越会被过滤成 null，
           于是「差几百上千起」永远算不出来，红灯也就永远亮不起来。 */
        const rawT = hd.rawT;
        const diff = (has(rawT) && has(y.Trep)) ? rawT - y.Trep : null;
        const big = diff !== null && y.Trep ? Math.abs(diff) / y.Trep > 0.005 : false;
        const okAll = !!hd.box && !!hd.used && !miss.length && !big;
        /* 这条**没有红灯**，只有黄灯，理由是结构性的：
           report.js 用六项 × 0.5% 做过一道闸——认不全、或与报表差得离谱，
           汇总就整块不进正文（见那边的 repOf / headOk）。所以能走到这里的
           "差得离谱"，必然是正文已经退回报表口径，稿子自洽、数字没错。
           一条永远红不起来的校验不该装成红灯：挂着红只会晃眼，
           晃久了人就不再抬眼看这一栏，真问题反而没人发现。 */
        const usedBig = !!hd.used && big;
        const parts = [];
        if (!hd.box) parts.push('页面未返回汇总行');
        else parts.push('已识别汇总行');
        parts.push(`八项中认到 ${gotCore} 项`);
        if (miss.length) parts.push(`未识别 ${miss.map(k => CORE_NAME[k] || k).join('、')}`);
        if (!hd.used) parts.push('正文已改取报表口径，不受影响');
        if (diff !== null && diff !== 0) {
          parts.push(`报表 ${y.Trep} 起、汇总 ${rawT} 起，差 ${Math.abs(diff)} 起`
            + (hd.used ? '' : '（该汇总未采用）'));
        }
        /* 处置的闸门比起数宽（5% 对 0.5%），两源常年差 2～3%——
           不说出来，读的人看到"正文 155275、页面 150520"只会以为又混账了。
           这里只并排写，不改结论：正文取哪一个由 report.js 的 trust 决定。 */
        if (has(y.truckRep) && has(y.truckHead)) {
          const tr = y.truckHead / y.truckRep;
          parts.push(`出动 报表 ${y.truckRep} 辆次、汇总 ${y.truckHead} 辆次`
            + `（相差 ${tr.toFixed(2)} 倍，采用${Math.abs(tr - 1) <= 0.05 ? '汇总' : '报表'}）`);
        }
        ck('ytd.head', '警情总数与报表相称', okAll, parts.join('；'),
          okAll ? undefined : (usedBig ? 'bad' : 'warn'));
      }

      /* 有效条目同比的分母，两个来源：
         表（只覆盖 2025，那一年被补录过，必须用补录前的数）或平台实查（其它年份）。
         取不到就不写数（正文留「同比x」），但要说一句——否则出稿人以为程序算过了。 */
      if (need.ytdLast || has(y.CLast)) {
        const okCas = has(y.CLast) && y.CLast > 0;
        /* 来源写出来：出稿人核同比时要知道这个分母是表里的还是系统查的，
           两种口径能差出上千起（2025 年补录前后就有这么大差额）。 */
        const srcTxt = y.casSrc ? '（去年实查）' : '';
        ck('ytd.casyoy', '成灾同比分母有出处',
          okCas,
          okCas ? `去年同日 ${y.CLast} 起${srcTxt}，同比 ${HT.casYoyWord(y.C, y.CLast) || 'x'}`
            : '去年同日的成灾数未取到，正文写「同比x」',
          okCas ? undefined : 'warn');
      }
    }

    if (need.dayB && has(d.F) && has(d.C)) {
      /* 「一类」在两处出现：记录类型表（接处警口径）与条目统计（全部条目）。
         实测两域通常是同一批记录，本该严格相等；不等就并排摆出来——
         正文那个「无损」正是靠这条等式才敢写成减法。 */
      if (has(d.Jf) && has(d.Fstat) && d.Jf !== d.Fstat) {
        ck('day.fire', '火灾扑救两处一致', false,
          `警情分类表 ${d.Jf} 起、火灾统计表 ${d.Fstat} 起，差 ${Math.abs(d.Jf - d.Fstat)} 起；`
          + '正文的无损数不可用于核对页面',
          'warn');
      }
    }

    /* 处置两个来源都是 optional（综合查询汇总 → 报表 CD_01 兜底）：都拿不到时，
       正文里车辆/人次渲染成「—」，同比退成「无法比较」。这不算错（本来就取不到），
       但必须说出来——两个「—」摆在稿子里，使用者分不清是「当天真没处置」
       还是「接口没给」。只在正文真的写处置时才亮。 */
    if ((need.dayHf || need.dayA) && c.yoy.curTruck === null) {
      const ts = HT.tplsAll(c.cfg).filter(t => t && t.on !== false);
      const wantsForce = ts.some(t => /yoy\.(curTruck|curPerson)|seg:detail/.test(String(t.text || '')));
      if (wantsForce) {
        ck('yoy.cd', '出动力量已返回', false,
          '两个来源均未取到出动数，正文显示「—」', 'warn');
      }
    }

    /* 处置口径自检（1.5.5）：汇总取"一类"与报表"其中一类任务"是同一件事，
       两源应当同量级（补录差通常几成以内）。差出倍数只有一个解释——
       汇总那次取成了全记录（全记录是它的 2~3 倍）。这个坑踩过两次，
       光靠"看正文像不像"不够，让它自己报出来。 */
    if (need.dayHf && c.yoy.curTruck !== null && c.yoy.truckRep !== null && c.yoy.truckRep > 0) {
      const r = c.yoy.curTruck / c.yoy.truckRep;
      ck('yoy.cdmatch', '出动两源同量级', r >= 0.5 && r <= 2,
        `汇总 ${c.yoy.curTruck} 辆次、报表 ${c.yoy.truckRep} 辆次（相差 ${r.toFixed(2)} 倍）`
          + (r < 0.5 || r > 2 ? '，汇总可能按全警情统计' : ''), 'warn');
    }

    /* 年度那两句的处置是**字符串**兜底（缺数时是「—」），不是 null——
       所以上面的 curTruck 判据抓不到它，正文写「—」也没有任何提示。
       只在模板真的用到这两个数时才亮。 */
    if (need.ytdA) {
      const y0 = c.yoy || {};
      const ts0 = HT.tplsAll(c.cfg).filter(t => t && t.on !== false);
      const wantsYtdForce = ts0.some(t => /ytd\.(truckTotal|personTotal)/.test(String(t.text || '')));
      if (wantsYtdForce) {
        const lack = [];
        if (y0.truckTotal === '—') lack.push('车辆');
        if (y0.personTotal === '—') lack.push('人次');
        ck('ytd.force', '年度出动数已取到', lack.length === 0,
          lack.length ? `年度出动的${lack.join('、')}未取到，正文显示「—」` : '车辆与人次都在', 'warn');
      }
    }

    if (need.detD && d.C !== null) {
      /* 中心城区没配 = 这个概念不存在，正文那句「中心城区共发生有效条目 0 起」
         读起来像「确实一起都没有」，实际上是配置为空。这是错信息，得报出来。 */
      const coreSet = String((c.cfg && c.cfg.coreTowns) || '').trim();
      ck('det.coreset', '中心城区名单已配置', !!coreSet,
        coreSet ? '已配置 ' + coreSet.split(/[、,，\s]+/).filter(Boolean).length + ' 个区'
          : '名单为空，正文的中心城区起数会写作 0');

      /* 区域加总 = **明细条数**，不是报表有效数。
         每一起来火都要落到某个区域名下，加不回去只可能是「有记录的区域为空」，
         这是真错。明细与报表差几起（跨域残差）是已知的，按用户定的规则全部
         落到「轻微条目」上，正文加得回去——所以那个差只在说明里提一句，不判红。 */
      /* 接口"成功返回空列表"是很常见的故障：不报错，正文直接写「0 起」。
         报表说今天有 N 起有效、明细却一条都没有，这两件事不可能同时为真。 */
      ck('det.empty', '明细非空', !(e.count === 0 && d.C > 0),
        e.count === 0 && d.C > 0
          ? `报表成灾 ${d.C} 起、明细 0 条，可能为分页或筛选未生效`
          : `明细 ${e.count} 条`);

      ck('det.town', '区县合计等于明细条数', e.townSum === e.count,
        `区县加总 ${e.townSum}，明细 ${e.count} 条`
          + (d.C !== null && e.count !== d.C
            ? `（报表成灾 ${d.C} 起，差 ${d.C - e.count} 起已计入轻微火灾）` : ''));

      /* 这条判的是**等级列有没有被读成常量**。两种"常量"里只有一种能判：
           全认成「轻微」→ 一般及以上 0 起。这个**真实会自然出现**：
             实测 2026-10-19 一整天 15 条全是轻微（那天有效都是小条目）。
             上一版曾拿它当判据，等于给真实数据亮黄，已改。
           全认成「非轻微」→ 一条轻微都没有、一般及以上 = 全部条数。这个两周没出现过：
             10-10～10-23 十四天 240 条，每天轻微 6～21 条，一次 0 都没有。
         所以只判这一侧，且条数 ≥10（两三条都有效是正常的）。 */
      const levelOdd = e.count >= 10 && e.count - e.nMajor === 0;
      ck('det.level', '一般及以上与明细相称',
        e.nMajor >= 0 && e.nMajor <= e.count && !levelOdd,
        levelOdd
          ? `明细 ${e.count} 条中无一条轻微火灾，等级列可能取错`
          : `一般及以上 ${e.nMajor}，明细 ${e.count}，轻微 ${e.nMinor}`,
        levelOdd ? 'warn' : undefined);

      /* 平台「是否轻微条目」这个筛选对「待填报」记录不生效（2026-11-16 实测）：
         这几条在明细里写着「非轻微条目」，页面筛却不返回。正文按**页面口径**写，
         把它们排除在「一般及以上」之外、差额落到轻微上——所以这不是错，
         亮黄只是让核稿的人先看到这句，别拿页面条数来质疑正文。 */
      if (e.pendingMajor) {
        /* 常态项，用 note 而不是 warn：待填报每天都有一批，天天亮黄等于没亮。 */
        ck('det.pending', '待填报记录的口径', true,
          `${e.pendingMajor} 条待填报记录写作非轻微，页面筛选不返回；`
          + `正文按页面口径写 ${e.nMajor} 起，差额计入轻微 ${e.nMinor} 起`, 'note');
      }

      /* 「已查明 + 待查 = 明细条数」是定义出来的恒等式（待查 = 条数 − 已查明），判它没意义。
         有意义的是**一条原因都读不到**：历史上踩过一次——字段名用了
         fireCauseLvl1Name，而实时报文里那列全是 null，真名是 fireCauseValue。
         后果是正文退化成「起火原因主要为：其余正在调查中」，且没有任何提示。 */
      ck('det.cause', '起火原因读得到', !(e.count > 0 && e.causeSum === 0),
        e.count > 0 && e.causeSum === 0
          ? `明细 ${e.count} 条均无原因值，`
            + '正文会退化为「其余正在调查中」'
          : `已查明 ${e.causeSum}，待查 ${e.caused}`);

      /* 明细里混进了窗口外的记录（按起火时间判）。
         起因是请求同时带了两套时间：记录域一套、条目域一套（参数名见 contract.js），
         服务端认哪一套没有文档。若认的是发生时间，「发生在本期、起火在上一期」的记录
         会被带进来；而正文的有效起数取报表（按起火时间），两边口径就错位了。

         后果很隐蔽：一般及以上偏多、轻微被压小，两个数都还长得正常。
         这里只报不改——删记录等于替服务端猜口径，得先确认再动手。
         （别把 11-15 那次的 8 起 vs 6 起当成这条的例子：那两起是「待填报」记录
         被页面的筛选漏掉，与时间窗无关，见 口径实测记录 §21 五之补二。） */
      if (e.detOutWin) {
        ck('det.window', '明细都在本期窗口内', false,
          `${e.detOutWin} 条明细的起火时间不在本期，一般及以上可能偏多；`
          + '请按同一窗口核对页面条数', 'warn');
      }

      /* 未填等级的记录会被算进「轻微条目」（majorAll 只认「非轻微条目」），
         于是「一般及以上」偏小、「轻微」偏大，而两条都还是正常数字。
         不阻断出稿，但必须说出来：这是「数据缺填」里唯一会改数字的一种。 */
      if (e.severityBlank) {
        ck('det.sevblank', '明细等级填写完整', false,
          `${e.severityBlank} 条明细未填「是否轻微火灾」，已计入轻微`, 'warn');
      }

      /* 渝北、江北在正文里并成「两江」，但系统里是分开的三个区域。
         合并只发生在输出层，所以这里核对「并进去的起数一个没漏」。
         有合并才出现这一条：设置里关掉「并入两江」时，正文本来就按三个名字
         各写各的，再拿三者之和去比其中一个，那条会天天黄。 */
      const mergeOn = !(c.cfg && c.cfg.townMerge === false);
      const MERGE_SRC = HT.TOWN_OUT;
      const rawOf = n => {
        const h = (e.townRaw || []).find(x => x.name === n);
        return h ? h.n : 0;
      };
      const mergedNames = Object.keys(MERGE_SRC).filter(n => rawOf(n) > 0);
      const rawSum = mergedNames.reduce((a, n) => a + rawOf(n), 0);
      if (mergeOn && rawSum > 0) {
        const h = (e.townList || []).find(x => x.name === MERGE_SRC[mergedNames[0]]);
        const outN = h ? h.n : 0;
        ck('det.townMerge', '渝北江北并入两江', rawSum === outN,
          `${mergedNames.map(n => `${n} ${rawOf(n)}`).join(' + ')} = ${rawSum}`
            + `，正文「${HT.shortTown(MERGE_SRC[mergedNames[0]], (c.cfg || {}).shortTown !== false)}」${outN}`,
          rawSum === outN ? undefined : 'warn');
      }

      /* 中心城区是从明细里挑出来的子集，不可能比明细还多。 */
      /* 中心城区原来判的是子集关系（nCore ≤ 明细条数、nCoreMajor ≤ nCore），
         两条都恒成立，等于没判。真正会错的是**名单对不上数据**：平台给「渝中区」，
         设置里写成「渝中」，一个字之差就全部匹配不上，中心城区恒为 0，
         正文写「中心城区 0 起」，读起来像"确实一起都没有"。
         所以判「明细够多、却一条都落不进中心城区」。
         阈值取 10：九天有效 14～30 起，中心城区每天 1～7 起，10 起以上全在郊县很少见。 */
      const coreGhost = e.count >= 10 && e.nCore === 0;
      ck('det.core', '中心城区名单能对上明细', !coreGhost,
        coreGhost
          ? `明细 ${e.count} 条无一落在中心城区，`
            + '请核对设置中的名单写法'
          : `中心城区 ${e.nCore} 起，其中一般及以上 ${e.nCoreMajor}，轻微 ${e.nCoreMinor}`,
        coreGhost ? 'warn' : undefined);

      if (e.truncated) {
        ck('det.trunc', '明细未截断', false,
          HT.detailTruncText(e.paged, e.pages, e.count), 'warn');
      }
    }

    if (need.dayB && ty.sum) {
      /* 占比必须是平台给的那一列。自算是降级路径，写出来的数会与页面不一致，
         所以降级这件事本身就要说出来，而不是静默出一个「看着像」的百分比。 */
      ck('ty.src', '类型占比照抄平台', ty.shareSrc === 'platform',
        ty.shareSrc === 'platform' ? '占比列直接取自平台'
          : '占比列未识别，按六类之和自算', 'warn');
      /* 平台的分母是同一响应里的有效起数（HZ_01[2]），不是六类之和。
         六类一旦交叉归类（加总 ≠ 有效），拿加总当分母就会整句跑偏，
         所以这里逐项核：占 ≈ 起数 ÷ 有效。
         六类**加总**不等于有效是已知的（不互斥），不单列一条。 */
      if (d.C) {
        const off = ty.defs.map((x, i) => ({
          name: x[0], n: ty.nums[i], got: ty.units[i],
          want: Math.round(ty.nums[i] / d.C * 10000)
        })).filter(x => x.n > 0 && Math.abs(x.got - x.want) > 5);
        ck('ty.base', '六类占比以成灾为分母', off.length === 0,
          off.length ? off.map(x => `${x.name} ${u(x.got)}%／按成灾应为 ${u(x.want)}%`).join('、')
            : `各项 ÷ ${d.C} 起都对得上`);
      }
    }

    if (c.yoy.lastMiss) ck('last.miss', '去年同日明细可用', false,
      '去年同日明细未取到：' + c.yoy.lastErr, 'warn');
    if (e.lastTruncated) {
      ck('last.trunc', '去年同日明细未截断', false,
        HT.detailTruncText(e.lastPaged, e.lastPages, e.lastCount), 'warn');
    }

    return out;
  }

  /**
   * 报表口径互校：同一个自然日，「明细数出来的」对「报表统计数出来的」。
   *
   * 为什么单列一条：这两条路**互不依赖**——明细读记录，报表读日结
   * （报表走 `firereport/generate` 的区域档，`isNoDamage=0` 时「条目概况」列
   * 就是一般及以上，中心城区按 11 个区的小计相加）。两条路同时读错同一个字段
   * 的概率极低，所以对不上就是真有东西要查。
   *
   * 三档处置：
   *   差 0        → 绿，两套账在这天对得上；
   *   差 1~2 起   → 灰（附注），是已知的模块间口径差（日结把明细查不到的非 119 渠道、
   *                 直接录入也算了进去），每期都会有，不该天天亮红；
   *   差 ≥3 起    → 红。最常见的是报表那边 `isNoDamage` 没带（把轻微条目也算成
   *                 一般及以上），其次是中心城区名单写法没对上。
   *
   * @param {object} m {dayText, detMajor, detCore, rptTotal, rptCore, pending}
   */
  function reportCrossCheck(m) {
    const dAll = m.detMajor - m.rptTotal;
    const dCore = m.detCore - m.rptCore;
    const big = Math.abs(dAll) > 2 || Math.abs(dCore) > 2;
    const same = dAll === 0 && dCore === 0;
    const out = [];
    const ck = ckOf(out);
    const body = `${m.dayText} 全天：明细 ${m.detMajor} 起／报表 ${m.rptTotal} 起`
      + `（差 ${dAll}）；中心城区 明细 ${m.detCore}／报表 ${m.rptCore}（差 ${dCore}）`
      + (m.pending ? `；当天明细里有 ${m.pending} 条待填报` : '');
    ck('cross.rpt', '报表口径互校', !big,
      big ? body + '。差 3 起以上，请核对报表筛选与中心城区名单写法' : body,
      big ? 'bad' : (same ? 'ok' : 'note'));
    return out[0];
  }

  Object.assign(HT, { buildChecks, reportCrossCheck });
})(typeof window !== 'undefined' ? window : globalThis);
