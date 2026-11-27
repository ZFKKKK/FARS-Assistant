/**
 * src/domain/report.js —— 取数编排与事实汇总
 *
 * @layer  domain（领域层）
 * @file   src/domain/report.js
 * @since  5.0.0
 *
 * 流程四步，每步只干一件事：
 *   1. plan     由 buildSegments(cfg)[].needs 汇总取数计划（模板里用不到的数据一次都不请求）
 *   2. gather   按计划取数；去年同日明细失败只降级同比措辞，不阻断
 *   3. context  把 60 段报表 + 明细折成一份事实对象（起数、占比、分组、同比）
 *   4. render   逐段 render(ctx) 出文，buildChecks(ctx) 出自洽结论
 *
 * 数据口径（已与业务核对，勿擅改）：
 *   起数 = 明细条数；金额 = sum(directEconomicLoss)；isNoDamage=0 是"只看有效"的总开关
 */
(function (g) {
  'use strict';
  const HT = (g.__HT = g.__HT || {});

  /**
   * 列位置。全部来自 data/contract.js——本文件不再写 values[N] 这种裸下标。
   *
   * 为什么这一条比"少打几个字"重要：站点把某一列往前挪一格时，
   * 症状是某个数字变成 0 或 "—"，而数量关系仍然自洽（同比基准和本期
   * 取错到同一列），校验全绿、正文看着正常。裸下标散在 300 行里时，
   * 改版排查等于逐行数格子；集中到 contract.js 后只改一张表。
   */
  const COL = HT.REPORT_COLS;

  /**
   * 「待填报」判据。平台「是否轻微条目」这个筛选**对「待填报」的记录不生效**
   * （2026-11-16 实测，出稿人截图确认）：它们在全量导出里明明写着「非轻微条目」，
   * 用这个条件筛却不返回。使用者核稿是照着页面筛的，所以正文也按**页面口径**算——
   * 待填报的排除在「一般及以上」之外，差额照老规矩落到轻微上（轻微 = 有效 − 一般及以上）。
   *
   * 实测 11-15 那期：全量 24 条里写着非轻微的有 8 条，页面「＝否」只给 6 条，
   * 少的九龙坡 12:53、奉节 13:30 两条状态都是待填报、金额面积户数三项全空。
   * 出稿人定的口径就是页面那 6 起。
   *
   * 定义放在模块级：正文（buildContext）与报表互校（crossOf）分属两层作用域，
   * 而两边都要这条判据。原先只写在 buildContext 里，crossOf 取不到，
   * 于是每次互校都抛 ReferenceError——校验栏那一行从来没出现过，
   * 遥测里 RPT-CROSS 记的一直是「isPending is not defined」。
   */
  const isPending = x => String((x && x.fireStatusValue) || '').trim() === '待填报';


  /**
   * 把原始接口数据折成事实对象。
   * @param {object} D     已取到的原始数据，键为数据源名
   * @param {object} need  本次取过哪些源
   * @param {object} cfg
   * @param {object} W     buildWindows 结果
   * @param {string} lastErr 去年同日明细失败信息
   */
  function buildContext(D, need, cfg, W, lastErr, lastCasErr) {
    const num = HT.num;

    /* ══ 今年以来 ══ */
    const jq01 = D.ytdA && D.ytdA.JQ_01;
    const jq04 = D.ytdA && D.ytdA.JQ_04;
    const hz01A = D.ytdA && D.ytdA.HZ_01;
    const hz01B = D.ytdB && D.ytdB.HZ_01;

    /* 缺哪一段就点名哪一段：原来只说"数据不全"，使用者无法判断是接口没给、
       还是截点设错——而这两件事的处置完全不同（一个改设置，一个报修）。
       句子是纯事实，处置语在 errors.js 的 DATA 卡里，不在这里重复。 */
    /* 缺哪一段就点名哪一段：原来只说"数据不全"，使用者无法判断是接口没给、
       还是截点设错——而这两件事的处置完全不同（一个改设置，一个报修）。
       句子是纯事实，处置语在 errors.js 的 DATA 卡里，不在这里重复。 */
    if (need.ytdA && !(jq01 && jq04 && hz01A)) {
      const miss = [['JQ_01', jq01], ['JQ_04', jq04], ['HZ_01', hz01A]]
        .filter(x => !x[1]).map(x => x[0]);
      throw HT.err('DATA', `今年以来报表缺 ${miss.join('、')}`);
    }
    if (need.ytdB && !hz01B) {
      throw HT.err('DATA', '今年以来成灾火灾报表缺 HZ_01');
    }

    /* 记录数的来源只有两处，正文取前者：
         Trep 报表 JQ_01 / JQ_04 / CD_01 算的那一套（上报口径）。
         Th   综合查询汇总（http.js 的 fetchHead）——页面上「共查询到 78440 起…」那一行。
       为什么正文取综合查询：使用者核对的就是页面上那一行，写报表数只会被当成取错。
       两个数都要留着，checks 的 ytd.head 会把它们并排摆出来，差值不藏。
       取不到汇总就退回报表——句子照样成立，只是口径回到报表那边。 */
    const Trep = jq01 ? num(jq01.values[COL.JQ_01.total]) : null;
    const H = D.ytdH || null;
    const hv = (H && H.v) || {};

    /* 候选字段名认出来的值，必须能与报表对得上才用。
       字段名是从真实响应里认的（见 contract.js 的 HEAD_QUERY），认错一个同名字段
       就会拿别的数去写稿——而同一段时间、同一批记录，两个模块不可能差出几成。
       所以这里做一次量级比对：差得离谱就当没认出来，退回报表。

       **容差按指标分两档**：
         · 起数 0.5%——同一批记录的两种数法，只该差个位数（实测 78982 ↔ 78990）；
         · 处置 5%——两个模块各自汇总的处置，实测常年差 2～3%（2026-11-16：
           汇总 150520、报表 JQ_01 155275、报表 CD_01 154049，三条都对不上）。
           拿 0.5% 卡它，每次都会判成"认错字段"而静静退回报表。 */
    const trust = (h, rep, tol) => {
      if (h === null || h === undefined || !isFinite(h)) return null;
      if (rep === null || rep === undefined || rep === 0) return h;
      return Math.abs(h - rep) / Math.abs(rep) <= (tol || 0.005) ? h : null;
    };
    /* 条目统计口径：含非 119 渠道受理、直接录入、跨区移交，会比接处警口径多几十起。
       它现在只做兜底与对照，正文不再直接用它。 */
    const FH = hz01A ? HT.numOrNull(hz01A.values[COL.HZ_01.total]) : null;
    const C = hz01B ? num(hz01B.values[COL.HZ_01.total]) : null;
    /* 去年年初至今的有效累计——「有效条目同比」的分母。两个来源，**表优先**：
         ① 手工月度表（data/cas-last.js）：只覆盖 2025 那一年。那一年被事后补录过，
            补录把全年总数抬高了一截，拿补录后的数比今年，同比会年年偏低；
            使用者当初报出去的是补录前那个数，所以必须用表里的。
         ② 平台实查（ytdLast 数据源）：表里没有的年份走这条，分母跟着基准时间走，
            不需要有人每年更新文件。
       两者都没有才是 null——正文退回「同比x」，不拿别的数顶。 */
    const casTbl = HT.lastYearCas ? HT.lastYearCas(W.base) : null;
    const hzLast = D.ytdLast && D.ytdLast.HZ_01;
    const casSys = hzLast ? num(hzLast.values[COL.HZ_01.total]) : null;
    const CLast = casTbl !== null ? casTbl : casSys;
    const casSrc = casTbl !== null ? 'table' : (casSys !== null ? 'platform' : '');
    /* 四类同理：先取综合查询汇总，认不出/对不上才用 JQ_04。
       五类在汇总里是**严格加总等于总数**的（78440 = 14454+11694+44711+1027+6554），
       所以只要五个数都认到，sum === T 本身就是一道印证（见 checks 的 ytd.sum）。 */
    const Qr = jq04 ? num(jq04.values[COL.JQ_04.rescue]) : null;
    const Sr = jq04 ? num(jq04.values[COL.JQ_04.socialAid]) : null;
    const Ar = jq04 ? num(jq04.values[COL.JQ_04.security]) : null;
    const Xr = jq04 ? num(jq04.values[COL.JQ_04.falseAlarm]) : null;
    /* JQ_04 自己的总起数与一类。五类加总必须在这张表**内部**对账：
       它自己的五个数严格加总等于它自己的 [2]（快照实测 7498 = 817+1105+…）。
       以前是拿 HZ_01 的条目数 + JQ_04 的四类，去比 JQ_01 的总起数——三个来源拼一次
       加法，条目统计口径与接处警口径差几十起，这一项几乎天天红，红到没人再看。
       正文的「一类」已改用本表的 [3]（见下方 F）；三处口径差由 checks 的
       ytd.fire 明说，那个差值是给人解释"两套账为什么不一样"用的。 */
    const JT = jq04 ? HT.numOrNull(jq04.values[COL.JQ_04.total]) : null;
    const JF = jq04 ? HT.numOrNull(jq04.values[COL.JQ_04.fire]) : null;
    /* JQ_01 自己也有一列「其中一类」——第三个来源，只用于对账，不进正文。
       只看两个来源时，一旦不等就说不清"是条目统计多了，还是记录分类少了"；
       三列并排才能定案：若 JQ_01 与 HZ_01 相等而 JQ_04 偏小，那是分类表的
       归类差；若 JQ_01 与 JQ_04 相等而 HZ_01 偏大，那才是条目统计口径多收。 */
    const J1F = jq01 ? HT.numOrNull(jq01.values[COL.JQ_01.fire]) : null;

    /* ── 总起数与五类是**一个整体**，不许逐项回退 ──────────────
       逐项回退（缺一项就用报表补那一项）曾经写出这样的句子：
       「共接处警 1234 起（其中一类 210、二类 175…）」——
       总数与一类取自汇总，二类取自报表，一句话里两个账。
       校验的 ytd.sum 看得见（加不回去了），读稿的人看不见。
       所以先判一次"六项是否都认得且都对得上"，全过才整块用汇总，
       任何一项不过就整块回报表：**要么同一个账，要么另一个账，不混**。
       逐一比对用的是报表侧的同名数（T↔JQ_01、F↔JQ_04、四类↔JQ_04），
       同一段时间、同一批记录，两个模块差不出 0.5%——差得离谱就是字段认错了。 */
    const repOf = { T: Trep, F: JF !== null ? JF : FH, Q: Qr, S: Sr, A: Ar, X: Xr };
    const headOk = ['T', 'F', 'Q', 'S', 'A', 'X'].every(k => trust(hv[k], repOf[k]) !== null);
    /* Th 只在"整块用汇总"时有值：它同时是 checks 判断正文吃的是哪套账的依据。 */
    const Th = headOk ? hv.T : null;
    const T = headOk ? hv.T : Trep;
    /* 正文的「一类」用**记录口径**（JQ_04[3]）：它与其余四类同源、是接处警总数的
       子集，五类加总因此天然自洽。取不到才退回条目统计口径（FH）。
       早先这里直接取 FH，于是「其中一类」比五类之和还大一截——那条加总校验
       天天红，红到没人再看。 */
    const F = headOk ? hv.F : (JF !== null ? JF : FH);
    const Q = headOk ? hv.Q : Qr;
    const S = headOk ? hv.S : Sr;
    const A = headOk ? hv.A : Ar;
    const X = headOk ? hv.X : Xr;
    const O = (S !== null && A !== null && X !== null) ? S + A + X : null;
    const N = (F !== null && C !== null) ? F - C : null;

    /* 单位数（0.01% 为单位），同组严格加总 10000。
       pin=[0] 把「一类」的占比**钉在四舍五入真值上**：凑整的压力全部由
       其余四个小项承担。理由是它的占比被单独引用、被拿计算器核对得最多，
       一旦为了凑 100.00 把它 floor 掉或削掉，正文就和报表打架。 */
    let units5 = [];
    let uF = 0, uQ = 0, uS = 0, uA = 0, uX = 0, uO = 0, uC = 0, uN = 0;
    /* 五类齐全才配占比：缺一个，最大余数法会把缺口摊到其余四项上，
       算出一组"合计 100.00% 但每一项都偏"的占比，比不写更糟。 */
    if (T && [F, Q, S, A, X].every(v => v !== null && v !== undefined)) {
      units5 = HT.allocUnits([F, Q, S, A, X], T, 10000, [0]);
      [uF, uQ, uS, uA, uX] = units5;
      uO = uS + uA + uX;
      uC = Math.round(C / T * 10000);
      /* 不夹 0。uN 与 uC 都保留真实符号，三个数（起数、两处占比）方向一致。
         正常情况下走不到这里：无损由一类减有效定义，两者同源、有效是子集，
         N 恒不小于 0。保留符号只为一件事——万一上游取数错了，宁可让
         「无损火警 -451 起」这个荒谬的数摆在眼前，也不要夹成 0 假装没事。

         以前这里夹过 0（`if (uN < 0) { uN = 0; uC = uF; }`），结果同一份稿子里
         数字写 -451、「每日记录数据」的占比写 0.00%、「每日汇总数据」又写 -451.00%（那边用原始 N 直接除），
         三个地方各说各的，比全写负数更难判断。 */
      uN = uF - uC;
    }

    const dead = hz01B ? num(hz01B.values[COL.HZ_01.dead]) : null;
    const hurt = hz01B ? num(hz01B.values[COL.HZ_01.hurt]) : null;
    /* [7][8]（死亡/受伤人数的"同比增减"）不再取。
       原因是它不提供方向：接口的历史口径是"下降为正"，减少的月份给的也是正数，
       方向只写在 templateContent 的字面里（"死亡人数增加X人"）。
       按符号判会把减少写成增加，反推的去年人数跟着差一倍。
       正文只要人数人数本身，用户明示不要这句同比，所以连同反推一起撤掉。
       真要恢复，必须先过 dirOf(content, '死亡人数') 拿方向，不能直接相减。 */
    /* 起数同比：接口给的是"下降为正"的数值，方向写在 templateContent 的字面里
       （"条目起数下降X%"），values 里没有方向列——JQ_01 有独立方向列，HZ_01 没有。
       所以不能拿符号猜方向，只能读原文；读不到才退回按符号判断。 */
    const yoyC = hz01B ? HT.numOrNull(hz01B.values[COL.HZ_01.yoyNum]) : null;
    const yoyCdir = hz01B ? HT.dirOf(hz01B.content, '火灾起数') : '';
    /* 记录起数同比（JQ_01 [5]方向 [6]数值）：拼串交给 segments 的 yoyPlain，
       取不到数字时返回空串而不是裸的 "%"（列表为空的月份曾出现"记录起数%"）。 */
    /* 记录起数同比：方向只能用报表那一列（汇总里没有方向），数值优先用汇总的。
       页面上写「同比上升 4.21%」，报表给 4.18%——差 0.03 个百分点，人一眼能看出来。
       所以：汇总的数值与报表相差在 0.2 个百分点以内就换成汇总的；
       差得远说明认错了字段（或两边方向约定不同），仍用报表，不冒险。 */
    let yoyQ = jq01 ? HT.yoyPlain(jq01.values[COL.JQ_01.yoyDir], jq01.values[COL.JQ_01.yoyNum]) : '';
    if (jq01 && hv.yoyT !== undefined) {
      const repYoy = HT.numOrNull(jq01.values[COL.JQ_01.yoyNum]);
      if (repYoy !== null && Math.abs(hv.yoyT - repYoy) <= 0.2) {
        yoyQ = HT.yoyPlain(jq01.values[COL.JQ_01.yoyDir], String(hv.yoyT));
      }
    }

    /* ══ 当日 ══ */
    const dJq01 = D.dayA && D.dayA.JQ_01;
    const dHz01A = D.dayA && D.dayA.HZ_01;
    const dHz01B = D.dayB && D.dayB.HZ_01;
    const dHz21 = D.dayB && D.dayB.HZ_21;
    const dCd01 = D.dayA && D.dayA.CD_01;

    if (need.dayA && !(dHz01A || dJq01)) {
      throw HT.err('DATA', `当日报表缺 ${[['JQ_01', dJq01], ['HZ_01', dHz01A]]
        .filter(x => !x[1]).map(x => x[0]).join('、')}`);
    }
    if (need.dayB && !dHz01B) {
      throw HT.err('DATA', '当日成灾火灾报表缺 HZ_01');
    }

    const dT = dJq01 ? num(dJq01.values[COL.JQ_01.total]) : null;
    const dJq04 = D.dayA && D.dayA.JQ_04;
    /* 「全部条目」与「有效」是同一张 HZ_01 的两种过滤：
         dayA 不带 isNoDamage（全部）、dayB 带 0（只要有效）。
       于 2026-11-14 在综合查询里把三个页签各查了一遍（同一 2026-11-13 窗口）：
         查记录＋一类  26 起，同比 +4.00%
         查条目（有效）    20 起，同比 −13.04%
         查无金额火警       6 起，同比 +200.00%
       26 = 20 + 6，且三个同比各自都对得上基期（25 = 23 + 2）。
       结论：**「记录口径的一类」与「条目域的全部条目」是同一批记录**，
       不是两套账。所以「无损 = 全部 − 有效」是定义式，两端同源，不存在跨表相减。
       据此 F 取记录口径（与正文「共处置记录」同源），C 取有效，N 相减；
       前提是 F 与条目统计的「全部」仍相等，由 checks 的 day.fire 把关。

       上一版曾按「要无损就再查一趟 isNoDamage=1」来做，没有效果。拿到真实载荷后查明，原因不是别的，
       而是**它属于记录域**：
         comprehensiveWarningQueryReq 里有 isNoDamage（"0" = 只要有效）
         comprehensiveFireQueryReq   里根本没有这个键
       我们发的是 fireType=4（条目域）却把 isNoDamage 塞进记录对象，服务端不认，
       于是那趟请求拿回同一批有效记录、永远触发不了闭合、永远走回退。已删除。
       「无损」在条目域是靠 fireType=19 单独切出来的一个域，这条没变。 */
    const dFh = dHz01A ? HT.numOrNull(dHz01A.values[COL.HZ_01.total]) : null;
    const dJf = dJq04 ? HT.numOrNull(dJq04.values[COL.JQ_04.fire]) : null;
    const dC = dHz01B ? num(dHz01B.values[COL.HZ_01.total]) : null;
    const dF = dJf !== null ? dJf : dFh;
    const dN = (dF !== null && dC !== null) ? dF - dC : null;

    /* ══ 本周（1.12.0）══
       窗口就是 W.DAY。周周期下 window.js 已经把它换成「本周一 0 时至条件时间」，
       所以这里**不再发一套请求**：上面那几个 d* 就是本周的数。
       这一段做的是另外三件事：
         1. 把五类拆成周报要的几个量（一类 / 二类 / 三类及其他）；
         2. 有效同比换一个**补录前**的分母（见下面 weekLast）；
         3. 带上本周人数的平台值（设置页「每周」那套数留空时用它兜底）。
       周报那句与日报那句在模板里是两套，字段名也分开（week.* 与 day.*），
       免得改周报时误动了日报的写法。 */
    const dQ = dJq04 ? num(dJq04.values[COL.JQ_04.rescue]) : null;
    const dS = dJq04 ? num(dJq04.values[COL.JQ_04.socialAid]) : null;
    const dA = dJq04 ? num(dJq04.values[COL.JQ_04.security]) : null;
    const dX = dJq04 ? num(dJq04.values[COL.JQ_04.falseAlarm]) : null;
    const dO = (dS !== null && dA !== null && dX !== null) ? dS + dA + dX : null;
    /* 占比与日报同一套规矩：**五类齐全才配占比**，缺一项就不算，
       免得最大余数法把缺口摊到其余几项上，算出一组合计 100% 但项项都偏的数。
       uC 的分母是接处警总数（周报那句「一类193起，占比15.92%」就是这么来的），
       uN 由 uF − uC 得出，两者相加恒等于 uF。 */
    let wuF = 0, wuQ = 0, wuO = 0, wuC = 0, wuN = 0;
    if (dT && [dF, dQ, dS, dA, dX].every(v => v !== null && v !== undefined)) {
      const u5 = HT.allocUnits([dF, dQ, dS, dA, dX], dT, 10000, [0]);
      wuF = u5[0]; wuQ = u5[1];
      wuO = u5[2] + u5[3] + u5[4];
      wuC = Math.round(dC / dT * 10000);
      wuN = wuF - wuC;
    }
    const dDead = dHz01B ? num(dHz01B.values[COL.HZ_01.dead]) : null;
    const dHurt = dHz01B ? num(dHz01B.values[COL.HZ_01.hurt]) : null;

    /* 本周记录起数同比：取平台 JQ_01 自己的方向列与幅度列——页面上
       「同比上升 12.53%」就是这一格，没有补录问题（补录影响的是有效条目）。 */
    const wYoyQ = dJq01
      ? HT.yoyPlain(dJq01.values[COL.JQ_01.yoyDir], dJq01.values[COL.JQ_01.yoyNum]) : '';

    /* 本周**有效**同比：分母必须是去年同周、**补录前**的数。
       平台 HZ_01 那一列同比是拿补录后的去年数比的，拿它写周报会年年偏低，
       与使用者当初报出去的那个数不一样。所以：
         ① 手工月度表能覆盖那一年（2025 特例）→ 按天折算去年同周那一段；
         ② 覆盖不到（其余年份）→ 用平台实查的去年同周有效数（weekLast 源）；
         ③ 两个都没有 → 退回平台那一列同比，并在措辞上保持同一副面孔。
       注意 ① 与 ② 都要 round 成整数：周报里写的是「有效条目135起」这种整数，
       分母带小数算出来的百分比与手工核对时对不上。 */
    const weekLastHz = D.weekLast && D.weekLast.HZ_01;
    const weekSysC = weekLastHz ? num(weekLastHz.values[COL.HZ_01.total]) : null;
    const weekTblC = HT.lastYearCasBetween ? HT.lastYearCasBetween(W.LAST.s, W.LAST.e) : null;
    const wCLast = weekTblC !== null ? weekTblC : weekSysC;
    const wCasSrc = weekTblC !== null ? 'table' : (weekSysC !== null ? 'platform' : '');
    let wYoyC = HT.casYoyWord(dC, wCLast);
    if (!wYoyC) {
      const wRep = dHz01B ? HT.numOrNull(dHz01B.values[COL.HZ_01.yoyNum]) : null;
      const wRepRaw = dHz01B ? String(dHz01B.values[COL.HZ_01.yoyNum] == null
        ? '' : dHz01B.values[COL.HZ_01.yoyNum]).trim() : '';
      wYoyC = wRep === null ? HT.CAS_FIRE_YOY_TEXT
        : Math.abs(wRep) < 0.005 ? '持平'
          : HT.yoyPlain((dHz01B ? HT.dirOf(dHz01B.content, '火灾起数') : '') || '下降',
            wRepRaw || String(wRep));
    }

    /* ══ 明细 ══ */
    const detail = D.detD || [];
    const detailLast = D.detL || [];
    const detailCount = detail.length;
    /* 区域分两层，别混：
         townOf  平台原值（渝北区 / 江北区 / 两江新区 三个值）——
                 **筛选与校验只认它**：三个值都算中心城区（中心城区 11 个含两江、
                 高新），同一起只落在其中一个值上，不会重复计。名单里存的是简称
                 「两江」，所以必须先 shortTown 归一；若拿 townOut 判，得到的是
                 全名「两江新区」，不在名单里，这三处的有效会整体丢掉。
         townOut 正文写法（三个都写「两江」），只用在**输出**上。
       请求与统计一层不动，合并只发生在最后一步——这样"渝北多少起"随时查得出来，
       而稿子里写的是一个「两江」。 */
    const townOf = x => HT.townOf(x);
    const townOut = x => HT.townOut(townOf(x), cfg);
    const coreNames = String(cfg.coreTowns || '').split(/[、,，\s]+/)
      .filter(Boolean).map(x => HT.shortTown(x, true));
    const isCore = t => coreNames.includes(HT.shortTown(t, true));

    const coreList = detail.filter(x => isCore(townOf(x)));
    const majorAll = detail.filter(x => x.severity === '非轻微火灾' && !isPending(x));
    const pendingMajor = detail.filter(x => x.severity === '非轻微火灾' && isPending(x)).length;
    const nMajor = majorAll.length;
    /* ── 误差转移：轻微 = 有效 − 一般及以上 ──────────────────────
       用户定的规则（2026-11-14）：「有效条目必须对齐条目域（类型占比那句只能在
       条目域查），有误差只能把它转移到不重要的地方」——有效段的承接者就是
       轻微条目，不重要的那个。

       所以「轻微」不是一个数出来的数，是一个**减出来的数**：
         有效（报表 HZ_01，isNoDamage=0，条目域）
         − 一般及以上（明细里 severity='非轻微条目' 的条数）
         = 轻微
       两个来源本来就可能差几起（§21：累计数没有同窗口可比数，只有单日同抓取相等），
       差多少全部落到轻微上，正文那句「其中一般及以上 X 起、轻微 Y 起」
       加回去必然等于有效。**数出来的轻微只留给校验对照**（nMinorCount），
       不进正文——否则一句话里三个数各有各的来路。
       当日「无损」用的是同一条办法：无损 = 一类（记录域）− 有效（条目域）。 */
    const nMinorCount = detailCount - nMajor;
    const nMinor = (dC !== null && dC >= nMajor) ? dC - nMajor : nMinorCount;
    const townList = HT.countBy(detail, townOut);
    /* 分项留着：正文并成两江，但"合并前各多少"要能查——校验 det.townMerge 用它，
       使用者问"渝北到底几起"时也用它，不用重新取数。 */
    const townRaw = HT.countBy(detail, townOf);
    const townSum = HT.sum(townList.map(x => x.n));
    const majorList = HT.countBy(majorAll, townOut);
    /* 轻微那一句的区域分布（1.12.14）：正文的 nMinor 是**减出来**的
       （有效 − 一般及以上），而这里的列表是**数出来**的（明细里除一般及以上
       之外的全部），两者差的就是上面那段残差。
       差着就不给括号——句子里写「轻微条目 8 起」、括号里加起来 7 起，
       比不写分布更糟。所以下面带着一个 minorListOk 一起给出去。 */
    const minorList = HT.countBy(detail.filter(x => majorAll.indexOf(x) < 0), townOut);
    const minorListOk = HT.sum(minorList.map(x => x.n)) === nMinor;
    const coreTownList = HT.countBy(coreList, townOut);
    /* 中心城区同一套：先挑出「一般及以上」（同样排除待填报），其余全算轻微。
       这样 nCoreMajor + nCoreMinor 恒等于 nCore，与上面那句的闭合方式一致。 */
    const coreMajorAll = coreList.filter(x => x.severity === '非轻微火灾' && !isPending(x));
    const coreMajorList = HT.countBy(coreMajorAll, townOut);
    const coreMinorList = HT.countBy(coreList.filter(x => coreMajorAll.indexOf(x) < 0), townOut);
    const nCore = coreList.length;
    const nCoreMajor = HT.sum(coreMajorList.map(x => x.n));
    const nCoreMinorCount = HT.sum(coreMinorList.map(x => x.n));
    /* 中心城区这一句没有对应的报表底数，就在自己这一段内闭合：
       中心城区有效 − 中心城区一般及以上 = 中心城区轻微。残差同样落在轻微上。 */
    const nCoreMinor = nCore >= nCoreMajor ? nCore - nCoreMajor : nCoreMinorCount;

    const causeList = HT.countBy(detail, HT.causeOf);
    const causeSum = HT.sum(causeList.map(x => x.n));
    const caused = detailCount - causeSum;

    /* 等级为空的记录：majorAll 只认 '非轻微条目'，这些会被顺手算进"轻微"。
       这不是取不到数，是数据没填——照常出稿，但要让人知道"轻微"里混了未填的。
       条数在这里算，判定与措辞在 domain/checks.js 的 det.sevblank（warn 级）。 */
    const severityBlank = detail.filter(x => {
      const v = x && x.severity;
      return v === null || v === undefined || v === '';
    }).length;

    /* 明细里混进了窗口外的记录：**只诊断，不改数**。
       这条警告现在是个守卫——明细请求**只填起火窗**（见 http.js 的
       fetchDetail 与那段注释）：2026-11-17 实测服务端对「两个时间窗都填」取的是
       并集，只填起火 24 条、两个都填 25 条，多出的那条是「发生在本期、起火在上一期」。
       正文的有效起数取报表（按起火时间），于是「一般及以上」偏多、轻微被压小，
       两个数都还长得正常。

       2026-11-16 用户实测过这个偏移：同一窗口页面「非轻微」6 条，正文写 8 起，
       多出的两条正是这类跨期记录（奉节、九龙坡）。所以这里仍按 fireDate 逐条核：
       请求改对了就该是 0；**哪天不再是 0，说明服务端改了行为或字段名换了**，
       亮出来让人去核页面。不在这里删——删了等于替服务端猜口径，而且会把
       「请求发错了」这件事一起吞掉。 */
    const detOutWin = detail.filter(x => {
      const t = Number(x && (x.fireDate !== undefined ? x.fireDate : x.fireTime));
      if (!t || !isFinite(t)) return false;        // 取不到时间的不判，不算"窗外"
      return t < W.DAY.s.getTime() || t > W.DAY.e.getTime();
    }).length;

    /* ══ 条目类型（HZ_21）══
       占比**照抄平台的 share 列**，不自己除。
       平台的算法是 count / 同一响应里的 HZ_01[2]（有效起数），不是 count / 六类之和：
         全部口径 26 起：22/26=84.62、11/26=42.31、2/26=7.69、1/26=3.85
         有效口径 20 起：18/20=90.00、8/20=40.00、1/20=5.00、1/20=5.00
       自己按六类之和凑 100.00% 是另一套算法，只在"六类加总恰好等于有效"时才与平台一致
       （10 月快照 551=551、11-13 有效口径 20=20 都恰好相等，所以这个错一直没暴露）；
       11-13 全部口径实测 28 ≠ 26，一旦不等，那句话就会与页面差几个百分点
       （22/28=78.57 对页面 84.62），而同一句里「居住场所」那一项仍是除以有效——
       一句话两个分母。
       六类也不是互斥划分（11-13 全部口径六项加总 28、总数 26），
       所以既不能拿加总当分母，也不能要求合计 100.00%。 */
    const typeNums = dHz21
      ? HT.TYPE_DEFS.map(([, iC]) => num(dHz21.values[iC]))
      : HT.TYPE_DEFS.map(() => 0);
    const typeSum = HT.sum(typeNums);
    const shareOf = i => (dHz21 ? HT.numOrNull(dHz21.values[i]) : null);
    /* share 列认不出来（站点改了列序）时退回自己算，并由 checks 的 ty.src 亮黄灯——
       宁可写一个算法可见的近似值，也不要写 0.00%。 */
    const shareOk = !!dHz21 && HT.TYPE_DEFS.every(x => shareOf(x[2]) !== null);
    const typeUnits = !dHz21 ? HT.TYPE_DEFS.map(() => 0)
      : shareOk ? HT.TYPE_DEFS.map(x => Math.round(shareOf(x[2]) * 100))
        : (typeSum ? HT.allocUnits(typeNums, typeSum, 10000) : HT.TYPE_DEFS.map(() => 0));
    const dwelling = dHz21 ? num(dHz21.values[COL.HZ_21.dwelling]) : 0;
    /* 居住场所的占比也照抄 [5]：它与 [3] 同一个分母。
       取不到时才退回 起数/有效——正文那句写的是「占条目总数的 X%」。 */
    const dwShare = dHz21 ? HT.numOrNull(dHz21.values[COL.HZ_21.dwellingShare]) : null;
    const dwellingUnits = dwShare !== null ? Math.round(dwShare * 100)
      : (dC ? Math.round(dwelling / dC * 10000) : null);

    /* ══ 处置与同比 ══
       CD_01 的列序（按 templateContent 逐字对过，别再猜）：
         [2] 共处置业务队伍 X 队次
         [3] 业务车辆 X 车次
         [4] 业务队员 X 人次          ← "共处置"到这里结束
         [5][6][7]  其中一类任务 队次/车次/人次
         [8][9][10] 其中二类任务 …（依次到虚假警）
       **取 [5][6][7]，即"其中一类任务"**。这段讲的是条目（"全市共发生有效
       条目 N 起…处置业务车X辆次"），处置当然该是条目那部分；使用者在综合查询里
       勾上「记录类型＝一类」核到的也正是这一组（实测同一窗口：这里 140 车次 /
       813 人次，页面 142 / 827，差的是补录）。
       0.17 曾反过来取全口径 [3][4]，理由是"正文写的是处置业务车，没说条目"——
       结果同一份稿子里写 19 起有效条目，处置却是全部任务的 414 车次，
       与页面上那行对不上。**同比基准必须同源**：去年同日也取 [6][7]。 */
    /* CD_01 是 optional：当天接口没返回它时，这里曾经兜成 0，正文于是写出
       「处置业务车0辆次、业务指战员0人次，与去年同比今年未发生」——一句
       看着完全正常、内容全错的话（0 与"没取到"在公文里必须分开）。
       所以缺了就是 null，渲染成「—」，同比措辞退成"无法比较"。 */
    /* 处置三项的取值顺序：综合查询（一类口径）→ 报表 CD_01[5][6][7] → null。
       上面那段 CD_01 列序说明保留，它现在是兜底路径的依据；
       平时走的是 hfDay，即页面上勾「一类」时那一行的处置数。
       两个来源的差别只有补录进度（报表按日结、综合查询按当前记录），
       谁在正文里，谁就必须同时决定同比的分子与分母——不能一半一半。 */
    const hfD = (D.dayHf && D.dayHf.v) || null;
    const hfL = (D.lastHf && D.lastHf.v) || null;
    const curTeam = (hfD && hfD.team !== undefined) ? hfD.team
      : (dCd01 ? num(dCd01.values[COL.CD_01.fTeam]) : null);
    const curTruck = (hfD && hfD.truck !== undefined) ? hfD.truck
      : (dCd01 ? num(dCd01.values[COL.CD_01.fTruck]) : null);
    const curPerson = (hfD && hfD.person !== undefined) ? hfD.person
      : (dCd01 ? num(dCd01.values[COL.CD_01.fPerson]) : null);
    const lastTruck = (hfL && hfL.truck !== undefined) ? hfL.truck : null;
    /* 当日起数同比（2026-11-15）。这段的百分比原来是**处置**同比
       （当期车次 ÷ 去年同日车次），可统计报告里根本没有处置同比：
       条目段 HZ_01 只有起数/死亡/受伤/金额四项及其同比，处置段 CD_01 只有当期数。
       用户拿报表核对时必然对不上。现在这个位置放报表那句**有效条目起数同比**：
       幅度取 HZ_01[6]（口径是"下降为正"，没有方向列），方向只能从 templateContent
       的字面里读（"条目起数下降X%"），读不到再按这套老口径当"下降"——与
       segments 里 yoyCdir 的处理保持一致，不自己发明第三种判法。 */
    const dYoyC = dHz01B ? HT.numOrNull(dHz01B.values[COL.HZ_01.yoyNum]) : null;
    const dYoyRaw = dHz01B ? String(dHz01B.values[COL.HZ_01.yoyNum] == null
      ? '' : dHz01B.values[COL.HZ_01.yoyNum]).trim() : '';
    const dYoyCdir = dHz01B ? HT.dirOf(dHz01B.content, '火灾起数') : '';
    /* 拼法两条，各有各的理由：
       · 幅度不到 0.005 就写「持平」——"下降0%"是病句；
       · 其余照**原文精度**拼（接口给 17.39 就写 17.39），不按 2 位小数重排：
         稿子要跟统计报告逐字对得上，接口写 2.1 而我们写 2.10，核稿的人会当成错。 */
    const dCyoyTxt = dYoyC === null || dYoyC === undefined ? ''
      : Math.abs(dYoyC) < 0.005 ? '持平'
        : HT.yoyPlain(dYoyCdir || '下降', dYoyRaw || String(dYoyC));

    /* 当日**全市总条目**起数同比（2026-11-16 用户裁定口径）。
       「全市条目情况」里「处置业务车…人次，与去年同比X%」这句，比的是全市总条目，
       既不是处置、也不是有效。取 dayA（不传 isNoDamage 那一行）的 HZ_01[6]，
       方向同样读 templateContent —— 平台原文就是「共统计条目X起…条目起数下降X%」。

       **上面那个 dCyoyTxt 是有效口径，两个数不是一回事**：同一期 11-14 实测，
       全部 29 起 / 0.00%，有效 19 起 / 17.39%。两个都留着，模板默认用全部口径，
       有效口径仍可从「插入」里取。 */
    const dYoyAll = dHz01A ? HT.numOrNull(dHz01A.values[COL.HZ_01.yoyNum]) : null;
    const dYoyAllRaw = dHz01A ? String(dHz01A.values[COL.HZ_01.yoyNum] == null
      ? '' : dHz01A.values[COL.HZ_01.yoyNum]).trim() : '';
    const dYoyAllDir = dHz01A ? HT.dirOf(dHz01A.content, '火灾起数') : '';
    const dCyoyAllTxt = dYoyAll === null || dYoyAll === undefined ? ''
      : Math.abs(dYoyAll) < 0.005 ? '持平'
        : HT.yoyPlain(dYoyAllDir || '下降', dYoyAllRaw || String(dYoyAll));

    /* 报表侧同一个指标（"其中一类任务"车次）：不用于正文，只给校验比对。
       两源都该是子集，量级差几成以内；差出倍数就说明汇总那次取成了全记录。 */
    const truckRep = dCd01 ? HT.numOrNull(dCd01.values[COL.CD_01.fTruck]) : null;
    /* 基期到底有没有数：下面几处措辞要分"去年缺失""去年为零""取不到"三种 */
    const hasLast = !!(hfL && hfL.truck !== undefined);
    const truckYoy = (curTruck !== null && lastTruck) ? (curTruck - lastTruck) / lastTruck * 100 : null;
    const lCoreN = detailLast.filter(x => isCore(townOf(x))).length;
    const coreYoy = lCoreN ? (nCore - lCoreN) / lCoreN * 100 : null;
    const lastMiss = !!lastErr;
    /* 去年明细没取全（接口未翻页、或翻到页数上限仍没完）时，lCoreN 只会偏小，
       于是"同比上升 X%"就会虚高。以前这里只发一条黄色提示，正文照样算——
       基数不完整的百分比是错的，宁可说"无法比较"，也不能给一个看着正常、
       实际偏高的数。明细逐页取全（0.18.1）之后，这条只在真取不全时才亮。 */
    const lastTrunc = !!(detailLast && detailLast.__truncated);
    /* 措辞统一走 HT.yoyWord（segments.js）：清零说"今年未发生"、
       持平说"持平"，三处同比不会再各写一套边界。
       两句都要先判"当日数有没有取到"：缺了 CD_01 时 0 是假象，
       按 0 算出来的同比会把"没取到"写成"今年未发生"。 */
    const truckYoyTxt = curTruck === null ? '无法比较'
      : !hasLast ? '去年数据缺失'
        : lastTruck === null ? '去年数据取不到'
          : (lastTruck ? HT.yoyWord(truckYoy)
            : (curTruck ? '去年为零，无同比' : '持平'));
    /* 去年同日中心城区 0 起、今年也 0 起，是**持平**，不是"无同比"——
       后者只在分母为零而分子有数时成立。 */
    const coreYoyTxt = lastMiss ? '去年数据缺失'
      : lastTrunc ? '去年明细未取全，无法比较'
        : (lCoreN ? HT.yoyWord(coreYoy)
          : (nCore ? '去年同日为零，无同比' : '持平'));

    /* 今年以来处置的报表侧对照值（JQ_01 [23][24]，全口径）。只用于 0.5% 比对，
       不直接进正文——正文那两个数取汇总（页面上那行），取不到才用它。 */
    const repTruck = jq01 ? HT.numOrNull(jq01.values[COL.JQ_01.truck]) : null;
    const repPerson = jq01 ? HT.numOrNull(jq01.values[COL.JQ_01.person]) : null;
    /* 处置的闸门 25%（1.6.14 从 7% 改）。
       先定死一件事：**页面上那行灰字就是正文要写的数**——使用者核对的就是它，
       写报表数只会被当成取错。所以这道闸不再是"在两份账里挑一份"，
       而是"确认自己没读错字段"：只有差得离谱才判为认错，退回报表给个数，
       并在校验栏说明。差值本身从不藏，ytd.head 会把两源并排写出来。

       25% 从哪来：十月整月（已结账）三个源并排，汇总 12810 / CD_01 13414 /
       JQ_01 13490，汇总比报表恒定低 5.0%，而队次三个源几乎一致
       （8759 / 8700 / 8764，差 0.06%）——差的不是"多算了几起记录"，
       是每起记录的车/人怎么累加，属结构性常数，天天都在，不必每天判一次。
       以前的 5% / 7% 把"口径差"和"读错字段"混在同一个阈值上：结构差天天
       压线，每期都有概率静默退回报表，同一句话里接处警来自汇总、处置来自
       报表，而界面看不出区别。25% 只拦"认错"——认错字段少的也差几成。 */
    const hTruck = trust(hv.truck, repTruck, 0.25);
    const hPerson = trust(hv.person, repPerson, 0.25);

    return HT.attachPhrases({
      cfg, W,
      /* 人数两个数：设置页填了就用设置页的，没填用平台的（1.8.0）。
         模板里 {{f:cas.hurt}} / {{f:cas.dead}} 取的就是它——
         想自己写人数那句、又不想去猜"现在是哪个来源"，用这两个标签最省事。 */
      cas: HT.casNumbers(cfg, { hurt, dead }),
      dayRange: W.dayRange,
      anchorText: W.anchorText,
      /* 模板可插的其它时间写法（见 window.js）：同一段时间有几种文风，
         由写的人挑，不由代码替他决定 */
      dayRangeShort: W.dayRangeShort,
      dayRangeDay: W.dayRangeDay,
      lastRange: W.lastRange,
      anchorClock: W.anchorClock,
      anchorCnFull: W.anchorCnFull,
      ytd: {
        T, Trep, Th, F, FH, C, N, Q, S, A, X, O, JT, JF, J1F,
        /* 去年同期有效累计（同比分母）与它的取数故障：后者只用来在面板上说一句
           "分母没取到，正文写的是同比x"，不阻断出稿。 */
        CLast, casErr: lastCasErr || '', casSrc,
        /* 汇总认得怎么样：给了几个、缺哪几个、命中哪个对象、对象里有哪些字段。
           keys 只有字段名，没有值——所以它可以进诊断、可以截图。
           rawT 是汇总**原样**给的总数（没过 0.5% 过滤）：校验要靠它算出"差多少"，
           否则差得越大越会被过滤掉，红灯反而永远亮不起来。 */
        head: H ? {
          box: H.box || '', keys: H.keys || [], miss: H.miss || [],
          got: Object.keys(hv).length,
          used: headOk, rawT: hv.T === undefined ? null : hv.T
        } : null,
        units5, uF, uQ, uS, uA, uX, uO, uC, uN,
        dead, hurt,
        yoyQ, yoyC, yoyCdir,
        /* 今年以来处置：汇总里有就用汇总（页面上「共处置车辆 150520 辆次」那一行），
           没有仍取 JQ_01 的 [23][24]。
           **这个数以前每次都退回了报表**：闸门是 0.5%，而两源常年差 3%，
           于是同一句里接处警来自汇总、处置来自报表（2026-11-16 实测：
           正文写 155275，页面写 150520）。现在闸门按指标分档，处置用 5%。 */
        truckTotal: (hTruck !== null ? hTruck : (repTruck !== null ? repTruck : '—')),
        personTotal: (hPerson !== null ? hPerson : (repPerson !== null ? repPerson : '—')),
        teamTotal: hv.team !== undefined ? hv.team : null,
        /* 处置的两源原值，只给校验并排显示用（正文只用上面的结论） */
        truckHead: hv.truck !== undefined ? hv.truck : null,
        truckRep: repTruck,
        personHead: hv.person !== undefined ? hv.person : null,
      },
      /* 当日四个数，外加取数的来路：
           Fstat / Jf 只给 checks 用，不进正文。
           两者相等是「无损 = 火扑 − 有效」成立的前提，不等时 day.fire 会说清。 */
      day: {
        T: dT, F: dF, C: dC, N: dN,
        Fstat: dFh, Jf: dJf
      },
      /* 本周：日报与周报取同一批数，但字段名分开（见上面「本周」那一段）。
         period 也带在这里——phrases.js 要按周期决定某些措辞时不用再去翻配置。 */
      week: {
        period: W.period,
        T: dT, F: dF, C: dC, N: dN, Q: dQ, O: dO,
        uF: wuF, uQ: wuQ, uO: wuO, uC: wuC, uN: wuN,
        yoyQ: wYoyQ, yoyC: wYoyC,
        /* 本周人数的平台值。设置页「每周」那一套（weekCasHurt / weekCasDead）
           填了就按填的写，这里只做兜底；每日那两格是年内累计，不进这一段。 */
        hurt: dHurt, dead: dDead,
        /* 有效同比的分母与它的来路，只给校验与诊断看 */
        CLast: wCLast, casSrc: wCasSrc
      },
      det: {
        list: detail, count: detailCount,
        /* townList 是**正文写法**（渝北/江北已并成两江）；townRaw 是平台原值，
           三个区域各多少起。校验拿后者核对合并没算错，人问起也答得上。 */
        townList, townRaw, townSum, coreTownList,
        majorList, nMajor, nMinor, minorList, minorListOk,
        /* 数出来的轻微只给校验对照（正文用的是减出来的那个），
           两者的差 = 这一版转给轻微条目的残差。 */
        nMinorCount,
        nCore, nCoreMajor, nCoreMinor, nCoreMinorCount, coreMajorList, coreMinorList,
        causeList, causeSum, caused, severityBlank, detOutWin, pendingMajor,
        truncated: !!detail.__truncated,
        paged: detail.__paged || '',
        pages: detail.__pages || 0,
        lastTruncated: !!detailLast.__truncated,
        lastPaged: detailLast.__paged || '',
        lastPages: detailLast.__pages || 0,
        lastCount: detailLast.length
      },
      ty: { defs: HT.TYPE_DEFS, nums: typeNums, sum: typeSum, units: typeUnits, dwelling,
        dwellingUnits, shareSrc: shareOk ? 'platform' : 'calc' },
      yoy: {
        curTeam, curTruck, curPerson, lastTruck, truckRep, truckYoy, truckYoyTxt,
        dCyoyTxt, dCyoyDir: dYoyCdir,
        dCyoyAll: dYoyAll, dCyoyAllDir: dYoyAllDir, dCyoyAllTxt,
        coreYoy, coreYoyTxt, lCoreN, lastMiss, lastErr: lastErr || ''
      }
    });
  }

  /**
   * 主流程。
   * @param {{now?:Date, cfg?:object, onProgress?:Function}} opts
   * @returns {Promise<{items:Array, checks:Array, summary:object, meta:object, window:object,
   *                    repaint:Function}>} repaint(cfg, win) 用同一批数重新成文
   */
  /**
   * 跑**一套**模板：一种周期、一个窗口、一份数据。
   *
   * （1.13.0）一个组合一次出稿：组合自带周期，所以这里只需要一种窗口。
   * 「周报也报当日」是**周组合自己**带着那几段，不再靠"周方案接日套件"。
   *
   * @param {object} opts  run 的入参（now / onProgress / …）
   * @param {object} combo 这一期是哪个组合：{id, name, period, tpls}
   * @param {object} base  normalize 过的配置（period 已由 run 定成主周期）
   */
  async function runOne(opts, combo, base) {
    const o = opts || {};
    const now = o.now || new Date();
    /* 周期跟着**组合**走：每个组合从头到尾按一种窗口取数，
       改成"段落各带周期"会让同一份稿子里出现两种口径的日期说法。 */
    const period = combo && combo.period === 'week' ? 'week' : 'day';
    /* period 必须写回 cfg：字段按它算窗口，校验措辞也读它。
       少写这一句的表现是「点了每周，出来的还是日报那四段」。 */
    const cfg = base.period === period ? base
      : HT.normalizeCfg(Object.assign({}, base, { period }));
    /* 按 id 在归一化后的配置里重新取一次组合：base 可能是旧对象，
       而 repaint 要用归一化后的那份正文。组合被删了才用传进来的那份。

       **必须走 combosAll**（1.14.0）：存储里的组合只有 `ids`，正文在库里。
       直接 `cfg.combos.filter(x => x.id === gid)` 拿到的是 raw，没有 `tpls`，
       buildSegments 那边的兜底会静默退回出厂模板——现场就是「标题栏切到周、
       设置里周报只接了两段，面板却出来日的四段」（2026-11-27 用户报的）。 */
    const gid = combo && combo.id;
    const all = (gid && HT.combosAll) ? HT.combosAll(cfg) : [];
    const g = (gid && all.filter(x => x.id === gid)[0]) || combo;
    const W = HT.buildWindows(now, cfg, period);
    /* 段落 = 这一组模板里打开的那几段；模板内容用不到的数据源不会被请求 */
    const segs = HT.buildSegments(cfg, g);

    /* 1. 取数计划 */
    const need = Object.create(null);
    segs.forEach(sg => {
      sg.needs.forEach(k => { need[k] = true; });
    });

    /* want 只声明该源最核心的段：required 缺了整份不出，optional 缺了记一条给人看。
       以前这里是"取回来直接用"，平台改版后被 num() 兜成 0，生成一份数字全错的文稿。 */
    /* 下面的数据源名一律写「本期 / 去年同期」：日周期下它们是当日与去年同日，
       周周期下是本周与去年同周——同一个源、同一个窗口变量（W.DAY / W.LAST），
       只是这一段有七天。写死「当日」会让周报的进度条和红框读起来像取错了范围。 */
    const SOURCE = {
      ytdA: {
        label: '今年以来 · 火灾扑救',
        want: { required: ['JQ_01', 'JQ_04', 'HZ_01'] },
        /* types 只拉用得到的块（1 记录 / 2 处置 / 3 条目）。全拉是 60 段，
           而这份只要 JQ + HZ 共 51 段。块给少了 want.required 会明确报"缺少段落"，
           不会静默出错误稿——所以这层是按段收紧的，不是按省流量收紧。 */
        types: '1,3',
        run: src => HT.fetchReport(W.YTD, null, src.label, src.types, src.codes)
      },
      ytdB: {
        label: '今年以来 · 成灾火灾',
        want: { required: ['HZ_01'] },
        /* 只要一个有效数，拉条目那块就够：60 段 → 21 段 */
        types: '3',
        run: src => HT.fetchReport(W.YTD, 0, src.label, src.types, src.codes)
      },
      dayA: {
        label: '本期 · 接处警',
        want: { required: ['JQ_01', 'JQ_04', 'HZ_01'], optional: ['CD_01'] },
        /* JQ_04 必须在 want 里：正文的「当日一类」优先取它（dJf），HZ_01 只是兜底。
           它以前一直没写进 want，等于"缺了也不知道"，靠的是整块返回碰巧带着。
           四段散在三块（JQ_01+JQ_04 / CD_01 / HZ_01），块这一层收不动；
           真正的收紧靠 paragraphName 只点这四段：60 段 → 4 段。 */
        types: '1,2,3',
        run: src => HT.fetchReport(W.DAY, null, src.label, src.types, src.codes)
      },
      dayB: {
        label: '本期 · 火灾统计',
        want: { required: ['HZ_01'], optional: ['HZ_21'] },
        /* 有效数 + 条目类型构成，两块都在条目那个块里：60 段 → 21 段 */
        types: '3',
        run: src => HT.fetchReport(W.DAY, 0, src.label, src.types, src.codes)
      },
      /* 当日 / 去年同日的处置：取综合查询那一行（一类口径）。
         为什么不再取报表 `CD_01`：它是任务单口径、按日结汇总，与综合查询是两套账
         （同一窗口实测报表 140 车次 / 813 人次，页面 142 / 827，差的是补录），
         而使用者核对的是综合查询页面。取数换源，口径不变——
         这句讲的是条目，所以取「其中一类」那一类，**不是全记录**
         （全记录处置是它的 2~3 倍，配不上句首的「有效条目 N 起」）。
         `CD_01` 降为兜底：汇总取不到时正文退回报表，不阻断出稿。 */
      dayHf: {
        label: '本期 · 综合查询·火灾扑救出动',
        head: true, fireOnly: true,
        run: src => HT.fetchHead(W.DAY, src.label, { fireOnly: true })
      },
      /* 同比的基期：同一个接口、同一个口径，只换窗口。
         以前基期取报表 `CD_01` 的去年同日车次——那一半是任务单口径，
         于是"同比"本身跨了两个口径。现在两端同源。 */
      lastHf: {
        label: '去年同期 · 综合查询·火灾扑救出动',
        head: true, fireOnly: true,
        run: src => HT.fetchHead(W.LAST, src.label, { fireOnly: true })
      },
      /* 去年年初至今的有效数：只给「有效条目同比」当分母。
         取的是平台上的实数，不再维护一张手工月度表——2025 年那个"补录前/补录后"
         的差是补录造成的特例，不为它给每年都建一份账。取不到就退回「同比x」。 */
      ytdLast: {
        label: '去年同期 · 成灾火灾',
        want: { required: ['HZ_01'] },
        types: '3',
        run: src => HT.fetchReport(W.YTDL, 0, src.label, src.types, src.codes)
      },
      /* 综合查询的汇总行（五类 + 处置 + 总数）。它是正文里「共接处警 X 起」
         「其中一类 Y 起」这些数的取值来源——页面上那一行就是这个数。
         一次请求，limit=1，只读汇总不取行。 */
      ytdH: { label: '今年以来 · 综合查询汇总', head: true, run: src => HT.fetchHead(W.YTD, src.label) },
      detD: { label: '本期 · 成灾明细', detail: true, run: src => HT.fetchDetail(W.DAY, src.label) },
      detL: { label: '去年同期 · 成灾明细', detail: true, run: src => HT.fetchDetail(W.LAST, src.label) },
      /* 去年同周的有效有效数 —— 只给「本周有效同比」当分母（补录前那件事
         在 buildContext 里判：表能覆盖就用表，覆盖不到才用这里实查的数）。
         模板里没有那句同比时这个请求根本不发，与其他源一样按需。 */
      weekLast: {
        label: '去年同期 · 成灾火灾',
        want: { required: ['HZ_01'] },
        types: '3',
        run: src => HT.fetchReport(W.LAST, 0, src.label, src.types, src.codes)
      }
    };
    /* 每源要哪几段 = want 里点名的那些（required + optional），不另写一份清单。
       以前 types 与 want 就是这么漂开的：块声明得比实际要的宽，请求照块走，
       整块 30/9/21 段全部现算回来，最后只留两段。按 want 推，改 want 就自动跟着改，
       也不会出现"want 点名了 A、请求却没要 A"这种只在运行时才发现的错。
       没有 want 的源（汇总行、明细）不参与——它们本来就不是按段取的。 */
    Object.keys(SOURCE).forEach(k => {
      const w = SOURCE[k].want;
      if (w) SOURCE[k].codes = (w.required || []).concat(w.optional || []);
    });
    /* 「今年以来」的数一取，正文那句「共接处警 X 起」就要用综合查询口径，
       否则同一份稿子里出现两个总数。所以这两个需求绑在一起。 */
    if (need.ytdA) need.ytdH = true;
    /* 「有效同比」的分母（去年年初至今的有效数）**不跟着有效数一起取**：
       它是一个独立请求，而模板里没写那句话时，这个数一次都用不上。
       需要它的地方在字段层声明（ph.yoyCSen → ytdLast，「每日记录数据」的 needs 里也有），
       由 needs 汇总出来，跟别的源一样按需。
       更进一步：**如果手工月度表已经能给出这一年的数（2025 特例），就不发这个请求**——
       表里的补录前数才是该用的那个，查回来也用不上。 */
    /* 表能覆盖就不查系统：省一个请求，也避免"两套数并存时用错那个"。 */
    if (need.ytdLast && HT.lastYearCas && HT.lastYearCas(W.base) !== null) {
      delete need.ytdLast;
    }
    /* 周报的有效同比同理：去年那一年的月度表能按天折算出「去年同周」，
       就不必再去平台上把同一段查回来——查回来的还是补录后的数，用不上。 */
    if (need.weekLast && HT.lastYearCasBetween
      && HT.lastYearCasBetween(W.LAST.s, W.LAST.e) !== null) {
      delete need.weekLast;
    }
    const plan = Object.keys(SOURCE).filter(k => need[k]);
    /* 曾经试过"兜底报表改成按需补发"（汇总认得出就不发 ytdA），结论是不成立，已回退：
       正文的记录数与处置之所以敢写，靠的就是**汇总与报表两套账互相印证**——
       起数 0.5%、处置 25% 两道闸门都是"拿报表值卡汇总值"。报表不发，闸门就没有对照，
       trust() 会直接放行汇总，字段认错也没人拦。离线用例当场撞出这个问题
       （"处置差 30% 时退回报表"失去前提）。省一条请求，赔掉交叉校验，不划算。 */
    const total = plan.length + 1;
    let stepI = 0;
    const step = label => {
      stepI++;
      try { if (o.onProgress) o.onProgress(stepI, total, label); } catch (e) { }
    };

    /* 2. 取数（并发 3）
       这些数据源彼此独立：各有各的窗口、各有各的筛选，谁也不等谁的结果。
       串行 await 等于把单请求时延乘上请求条数——线上实测一次出稿 74 秒，
       其中九成时间是在等前一个请求回来。
       并发上限取 3：目标服务同时接太多请求反而更慢，
       而 3 已经能把 10 个请求压成 4 轮。
       并发只改"什么时候取"，不改"取不到时说什么、还出不出稿"——后者仍按
       plan 顺序在执行完那一段里统一处理。 */
    /* 取回时刻（HH:MM）。平台上同一窗口的记录会被补填、改等级、改状态——
       2026-11-16 实测：奉节一条有效记录在 26 分钟内从「13:30 / 非轻微 / 待填报 /
       三项全空」改成「13:25 / 轻微 / 已审核 / 800 元 10 ㎡」。所以核稿时拿新数据
       对不上，很多时候差的是时刻而不是算法。校验栏右侧标出这一刻，只说时间、
       不进正文：正文是给上报用的，不带这种内部信息。 */
    const clock = () => {
      const d = new Date();
      return (d.getHours() < 10 ? '0' : '') + d.getHours() + ':'
        + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes();
    };
    const D = {};
    const notices = [];
    const reqStart = HT.requestCount();
    const slowOne = { k: '', ms: 0 };   // 最慢的那一条，只给诊断用，不进正文
    /* 每源耗时。只有整轮时长时，"35 秒"到底是三条各 12 秒、还是一条 33 秒
       拖着三条 1 秒，结论完全相反——前者该提并发，后者只能靠缓存与渲染时机。
       所以这一项与 slowOne 一起记，只写源名与毫秒，不含任何业务数字。 */
    const times = Object.create(null);
    let lastErr = '';
    let lastCasErr = '';
    const CONC = 3;
    const done = Object.create(null);          // k -> { got } | { err }
    /* 跑一批。批内并发 3，批与批串行——第二批要不要跑，取决于第一批里的汇总。 */
    const drain = async list => {
      let cursor = 0;
      const worker = async () => {
        while (cursor < list.length) {
          const k = list[cursor++];
          step(SOURCE[k].label);
          const tOne = Date.now();
          try { done[k] = { got: await SOURCE[k].run(SOURCE[k]) }; }
          catch (e) { done[k] = { err: e }; }
          /* 记下最慢的那一条。诊断日志里 GEN-DUR 一直只有总数
             （四天 31 次出稿，30～50 秒），知道"慢"却不知道"哪条慢"——
             而整轮时长基本等于最慢那条，改错了地方等于白改。
             只记 key（英文标识），不记耗时以外的东西。 */
          const dtOne = Date.now() - tOne;
          times[k] = dtOne;
          if (dtOne > slowOne.ms) { slowOne.ms = dtOne; slowOne.k = k; }
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONC, list.length) }, worker));
    };
    await drain(plan);

    /* 失败怎么处置：顺序与串行时完全一致，避免"并发之后提示顺序乱跳"。 */
    const fail = (k, e) => {
      const src = SOURCE[k];
      /* 去年同日只影响同比措辞，不阻断主流程；结构变更也要在 notices 里说出来，
         否则"去年数据缺失"会被当成正常降级，掩盖了接口改版 */
      /* 汇总只是"让正文与页面对得上"，取不到就退回报表数，
         不能让一次取数把整份稿子拦下。 */
      if (k === 'ytdH') {
        D[k] = null;
        notices.push('综合查询汇总取不到，正文警情数退回报表口径');
      } else if (k === 'dayHf' || k === 'lastHf') {
        /* 处置只是"让数与页面那一行对得上"，取不到退回报表兜底 / 缺省措辞，
           不能让一次汇总失败把整份稿子拦下。 */
        D[k] = null;
        notices.push(k === 'dayHf'
          ? '本期出动汇总取不到，退回报表口径'
          : '去年同期出动汇总取不到，同比按缺失处理');
      } else if (k === 'ytdLast') {
        /* 同比的分母：取不到只让正文退回「同比x」，拖住整份稿子没有道理 */
        D[k] = null;
        lastCasErr = HT.errFact(e);
      } else if (k === 'weekLast') {
        /* 去年同周的有效数：取不到时 buildContext 会退回平台那一列同比，
           所以这里只在 notices 里留一句，不拦稿子、也不改口径。 */
        D[k] = null;
        notices.push('去年同周成灾数取不到，本周成灾同比退回平台口径');
      } else if (k === 'detL') {
        /* 只在 notices 里露头，读着要像一句话：带数据源前缀、不带短码。
           短码是给维护人员的，红框里出现才有意义。 */
        lastErr = HT.errFact(e);
        D[k] = [];
        if (e && e.kind === 'SCHEMA') notices.push(lastErr);
      } else {
        /* 不在这里拼「数据源：」——fetchReport / fetchDetail 出口已经打过 source 标签，
           再拼一次就会出现「当日 · 条目统计：当日 · 条目统计：…」。
           这里只补一种情况：异常不是我们造的（原生 TypeError 之类），
           也得带上来源，否则红框里只剩一句 "x is not a function"，无法定位是哪条数据源。 */
        if (e && !e.source) e.source = src.label;
        throw e;
      }
    };

    const handle = k => {
      const src = SOURCE[k];
      const r = done[k];
      try {
        if (!r) throw HT.err('DATA', `${src.label}：没有执行`);
        if (r.err) throw r.err;
        const got = r.got;
        if (src.head) {
          /* 汇总对象整体可能在、但字段名一个都没认到；那也算"取到了"，只是没用。
             这里不拦——拦下来会让整份稿子出不来，而退回报表数照样能写。 */
          if (!got || typeof got !== 'object') throw HT.err('DATA', '综合查询汇总没返回');
          D[k] = got;
        } else if (src.detail) {
          HT.assertDetail(got, src.label);
          D[k] = got;
        } else {
          const v = HT.assertReport(got, src.want, src.label);
          (v.notices || []).forEach(n => notices.push(n));
          D[k] = got;
        }
      } catch (e) {
        fail(k, e);
      }
    };
    plan.forEach(handle);

    step('交叉校验并成文');

    /* 3. 事实 + 4. 成文与校验 */
    const c = buildContext(D, need, cfg, W, lastErr, lastCasErr);
    const items = segs.map(sg => ({ i: sg.i, key: sg.key, label: sg.label, text: sg.render(c) }));
    const checks = HT.buildChecks(c, need);
    /* 附注（note）不参与判定：它陈述口径事实（比如本期有几条待填报），
       不是要人处理的问题。算进 total，「N 项全部通过」里就混着一条没被判定过的东西。 */
    const judged = checks.filter(x => !x.note);
    const failed = judged.filter(x => !x.ok).length;

    /**
     * 用**同一批数**重新成文（设置页点了保存时走这条）。
     *
     * 为什么不是再跑一次 run()：设置里的单位名、并区域、勾选的原因、手填的两句，
     * 改的都是"怎么把话说出来"，不是"拿到了什么数"。重跑要再拉八个数据源、
     * 等四十多秒，而这一版的数就在 D 里躺着——重算 c 和 items 就行。
     *
     * W 也允许换：截点/基准时间本来就在设置页，改了日期句子里的"截至…"要跟着走。
     * D 不动，所以 numbers 一个都不变；变的只有措辞与取哪几个数。
     *
     * @param {object} [newCfg] 保存后的配置
     * @param {object} [newW]   按新配置重算的时间窗（不传就沿用这一次的）
     */
    function repaint(newCfg, newW) {
      const cfg2 = HT.normalizeCfg(newCfg || cfg);
      /* 周期不跟着 repaint 换：D 里的数是按**这一轮那个窗口**取回来的，
         换周期＝换窗口，必须重新取数（面板切周期走的就是完整 run）。
         这里把两处钉回同一个周期，免得出现"用本周的数、套日报的模板"。 */
      if (cfg2.period !== cfg.period) cfg2.period = cfg.period;
      const c2 = buildContext(D, need, cfg2, newW || W, lastErr, lastCasErr);
      /* 段落序列**必须按新模板重建**。以前这里直接用闭包里的 segs——那是这一轮
         取数时的段落表，设置里调了顺序、增删了段落、改了标题、关了某一段，
         它一样都不知道。表现是"调完顺序点保存，稿子一动不动"，看着像保存没生效，
         其实配置早就存进去了。重建只改"怎么排、怎么写"，D 里的数一个都不动。
         重建要**按组合 id**取（不是按周期）：cfg2.period 可能刚被切走，
         照它取会把周组合重建成日组合。组合被删了才落到同周期第一个。
         新模板若引用了这次没取的字段，buildContext 拿不到就会留空并在校验里报出来——
         要真补数得点一次生成，那是另一件事，这里不假装能替它做。 */
      const segs2 = HT.buildSegments(cfg2, gid);
      const it = segs2.map(sg => ({ i: sg.i, key: sg.key, label: sg.label, text: sg.render(c2) }));
      const ck = HT.buildChecks(c2, need);
      const judged2 = ck.filter(x => !x.note);
      const bad = judged2.filter(x => !x.ok).length;
      return {
        items: it,
        checks: ck,
        summary: {
          total: judged2.length, passed: judged2.length - bad, failed: bad,
          notes: ck.length - judged2.length, at: clock()
        }
      };
    }

    /* ── 报表互校（后台跑，出稿不等它） ────────────────────────────
       报表统计按区域档能自己算出同一个自然日的有效起数与中心城区起数，
       和上面这套明细账是两条独立的路。对上了，这一期就多一层保障；
       对不上，说明有一边的筛选或口径出了问题。

       为什么校「前一个自然日」而不是当日窗口：当日是 18:00→17:59:59，
       跨两个自然日，而报表按自然日结算，逐位比不了。挑一个已经结完账的整日，
       两个模块才站在同一把尺子上。

       返回 Promise 而不在这里 await：调用方（panel）拿到就撒手，
       回来再往校验栏补一行。失败只记遥测，绝不影响已经出好的稿子。 */
    const crossOf = () => {
      const e0 = W.DAY.e;
      const day = new Date(e0.getFullYear(), e0.getMonth(), e0.getDate() - 1);
      const win = {
        s: new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0),
        e: new Date(day.getFullYear(), day.getMonth(), day.getDate(), 23, 59, 59)
      };
      const dayText = `${day.getMonth() + 1}-${HT.pad(day.getDate())}`;
      return Promise.all([
        HT.fetchDetail(win, '报表互校 · 明细'),
        HT.fetchReportCross(win, '报表互校 · 报表')
      ]).then(res => {
        const rows = res[0] || [];
        const rpt = res[1] || {};
        const maj = rows.filter(x => x.severity === '非轻微火灾' && !isPending(x));
        let rptCore = 0;
        const by = rpt.byTown || {};
        Object.keys(by).forEach(n => { if (isCore(n)) rptCore += by[n]; });
        return HT.reportCrossCheck({
          dayText,
          detMajor: maj.length,
          detCore: maj.filter(x => isCore(townOf(x))).length,
          rptTotal: rpt.total || 0,
          rptCore,
          pending: rows.filter(x => isPending(x)).length
        });
      });
    };

    return {
      items,
      checks,
      summary: {
        total: judged.length, passed: judged.length - failed, failed,
        notes: checks.length - judged.length, at: clock()
      },
      /* 这一套的计划步数：多套时外层拿它把下一套的 1/N 接成 N+1/N+M，
         进度条才不会走到一半又退回起点。 */
      steps: total,
      repaint,
      /* 报表互校的入口：一个 Promise 工厂，调用方自己决定何时触发 */
      cross: crossOf,
      window: {
        passed: W.passed,
        /* 这一轮是哪种周期。面板换按钮、导出取窗口、meta 那两行提示都读它，
           不再各自去猜。 */
        period,
        day: [HT.fmtTime(W.DAY.s), HT.fmtTime(W.DAY.e)],
        /* 本周（周周期下与 day 相同）。导出与面板都用 day，留着这个只为
           「想明确说本周」的地方不必再判周期。 */
        week: [HT.fmtTime(W.WEEK.s), HT.fmtTime(W.WEEK.e)],
        ytd: [HT.fmtTime(W.YTD.s), HT.fmtTime(W.YTD.e)],
        ytdLast: [HT.fmtTime(W.YTDL.s), HT.fmtTime(W.YTDL.e)],
        last: [HT.fmtTime(W.LAST.s), HT.fmtTime(W.LAST.e)]
      },
      meta: {
        requests: HT.requestCount() - reqStart,
        sources: plan.slice(),
        notices,
        anchor: W.anchor,
        /* 最慢的数据源（key + 毫秒）。诊断日志只报"这一轮 40 秒"时，
           分不清是报表慢、明细翻页慢，还是某一支超时重试；
           整轮时长基本等于最慢那条，所以这一项才是该看的东西。 */
        slow: slowOne.k ? { src: slowOne.k, ms: slowOne.ms } : null,
        /** 每源耗时（key → 毫秒）。见上方 slowOne 处的说明 */
        times: times,
        /** 这一轮用的并发度：调过之后，日志里的时长才比得出效果 */
        conc: CONC,
        /* 校验不过的项目只留 **key**（`det.town`），不留 detail。
           detail 是"区域加总 123，有效 551"这种人话，含数字；而这份记录存在的
           意义就是"能截图发出去"——数字一进来，截图就不能外发了。
           拿着 key 去 checks.js 与 data/faq.js 的 CHECK_DOCS 一查，什么都知道。
           记什么由这里决定，怎么显示由 ui 决定，怎么写进本机由 lib/obs.js 决定。

           2026-11-16 加 `:level`：只发 key 时，"差得离谱"与"认不全"在日志里长得
           一模一样——四天 77 份上报里 17 条 `ytd.head`，全是同一个字符串，
           分不出哪条该去查接口、哪条本来就是降级。level 是枚举（bad/warn），
           不含任何数字，加了不影响脱敏。 */
        obs: checks.filter(x => !x.ok).map(x => ({
          code: 'CHK-FAIL', mod: 'checks', fact: x.key + ':' + (x.level || 'bad')
        })),
        facts: Object.assign({}, c.ytd, c.day, {
          note: '未展开',
          detailCount: c.det.count, townSum: c.det.townSum, typeSum: c.ty.sum,
          nMajor: c.det.nMajor, nMinor: c.det.nMinor,
          nCore: c.det.nCore, nCoreMajor: c.det.nCoreMajor, nCoreMinor: c.det.nCoreMinor,
          causeSum: c.det.causeSum, caused: c.det.caused,
          curTruck: c.yoy.curTruck, curPerson: c.yoy.curPerson, lCoreN: c.yoy.lCoreN
        })
      }
    };
  }

  /**
   * 一轮出稿。按**文稿方案**接起若干片段组（周方案默认 = 周套件 + 日套件）：
   * 每组一个 runOne，各取各的窗口、各用各的模板，最后把段落合在一份稿子里。
   *
   * 合并规则：
   *   · 段落按方案里组的顺序排，组内按组自己的顺序，i 重编号；
   *   · 段落的 key 加上**组 id** 前缀（'g-week/t1'）。两组的模板可能撞 id
   *     （都是 s1、s2），不前缀化的话，设置页调完顺序重新成文时，
   *     "手改过的那段"会按 key 对到另一组的段上去；
   *   · 校验只取**方案里第一组**：不同组的窗口不同，把两份校验摞在一起
   *     会出现同一个 key 两个结论。其余组的段不参与核对——导出与正文
   *     仍然齐全，只是核对结论只覆盖第一组。
   */
  async function run(opts) {
    const o = opts || {};
    const base0 = HT.normalizeCfg(o.cfg);
    const period = (o.period || base0.period) === 'week' ? 'week' : 'day';
    const cfg = period === base0.period ? base0
      : HT.normalizeCfg(Object.assign({}, base0, { period }));
    /* 一次出稿只有一个组合（1.13.0）：组合自带周期，所以没有"两套窗口"
       这件事了，「周报也报当日」是周组合自己带着那几段。 */
    const combo = HT.comboOf(cfg, period);
    const reqStart = HT.requestCount();
    const r = await runOne(o, combo, cfg);
    const cid = (combo && combo.id) || '';
    /* key 前缀用**组合 id**：同一份段文字可能在日、周两个组合里各有一份，
       前缀相同的话面板重建时会拿错那一份。 */
    r.items.forEach(it => { it.set = period; it.gid = cid; it.key = cid + '/' + it.key; });
    r.meta.requests = HT.requestCount() - reqStart;
    r.meta.sets = HT.setsOf(cfg, period);
    r.meta.combo = cid;
    /* meta.groups 这个名字（1.12.x 留下的）读的人已经没有了，
       但诊断日志按它写过几版，留个别名不再多一层字段。 */
    r.meta.groups = cid ? [cid] : [];
    return r;
  }

  Object.assign(HT, { run, buildContext });
})(typeof window !== 'undefined' ? window : globalThis);
