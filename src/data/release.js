/**
 * src/data/release.js —— 版本与更新（唯一策略点）
 *
 * @layer  data（数据源层）
 * @file   src/data/release.js
 * @since  0.20.0
 *
 * 为什么不能"只写一个地方"：
 *   MV3 强制要求版本号在 manifest.json 里，而 content script、service worker、
 *   扩展页面是三个互不相通的上下文，没有模块系统能共享一份 JS。
 *   所以物理上至少两处。能做的只有两件事：
 *     1. 把"脚本侧"的那些家合并成这一处（原来还散在 config.js / background.js）
 *     2. 让 verify 拿清单与这里对账，不一致就红
 *   这样人手改的地方从 5 处降到 2 处，且改漏了跑一次校验就知道。
 *
 * 加了自动更新之后，这里就是唯一要动的地方：
 *   update.feedUrl 填上清单地址、enabled 打开，检查逻辑本身不碰业务代码。
 *   不要把"检查更新"写进 report.js / panel.js——那会让"取数失败"和
 *   "更新失败"混在同一条链路里，排查时分不清是谁的问题。
 *
 * 更新清单（feedUrl 指向的 JSON）约定的最小形状：
 *   { "version": "x.y.z", "notes": ["…"], "url": "下载或说明页",
 *     "size": 293395, "sha256": "cfac044171f79c07" }
 * size 与 sha256 由发布脚本写入，下载前用它核对安装包（见 background.js 的 verifyPkg）。
 * 缺这两个字段不算错——老清单照旧能下，只是少了那道核对。
 * 只用来提示，不做静默升级——这个扩展是装在自己机器上的，替人决定换版本不合适。
 */
