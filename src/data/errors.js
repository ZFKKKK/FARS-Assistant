/**
 * src/data/errors.js —— 全项目唯一的错误字典
 *
 * @layer  data（数据层）
 * @file   src/data/errors.js
 * @since  0.19.2
 *
 * 为什么单独抽一份：
 *   0.19 之前，同一件事有三种说法并存。以"登录失效"为例——
 *     http.js   抛 `登录状态已失效，请刷新页面重新登录`
 *     panel.js  状态栏写「登录已过期」、标题写「登录状态已失效」、处置写「刷新页面重新登录后再用。」
 *     FAQ       又写「提示"登录已过期，请刷新页面"」
 *   一处改动，另外两处不会跟着改，于是文档教人认的字，界面上永远找不到。
 *   更糟的是 data 层在讲"请刷新页面"——那是处置动作，不是事实；同一个错误里
 *   数据层和界面层各喊一遍"怎么办"，遇到超时还会互相打架（界面说"查网络"，
 *   实际是某一条查询在服务端挂了，网络好得很）。
 *
 * 所以定死三层分工：
 *   数据层  只说**事实**：什么错了、错在哪条数据源、状态码多少。禁用「请/重试/刷新/检查」。
 *   字典    决定**怎么说**：短名（状态栏）、标题、处置、要不要印原始描述。
 *   界面层  只做**渲染**：errInfo / errHTML / errLine，不许自己拼错误文案。
 *
 * 五条规矩（verify 有断言兜着，改文案前先读这里）：
 *   1. 错误对象的 message 只是事实，形如 `<数据源>：<发生了什么>`，全角冒号，句尾不加句号。
 *      数据源前缀由 err() 统一加，调用方不许自己拼。
 *   2. 状态栏短名 ≤6 字、不带标点。它和图标抢同一行，多一个字就把名字挤掉。
 *   3. 每个 kind 有稳定的英文短码。报障时复制那一行就够，不必描述界面长什么样。
 *   4. 只有 SCHEMA / NET-* / DATA / STORE / UNKNOWN 印原始描述；PAGE / AUTH 不印——
 *      它们的原因对使用者没有信息量，印出来只是噪音。
 *   5. 未知错误不许冒充「数据不完整」。以前 catch 里默认落到 DATA，于是"扩展自己崩了"
 *      被说成"接口缺数字"，照着这个提示去查报表，永远查不到。
 */
(function (g) {
  'use strict';
  const HT = (g.__HT = g.__HT || {});

  /**
   * 九类错误。字段含义：
   *   code    稳定短码，报障行开头就是它，便于检索与对文档
   *   foot    状态栏短名（≤6 字）
   *   title   红框标题：一句话说清"哪一层坏了"
   *   tip     处置：只说接下来的动作，不解释原理
   *   detail  是否把 `短码｜数据源：事实` 印在红框第三段
   *   retry   自动重试是否有意义（AUTH/SCHEMA/超时都不值得再等一轮）
   *   tone    ok=可以重试｜warn=要人核对｜bad=没救，必须报修
   */
  const CARD = {
    /* 页面文档还在加载。和"没登录"分开：一个等两秒就好，一个要刷新重登。 */
    PAGE: {
      code: 'PAGE-NOTREADY',
      foot: '页面未就绪',
      title: '页面还没加载好',
      tip: '统计系统的数据还没出来。等两三秒再点一次生成；一直这样按 F5 重载页面。',
      detail: false, retry: true, tone: 'ok'
    },
    AUTH: {
      code: 'AUTH-401',
      foot: '登录已过期',
      title: '登录状态已失效',
      tip: '刷新页面重新登录。登录后三秒内面板自己恢复，不用关掉再开。',
      detail: false, retry: false, tone: 'warn'
    },
    /* 超时与"连不上"必须分开：前者是等够了没人应答，后者是压根没发出去。
       0.19 之前两者共用一句「网络不通」，把服务端单条查询挂住说成网络问题，
       换网络、找网管全做了一遍才发现不是那回事。 */
    NET_TIMEOUT: {
      code: 'NET-TIMEOUT',
      foot: '接口超时',
      title: '有一条数据源没回话',
      /* 不写死秒数：明细等 20 秒、报表等 60 秒（见 contract.js 的 POLICY），
         具体等了多久印在下面那行事实里（"60 秒内未返回"）。 */
      tip: '等了一段时间仍没有返回，已经放弃，不会重试。过一会儿再点一次；反复这样把这行发给维护人员。',
      detail: true, retry: false, tone: 'warn'
    },
    NET_DOWN: {
      code: 'NET-UNREACH',
      foot: '连不上',
      title: '连不上统计系统',
      tip: '页面能打开说明网络本身是通的，多半是代理、安全软件或另一个扩展拦了扩展发出的请求。换网络或找网管放行后重试。',
      detail: true, retry: true, tone: 'warn'
    },
    NET_STATUS: {
      code: 'NET-5XX',
      foot: '服务端报错',
      title: '统计系统返回了错误',
      tip: '这是服务端的问题。短暂抖动会自动再试一次；持续这样把这行发给维护人员。',
      detail: true, retry: true, tone: 'bad'
    },
    SCHEMA: {
      code: 'SCHEMA-DRIFT',
      foot: '数据源已改版',
      title: '数据源结构变了',
      tip: '统计系统改版，查询结果与页面已经对不上号。这次没有生成简报，请先手工查询上报，再把下面这行发给维护人员。',
      detail: true, retry: false, tone: 'bad'
    },
    DATA: {
      code: 'DATA-MISS',
      foot: '数据不完整',
      title: '数据不完整',
      tip: '接口有返回但缺关键数字。查截点时间是否设错、当天数据是否已录入系统，然后重试。',
      detail: true, retry: true, tone: 'warn'
    },
    /* 读不到用户档案（模板、区域、字号）。这时候绝不能拿出厂配置假装正常——
       那等于替人改稿；更不能把空配置写回存储，会清掉别的用户。 */
    STORAGE: {
      code: 'STORE-READ',
      foot: '配置读不到',
      title: '浏览器存储读不到',
      tip: '没能读到本机保存的模板与用户档案。关掉面板重新打开，一直这样重启浏览器。此时不要保存设置。',
      detail: true, retry: false, tone: 'bad'
    },
    /* 兜底。绝不能落到 DATA——那会把"扩展自己坏了"说成"接口缺数字"。 */
    UNKNOWN: {
      code: 'ERR-UNKNOWN',
      foot: '未归类错误',
      title: '出现了没归类的错误',
      tip: '这是没预料到的情况。把这行发给维护人员；也可以先重新生成一次试试。',
      detail: true, retry: false, tone: 'bad'
    }
  };

  const KINDS = Object.keys(CARD);

  /* ── 更新检查：四种失败 + 三种不可用状态 ────────────────────────────
     为什么不塞进 CARD：CARD 的契约输入是 Error（errInfo / errHTML 都读 e.kind），
     而版本检查从不抛错——它返回一个"这次没查到"的普通对象。硬塞进去，
     每条渲染路径都得先伪造一个 Error。

     为什么必须放在这份文件里：它和 CARD 是同一类东西——**决定人下一步做什么**
     的那句话。上一版把它写在 settings.js 里就地拼，于是同一件事有四种说法
     （"这次没查到""没查到""清单异常""Failed to fetch"），使用说明承诺的
     "后面会跟一句具体原因"变成了浏览器英文原话。这正是 0.19 定下
     "全项目唯一字典"时要根治的病，只是当时漏了更新这一类。

     字段与 CARD 同形，少 tone / retry（这里没有"重试有没有意义"之外的决策）：
       foot    状态栏 / 设置页那一格用的短名（≤4 字）
       title   一句话说清哪一段断了
       tip     接下来能做什么；找不到能做的事就直说"属于发行方问题"
       detail  是否把短码 + 原始描述印出来。只给 http / format——
               状态码和"清单缺 version"是有效信息，"Failed to fetch" 不是。 */
  const UPD = {
    off: {
      code: 'UPD-OFF', foot: '未开启', title: '更新检查已关闭',
      tip: '这一版把自动检查关掉了（release.update.enabled）。版本号在上面随时能看到，要更新就点「检查更新」。',
      detail: false
    },
    nofeed: {
      code: 'UPD-NOFEED', foot: '未配置', title: '这份包没带更新地址',
      tip: '属于打包发行的问题，不是你机器的事。查询与生成不受影响；把这行告知维护人员。',
      detail: false
    },
    unreach: {
      code: 'UPD-UNREACH', foot: '连不上', title: '连不上更新服务器',
      tip: '请求没发出去。多半是代理、安全软件或另一个扩展拦了，也可能是服务器没开；换网络或请网管放行后再试。',
      detail: false
    },
    timeout: {
      code: 'UPD-TIMEOUT', foot: '无响应', title: '更新服务器没回话',
      tip: '等够了仍没有返回，已经放弃，不会自动重试。过一会儿再点一次；持续这样把这行发给维护人员。',
      detail: false
    },
    http: {
      code: 'UPD-HTTP', foot: '服务器报错', title: '更新服务器返回了错误',
      tip: '这是服务器那一侧的问题，不是本机网络。稍后再试；持续这样把这行发给维护人员。',
      detail: true
    },
    format: {
      code: 'UPD-FORMAT', foot: '清单异常', title: '更新清单格式不对',
      tip: '拿到的不是有效清单，可能服务器返回了错误页或漏了版本号。本次不会提示版本，属于发行方问题。',
      detail: true
    },
    /* 清单里写了 enabled:false。维护方主动止血用的：某一版发出去发现有问题，
       把清单改成 false 就能让所有机器"查得到、但不提示更新"，
       不必再发一版扩展来关开关。 */
    paused: {
      code: 'UPD-PAUSED', foot: '已暂停', title: '维护方暂停了版本推送',
      tip: '不是你这台机器的问题，也不影响出稿。等维护方把清单改回来，下次检查会自己恢复。',
      detail: false
    },
    nobg: {
      code: 'UPD-NOBG', foot: '扩展未响应', title: '扩展后台没有响应',
      tip: '扩展可能刚被浏览器回收或正在重载。等两秒再点一次；一直这样按 F5 重载页面。',
      /* 细节和标题是同一句话，再附一遍只是啰嗦；短码留在悬停提示里够报障了。 */
      detail: false
    }
  };

  /**
   * 成功时那几个词也只写一遍：设置页的格子、状态提示、诊断行共用。
   *
   * `ahead` 是第三种状态：分发源上的版本**比本机低**。它不能显示成"已是最新"——
   * 那句话和在「本机」那一栏并排时，会被读成"清单上那个号就是最新版"，
   * 两行字互相打架，而真实情况是这一版**还没发布**。查得到清单 ≠ 清单是新的。
   */
  const UPD_WORD = { same: '已是最新', newer: '有新版本', ahead: '分发源落后' };

  /* 下载结果的归类。
     Chrome 给的是 error 码（SERVER_FORBIDDEN / SAFE_BROWSING_V3_...），
     原样印出来没人看得懂，也没告诉人要做什么。所以按"该谁动手"归五堆：
     浏览器拦的、网络断的、磁盘写不进的、服务器拒的、人自己取消的。

     这一张表存在的直接原因：downloads.download 的回调只代表"浏览器接下了任务"，
     下载真正失败发生在回调之后。上一版拿到回调就报"已开始下载"，于是被拦下的
     下载表现为——下载气泡闪一下、然后什么都没有，用户说"点了没反应"。 */
  const DL = {
    blocked: {
      title: '浏览器拦下了这次下载',
      tip: '打开 chrome://downloads，点带红叉那一行的「保留」就能下完；或者点「复制地址」，粘到浏览器地址栏回车。'
    },
    network: {
      title: '下载中途断了',
      tip: '网络断了，或者服务器把连接关了。再点一次「获取安装包」；反复这样把这一行发给维护人员。'
    },
    disk: {
      title: '没能写进「下载」文件夹',
      tip: '磁盘满了、没有写权限，或被安全软件锁住。清一下空间或换个下载目录再试。'
    },
    server: {
      title: '服务器拒绝了这次下载',
      tip: '文件被删了或权限没给对，属于服务器那一侧。把这一行发给维护人员，先用「复制地址」验证一下。'
    },
    cancel: {
      title: '下载被取消了',
      tip: '如果是你自己点的取消，忽略这一行；不是的话再点一次「获取安装包」。'
    },
    other: {
      title: '下载没有完成',
      tip: '原因不明确。打开 chrome://downloads 看那一行写了什么，或点「复制地址」手动下载。'
    }
  };

  /** Chrome 的下载错误码 → DL 里的那一堆。顺序有讲究：FILE_BLOCKED 属于拦，不属于磁盘。 */
  function dlKind(err) {
    const s = String(err || '').toUpperCase();
    if (!s) return 'other';
    if (/SAFE_BROWSING|DANGEROUS|FILE_BLOCKED|FILE_SECURITY_CHECK|FILE_VIRUS/.test(s)) return 'blocked';
    if (/USER_CANCELED|USER_SHUTDOWN|^CRASH$/.test(s)) return 'cancel';
    if (/NETWORK_/.test(s)) return 'network';
    if (/^SERVER_/.test(s)) return 'server';
    if (/^FILE_/.test(s)) return 'disk';
    return 'other';
  }

  /**
   * 把 background 报回来的下载结果折成两行字：一行进提示条，一行进悬停。
   * @param {{state:string,error?:string,filename?:string,bytes?:number}} m
   */
  function dlOut(m) {
    const o = m || {};
    const name = String(o.filename || '').split(/[\\/]/).pop();
    if (o.state === 'complete') {
      return {
        ok: true,
        text: '已下载' + (name ? '「' + name + '」' : ''),
        /* 这段是**给别人装的**时候唯一会看到的说明，所以两条路都要写全。
           只写"解压覆盖扩展目录"是在假设对方已经装过——新电脑上照这句话做，
           会去 Chrome 里选那个 zip，然后得到 `Could not unzip extension for install`，
           看着像包坏了。压缩包根上还有一份同样的「安装说明.txt」（发布脚本 生成），
           两条通道说同一件事。 */
        tip: '解压到一个固定目录（别放「下载」文件夹，清下载会把扩展删掉），然后看情况：\n'
          + '· 已经装过 → 把里面的「简报助手」覆盖到原扩展目录，再点「重新加载扩展」；\n'
          + '· 新电脑 → 打开 chrome://extensions，右上角开「开发者模式」，\n'
          + '  点「加载已解压的扩展程序」，选含 manifest.json 的那一层文件夹。\n'
          + '直接把 zip 选给 Chrome 会报 Could not unzip extension for install —— '
          + '它不接受压缩包，不是包坏了。同理：别改解压后的路径，扩展 ID 会跟着变。'
      };
    }
    const e = DL[dlKind(o.error)] || DL.other;
    return {
      ok: false,
      text: e.title,
      tip: e.tip + (o.error ? '\n错误码：' + o.error : '') + (name ? '\n文件：' + name : '')
    };
  }

  /**
   * 把 checkUpdate 的返回值折成"能直接渲染"的形状。UI 只认它，不再自己判 reason。
   *
   * 注意 ok 的判据是 reason === ''：查成功就是查成功，与"有没有新版本"无关。
   * 上一版这里靠 `latest || '—'` 兜底，清单返回 {} 时会显示「—（已是最新）」——
   * 服务器坏了却告诉所有人"天下太平"，是整条链路里唯一会主动骗人的分支。
   * 现在空清单在 release.js 里就被判成 format，到不了这里。
   *
   * @param {object} v checkUpdate 的返回值（也可以直接喂 updLast 里存的那条）
   */
  function updInfo(v) {
    const o = v || {};
    const reason = String(o.reason || '');
    const e = UPD[reason] || null;
    /* 本机比分发源新（这一版还没发布）。第一来源是 release.js 算好的 ahead；
        cmpVer 在 release.js 里、本文件比它先加载，只有**调用时**才拿得到，
        Node 里单独执行本文件时更是没有——所以它只是兜底，取不到就按"不知道"处理。 */
    const cmp = typeof HT.cmpVer === 'function' ? HT.cmpVer : null;
    const ahead = o.ahead === true || !!(cmp && o.latest && o.local &&
      cmp(String(o.latest), String(o.local)) < 0);
    return {
      reason: reason || 'ok',
      ok: reason === '',
      hasNew: !!o.hasNew,
      ahead,
      latest: String(o.latest || ''),
      notes: Array.isArray(o.notes) ? o.notes : [],
      url: String(o.url || ''),
      code: e ? e.code : '',
      foot: e ? e.foot : '',
      title: e ? e.title : '',
      tip: e ? e.tip : '',
      /* 原始描述只在这两类里有信息量；其余不给，免得界面上出现英文原话。 */
      detail: (e && e.detail) ? String(o.detail || '') : ''
    };
  }


  /** 数据源标签的统一拼法。所有错误文本里的 `xx：` 前缀只从这儿来。 */
  function factText(source, fact) {
    const f = String(fact == null ? '' : fact).trim();
    const s = String(source || '').trim();
    if (!s) return f;
    /* 调用方已经自己带上前缀时不再叠一遍——重复前缀在红框里很难看，
       而且会让人以为是两个不同的数据源 */
    if (f.indexOf(s + '：') === 0) return f;
    return s + '：' + f;
  }

  /**
   * 造一个错误。
   * @param {string} kind   上面 CARD 的键；不认识的一律当 UNKNOWN，不静默吞掉
   * @param {string} fact   纯事实，不带处置语（"返回 500""20 秒内未返回"）
   * @param {object} [extra] source 数据源标签；其余字段（timeout/status/url）原样挂到 e 上给排障用
   */
  function err(kind, fact, extra) {
    const k = CARD[kind] ? kind : 'UNKNOWN';
    const o = extra || {};
    const text = factText(o.source, fact);
    const e = new Error(text);
    e.kind = k;
    e.code = CARD[k].code;
    e.fact = String(fact == null ? '' : fact);
    if (o.source) e.source = String(o.source);
    Object.keys(o).forEach(x => { if (x !== 'source') e[x] = o[x]; });
    return e;
  }

  /**
   * 把任意异常折成渲染所需的三样东西。UI 只认这个返回值，不再自己判 kind。
   * 非 err() 造出来的异常（浏览器原生异常、别人 throw 的字符串）也走这里，
   * 落到 UNKNOWN，事实取原始 message。
   */
  function errInfo(e) {
    const kind = (e && CARD[e.kind]) ? e.kind : 'UNKNOWN';
    const card = CARD[kind];
    const source = (e && e.source) || '';
    let fact = (e && e.fact != null) ? String(e.fact) : String((e && e.message) || e || '');
    /* 有人 throw 了一个对象、或 throw {}：String({}) 会得到 "[object Object]"，
       印在红框里既不像话也帮不上忙，按"没有更多信息"处理。 */
    if (fact === '[object Object]') fact = '';
    if (source && fact.indexOf(source + '：') === 0) fact = fact.slice(source.length + 1);
    return {
      kind, card, source, fact,
      line: card.code + '｜' + factText(source, fact || '没有更多信息')
    };
  }

  /**
   * 单行报障文本。使用者复制发给维护人员的就是这一行——
   * 有短码、有数据源、有事实，不依赖"界面上那个红框长什么样"。
   */
  function errLine(e) { return errInfo(e).line; }

  /** 带数据源前缀的事实，用于「以下数据本次未取到」这类列表——不带短码，读着像一句话。 */
  function errFact(e) {
    const i = errInfo(e);
    return factText(i.source, i.fact);
  }

  /**
   * 红框 HTML。全项目只有这一处拼错误态 DOM，
   * 原来 panel.js 里有两份（取数失败、配置读不到），措辞各写各的。
   * @param {Error} e
   * @param {(s:string)=>string} [esc] 转义函数，默认透传（Node 测试环境没有 HT.esc）
   */
  function errHTML(e, esc) {
    const f = typeof esc === 'function' ? esc : (s => String(s == null ? '' : s));
    const i = errInfo(e);
    return '<div class="ht-empty ht-err">'
      + '<b>' + f(i.card.title) + '</b>'
      + '<span>' + f(i.card.tip) + '</span>'
      + (i.card.detail ? '<em>' + f(i.line) + '</em>' : '')
      + '</div>';
  }

  /** 状态栏短名。面板只读它，不再自己维护一张映射表。 */
  function errFoot(e) { return errInfo(e).card.foot; }

  Object.assign(HT, {
    ERR_CARD: CARD, ERR_KINDS: KINDS,
    err, errInfo, errLine, errFact, errHTML, errFoot,
    /* 更新类提示与 CARD 同源不同载体：这里没有 Error，只有"这次查得怎么样"。 */
    UPD_TEXT: UPD, UPD_WORD, updInfo,
    DL_TEXT: DL, dlKind, dlOut,
    /* 旧名保留：0.19 之前的调用点很多，改名一次到位但留个别名，
       免得某个漏改的文件在运行时抛 "HT.htError is not a function" 把真正的错盖掉。 */
    htError: err
  });
})(typeof window !== 'undefined' ? window : globalThis);