(function (g) {
  'use strict';
  const HT = (g.__HT = g.__HT || {});

  /**
   * 自建服务器的根地址。版本清单、诊断上报、配置同步都在它下面。
   *
   * **源码里是占位符，不是真地址。** 真值放在 `ops/host.json`（被 .gitignore
   * 排除），`debug/dist.js` 生成成品时替换掉 `__HT_ORIGIN__`。这样公开仓库里
   * 不出现运营方的服务器地址，而装机用的 dist/ 里已经是完整 URL。
   * CI 走 `HT_ORIGIN` 环境变量（取自仓库 Secret）。
   *
   * manifest 的 host_permissions 用同一个占位符，由同一步替换——
   * 三处（base / feedUrl / host_permissions）只对这一个字符串负责。
   */
  const BASE = '__HT_ORIGIN__/bg-9f3a';

  const RELEASE = {
    /** 服务器根（供 verify 与文档引用，不参与请求拼接以外的用途） */
    base: BASE,
    /** 必须与 manifest.json 的 version 一致（verify 会逐字核对） */
    version: '1.10.7',
    /** 构建日期，只用于设置页的 title 提示 */
    build: '2026-11-21',
    /** 发布通道：stable | beta。beta 只影响提示措辞，不改变行为 */
    channel: 'stable',

    update: {
      /**
       * 自动版本检查。已打开：自建分发源已就绪（轻量服务器 + nginx）。
       * feedUrl 与 manifest.json 的 host_permissions 必须同时改，
       * 漏一边不会报错——请求直接被浏览器拦掉，表现为"检查更新失败"。
       */
      enabled: true,
      /** 更新清单地址（JSON）。空 = 不检查 */
      feedUrl: BASE + '/version.json',
      /* 这里曾有一个 checkOnOpen（"打开面板时顺手查一次"），声明了但全项目无人读——
         设置页的 refresh 无条件问一次、面板从不问。更新检查收敛为
         "打开设置页即查一次（不吃 24 小时缓存）"之后，这个概念已经没有落点了，删除。
         要再加"打开面板就问"，先想清楚"使用者点生成时多一次网络往返"值不值。 */
      /** 两次检查的最小间隔：一天 */
      interval: 24 * 60 * 60 * 1000,
      /**
       * 文件已经换掉时，要不要自己替人点一下「重新加载扩展」。
       *
       * 默认关。它**不是自动更新**：扩展没有任意路径写文件的权限，
       * 解压覆盖这一步永远得有人（或同步盘）做。这个开关只管最后一下——
       * 让 Chrome 重新从磁盘读一遍。叫"自动重载"而不叫"自动更新"，
       * 就是不想让人以为不下载也会变新。
       *
       * 护栏在 background.js：统计页开着不动、设置页开着不动、同版本最多试三次。
       */
      autoReload: false,
      /**
       * 低于这个 Chrome 版本的客户端不提示更新扩展，而是提示升级浏览器。
       * MV3 的 service worker 要 111+。
       */
      minChrome: 111
    },

    /**
     * 诊断上报。**默认就发，界面不给关**（1.8.0 用户定：
     * 「有错误就主动上传，没错误就不管呗，不用有开关，直接就默认有的功能」）。
     *
     * 发出去的东西只有三类：版本号、环境（Chrome/系统/语言）、本机自检记录
     * （短码 + 模块名 + 校验项名）；另有一个随机安装 ID——只用来把同一台机器
     * 的几条记录归到一起，不是账号也不是指纹——外加每日一条心跳（只说明
     * 这台机器还在用、跑的是哪个版本）。**没有起数、没有区域、没有模板正文。**
     * 这份内容本来就是"随手截图发给维护人员"都行的那一份，所以不再弹确认框：
     * 出错时自动发一份，比等人想起来去复制粘贴更可能留下线索。
     *
     * 1.7.x 曾有一个机器级开关（storage 里的 tgOn），默认关。撤掉的原因不只是
     * "多一行"，而是它制造了一个看不见的坏状态：升级过来的机器带着 tgOn:false，
     * 从此一条都不发，界面上却还写着"上报情况"——排查时会被这条假象带偏。
     *
     * 小范围自用（个位数机器），收端就是自建的那台轻量服务器：
     * 一个只追加的 jsonl，不走任何第三方。把 enabled 设成 false 是**唯一**的关闸口
     * （那是维护者的决定，不是使用者的设置项）。
     */
    report: {
      enabled: true,
      /** 接收地址；与 manifest 的 host_permissions 必须同时覆盖（verify 有断言） */
      url: BASE + '/diag',
      /** 一台机器一天最多发几份：错误循环时别把服务器刷满 */
      maxPerDay: 20
    },

    /**
     * 反馈入口。
     *
     * 只认一个 URL：问卷、群二维码落地页、写好的 mailto 都行。留空就不假装
     * 有在线入口——设置页那颗按钮改走"复制诊断"，把 diagText 放进剪贴板并
     * 提示粘给维护人员。上报链路自己也会坏（没网、服务器没开），那种时候
     * 复制粘贴是唯一还走得通的路。
     */
    feedback: {
      /** 空 = 没有在线入口，按钮只复制 */
      url: ''
    },

    /**
     * 云端配置同步。
     *
     * 换一台电脑装扩展，本地是出厂默认值；把配置存到同一台自建服务器上，
     * 新机器打开站点就能取回来。
     *
     * **所有装了本扩展的电脑共用一份**（服务端一个固定槽位，见 cloud.js 的 SLOT）。
     * 没有同步码：分多份只会多出一个问题——"新装那台该取哪一份"，
     * 而这个扩展的用途只有一种，答案永远是"就那一份"。
     *
     * 存上去的只有配置本身（模板正文、中心城区、屏蔽规则、文案几句），
     * **没有任何记录数据、没有账号、没有机器标识**——设备名是本地随机生成的
     * 三个字符（win-a3f2 这种），只用来在界面上区分"哪台机器改的"。
     *
     * 两侧都自动：保存后 4 秒静默上传；打开站点查一次（同机 60 秒限流），
     * 云端更晚且本机没有未传的改动就整份取回。两台都改了以"后改的"为准，
     * 覆盖前把本机那份存一层底（设置页给「还原」）。
     */
    sync: {
      enabled: true,
      /** 接口根；put / get / stat 三个动作拼在后面。与 manifest 的 host_permissions 同步改 */
      url: BASE + '/cfg',
      /** 保存配置后自动上传。关掉后只剩本机，一个请求都不发 */
      autoPush: true,
      /** 合并连续保存：改模板时会连点几次保存，防抖成一次上传 */
      debounceMs: 4000
    },

    /**
     * 更新说明。发布时往数组头部塞一条，设置页与"有新版本"提示都读它。
     * 空数组是正常状态（还没发过带说明的版本）。
     * @type {{version:string, date:string, items:string[]}[]}
     */
    notes: []
  };

  HT.RELEASE = RELEASE;

  /**
   * 「本机版本」以**运行时清单**为准，文件里的常量只是兜底。
   *
   * 为什么要多这一步：同步盘会把成品目录整块换掉，文件已经是新的，
   * 而扩展没重载——Chrome 仍在跑旧代码，`chrome.runtime.getManifest()`
   * 也还是旧清单。这时如果读文件里的常量，设置页会显示"本机是新的"，
   * 检查更新也拿它去比，于是判"已是最新"。**这是唯一能看出"没重载成功"
   * 的线索，不能被一个常量抹掉。**
   *
   * Node 自检环境没有 chrome，退回常量；verify 会断言两处一致。
   */
  function localVer() {
    try {
      const c = g.chrome;
      const m = c && c.runtime && c.runtime.getManifest && c.runtime.getManifest();
      if (m && m.version) return String(m.version);
    } catch (e) { }
    return RELEASE.version;
  }
  HT.localVer = localVer;

  /* ── 版本对账 ──────────────────────────────────────────────────────
     只查、只报，不下载、不替换。

     为什么不自动更新：Chrome 在 Windows / macOS 上只允许「由企业策略强制安装」
     的扩展来自非商店来源，自建 update_url 对普通用户只在 Linux 上可用。
     也就是说这条路物理上不通——写一套"自动更新"只是让它看起来在更新，
     实际上什么都没发生，反而让人以为新版本没生效是别的原因。

     能做到的是：查到一个更新的版本号，在设置页显示一行字和一个下载链接，
     剩下那一步（覆盖文件 + chrome://extensions 点刷新）是人做的。

     返回 plain object，不拼任何句子：措辞归 ui，这里只说事实。
     查不到更新不算错误——没网、服务器没开、JSON 写错，都只是"这次没查到"，
     不进 obs、不弹红框、不打扰任何人。 */

  /* 语义化比较：只认数字段，缺的小节按 0 补——两段写法和三段写法视为相等。 */
  const cmpVer = (a, b) => {
    const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
    const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d > 0 ? 1 : -1;
    }
    return 0;
  };

  /* ── 失败原因：四类，必须分开 ──────────────────────────────────────
     以前只有一个 'fail'，于是"服务器没开""网络不通""返回了错误页""清单写错"
     在界面上长得一模一样，只能把浏览器的英文原话截 40 字贴给人看——
     那句 `Failed to fetch` 对使用者没有信息量，也分不清该找网管还是找维护人员。

     这里只给**短码**（事实），怎么说见 errors.js 的 UPD 表——本层不写句子。
     四类的分界是"请求走到哪一步断的"：
       unreach 没发出去（DNS / 拒绝连接 / 被拦）→ 查网络、代理
       timeout 发出去了没回                    → 服务器或链路挂住
       http    回了但不是 2xx                  → 服务器那一侧
       format  回了 2xx 但不是有效清单          → 发布/部署写错了
     分得开才有意义：前三类能自己动，最后一类只能找会改服务器的人。 */
  const WHY = {
    UNREACH: 'unreach',
    TIMEOUT: 'timeout',
    HTTP: 'http',
    FORMAT: 'format'
  };

  /** 清单是几百字节的 JSON，8 秒已经够；等太久会把设置页顶住。 */
  const FETCH_TIMEOUT = 8000;
  /** 失败也短缓存：断网时每次打开设置页都站 8 秒才说"连不上"，而 60 秒内再查结果不会变。 */
  const FAIL_TTL = 60 * 1000;

  /* 超时与解析不再在这里做：lib/req.js 一份实现，四处共用。
     本层只判断"清单该长什么样"（有没有 version、notes 留几条）。 */

  let cacheAt = 0;
  let cacheVal = null;
  let failAt = 0;
  let failVal = null;

  /**
   * 查一次版本清单。
   * @param {boolean} [force] 忽略间隔缓存
   * @returns {Promise<{local:string,latest:string,hasNew:boolean,
   *                    notes:string[],url:string,size:number,sha256:string,
   *                    reason:string,detail?:string}>}
   *   reason: '' 查成功 / 'off' 开关没开 / 'nofeed' 没填地址 /
   *           'unreach' | 'timeout' | 'http' | 'format' 四类失败
   *   detail: 只在 http / format 时有信息量（状态码、缺哪一项），其余不展示
   */
  function checkUpdate(force) {
    const U = RELEASE.update;
    const cur = localVer();
    const base = {
      local: cur, latest: '', hasNew: false, notes: [], url: '',
      size: 0, sha256: '', reason: ''
    };
    const fail = (reason, detail) => ({
      local: cur, latest: '', hasNew: false, notes: [], url: '', reason, detail
    });

    if (!U.enabled) { base.reason = 'off'; return Promise.resolve(base); }
    if (!U.feedUrl) { base.reason = 'nofeed'; return Promise.resolve(base); }
    if (!force) {
      if (cacheVal && Date.now() - cacheAt < U.interval) return Promise.resolve(cacheVal);
      if (failVal && Date.now() - failAt < FAIL_TTL) return Promise.resolve(failVal);
    }

    if (!HT.req || !HT.req.json) return Promise.resolve(fail(WHY.UNREACH, '请求工具未加载'));

    return HT.req.json(U.feedUrl, { timeout: FETCH_TIMEOUT })
      .then(r => {
        if (!r.ok) throw fail(r.reason, r.detail);
        const j = r.data || {};

        /* 空清单不许冒充"已是最新"。服务器配错、发布脚本漏写 version、
           中间层塞了个 {} —— 这些都该说"清单异常"，而不是让人以为天下太平。 */
        const latest = String(j.version || '').trim();
        if (!latest) throw fail(WHY.FORMAT, '缺少 version');

        /* 清单可以带 enabled:false —— 维护方止血用的开关。
           查到它仍然算"查成功"（reason='paused'），但不提示更新、不给下载按钮：
           这时"有新版本"恰恰是维护方不想让人装的那个版本。 */
        const paused = j.enabled === false;

        const val = {
          local: cur,
          latest,
          hasNew: !paused && cmpVer(latest, cur) > 0,
          /* 清单比本机旧：这一版还没发布。方向和"已是最新"相反，
             放在这里判是因为比较只该有一份（cmpVer 就在上一行）。
             errors.js 只负责措辞，不再自己算一遍顺序。 */
          ahead: cmpVer(latest, cur) < 0,
          notes: Array.isArray(j.notes) ? j.notes.slice(0, 5).map(String) : [],
          url: j.url ? String(j.url) : '',
          /* 安装包指纹：下载前核对用。清单没写就是空串/0，界面与后台都当"没有"处理，
             不因为缺这两个字段就说清单坏了——它们本来就是可选的。 */
          size: Number(j.size) > 0 ? Number(j.size) : 0,
          sha256: String(j.sha256 || '').trim().toLowerCase(),
          reason: paused ? 'paused' : ''
        };
        cacheAt = Date.now();
        cacheVal = val;
        failVal = null;
        return val;
      })
      .catch(e => {
        const v = (e && e.reason) ? e : fail(WHY.UNREACH, String((e && e.message) || e));
        failAt = Date.now();
        failVal = v;
        return v;
      });
  }

  HT.checkUpdate = checkUpdate;
  HT.cmpVer = cmpVer;
  HT.UPD_WHY = WHY;

  /* 兼容：老代码从 HT.META 读版本，这里不提供——META 归 config.js，
     它现在从 RELEASE 取值，别再往 HT 上挂第二份。 */
})(typeof window !== 'undefined' ? window : globalThis);
