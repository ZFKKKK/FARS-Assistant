/**
 * src/ui/settings.js —— 设置视图（面板内浮层与独立设置页共用同一份实现）
 *
 * @layer  ui（表现层）
 * @file   src/ui/settings.js
 * @since  0.10.0
 *
 * 为什么是一个"视图模块"而不是一个页面：
 *   0.9 的设置是独立标签页（options.html）。点齿轮跳走一页，等于把"手上这份稿子"
 *   留在原地、把配置搬到另一处改，改完还得自己回来。0.10 把它做成面板里的浮层
 *   （和「口径与常见问题」同一个位置、同一套进出方式），改完点保存就回到稿子上。
 *   chrome://extensions 的「扩展选项」仍然要有落点，所以 options.html 退化成
 *   一个 20 行的宿主页：同一份 CSS、同一个模块，只是挂载点更宽。
 *
 * 模板编辑器（0.10 的核心）
 *   模板不再是"块的列表"，而是**一段自由文本**，中间可以插占位符：
 *     · 数据 —— 数据域 → 字段 → 呈现方式，三级联动
 *     · 日期 —— 时间段 / 时间点 / 日期，各给几种写法
 *     · 整段成文 —— 原来的公文段落，一键插入
 *   于是"起火原因引导语""待查后缀""固定结尾句"这些半成品开关全部删掉：
 *   想改那句话，就在那段话里改。
 *
 * 编辑区用 contenteditable + 不可编辑的 chip 表示占位符：
 *   纯 textarea 只能显示 {{f:day.C|numUnit}} 这种原文，写稿的人看不出那是什么；
 *   而 chip 上写的就是"当日有效条目起数"。序列化在 readEditor() 一处完成。
 *
 * 这份编辑器整体搬到了 src/ui/editor.js（0.25.0）：列表、光标、chip、三级级联
 * 都归它；这个文件只剩"有哪些设置项、怎么存、浮层归谁开"。
 */
(function (g) {
  'use strict';
  const HT = (g.__HT = g.__HT || {});

  const esc = s => HT.esc(s);

  /* 重庆市区域：中心城区多选的候选项。名单只用来**选择**，
     存进配置的仍是勾中的名字，取数层按 shortTown 归一后比对。 */
  const DISTRICTS = [
    '渝中区', '大渡口区', '江北区', '沙坪坝区', '九龙坡区', '南岸区', '北碚区', '渝北区', '巴南区',
    '万州区', '涪陵区', '黔江区', '长寿区', '江津区', '合川区', '永川区', '南川区', '綦江区',
    '大足区', '璧山区', '铜梁区', '潼南区', '荣昌区', '开州区', '梁平区', '武隆区',
    '城口县', '丰都县', '垫江县', '忠县', '云阳县', '奉节县', '巫山县', '巫溪县',
    '石柱土家族自治县', '秀山土家族苗族自治县', '酉阳土家族苗族自治县', '彭水苗族土家族自治县',
    '两江新区', '万盛经开区', '高新区'
  ];

  let uidSeq = 0;

  const shortName = s => {
    try { return HT.shortTown(String(s || '').trim(), true); } catch (e) { return String(s || ''); }
  };

  /* 正文与编辑区 DOM 的互转（toEditor / readEditor）在 src/ui/editor.js：
     它只服务模板编辑器，放在这里会让"设置项"和"富文本序列化"共用一份命名空间。 */

  /* 下载回执的订阅只注册一次（mount 每次打开都会重跑），
     真正指向哪一行提示由 sayTo 决定——后打开的那一屏接管。 */
  let sayTo = null;
  let dlHooked = false;
  /* 每次发起下载 +1。回执和超时定时器都认这个号，旧的那次自动作废——
     否则连点两次，第一次的超时会把第二次的结果盖掉。
     放在模块级而不是某个实例里：回执监听只注册一次，它得能作废最新那一屏的定时器。 */
  let dlTick = 0;

  /**
   * 挂载设置视图。
   * @param {HTMLElement} host 挂载点
   * @param {{onSaved?:Function, onLater?:Function}} [opts]
   */
  HT.mountSettings = function (host, opts) {
    const o = opts || {};
    const uid = 'st' + (++uidSeq);
    let cfg = HT.normalizeCfg();
    let coreSel = [];

    /* 结构与控件全部来自 src/data/settings-schema.js。
       这里只留两个动作（恢复默认 / 保存）与浮层宿主——加设置项请改 schema，
       不要在这个文件里再拼第 181 行字符串。

       两个动作放哪儿由**调用方**决定（1.9.1）：
         · 面板里的设置浮层把它挂到头部右上角（`opts.head`）——
           设置不是对话框，没必要为两颗按钮单占一条底栏；
         · 独立设置页没有那条头部，退回页脚。两条路用的是同一份 HTML，
           `data-act` 也一样，所以点击分发只写一遍。 */
    const BTN_RESET = '<button class="st-btn st-quiet" type="button" data-act="reset"' +
      ' title="全部设置恢复默认">恢复默认</button>';
    const BTN_SAVE = '<button class="st-btn st-primary" type="button" data-act="save">保存</button>';
    const headActs = o.head || null;
    if (headActs) headActs.innerHTML = '<span class="st-msg" data-f="msg"></span>' + BTN_RESET + BTN_SAVE;

    host.innerHTML = HT.SETTINGS.render(cfg) + (headActs ? ''
      : '<div class="st-foot">' + BTN_RESET + '<span class="st-sp"></span>' +
      '<span class="st-msg" data-f="msg"></span>' + BTN_SAVE + '</div>') +
      '<div class="st-pop" data-f="pop" hidden></div>';

    const root = host;
    const pop = root.querySelector('[data-f="pop"]');
    const tplsBox = root.querySelector('[data-f="tpls"]');
    /* 提示条跟着按钮走：挂在头部时它也在头部，否则在页脚 */
    const msgEl = (headActs || root).querySelector('[data-f="msg"]');
    const bodyBox = root.querySelector('.st-body');

    const q = sel => root.querySelector(sel);
    const qa = sel => Array.from(root.querySelectorAll(sel));

    /* ── 读写控件 ───────────────────────────────────────── */
    function setSw(name, on) {
      const b = q(`[data-f="${name}"]`);
      if (b) b.setAttribute('aria-checked', on ? 'true' : 'false');
    }
    function getSw(name) {
      const b = q(`[data-f="${name}"]`);
      return !!b && b.getAttribute('aria-checked') === 'true';
    }

    /* ── 同比那一行（dirNum）─────────────────────────────────
       两个数字框 + 一颗方向按钮。方向只存一处（up / down），人数与幅度都存**绝对值**：
       两处各存一个符号，迟早写出「人数减少、幅度上升」这种自相矛盾的句子。 */
    function setDir(name, dir) {
      const down = dir === 'down';
      const b = q(`[data-dir="${name}"]`);
      if (b) {
        b.textContent = down ? '减少' : '增加';
        b.setAttribute('aria-pressed', down ? 'false' : 'true');
      }
      /* 这个字跟着按钮走，不单独给入口：人只回答"多了还是少了"，
         "上升 / 下降"是同一个答案的另一种说法。 */
      const w = q(`[data-w="${name}"]`);
      if (w) w.textContent = down ? '下降' : '上升';
    }

    function readDir(name) {
      const b = q(`[data-dir="${name}"]`);
      return b && b.getAttribute('aria-pressed') === 'false' ? 'down' : 'up';
    }

    function paintDirRows() {
      HT.SETTINGS.rows().forEach(r => {
        if (r.t !== 'dirNum') return;
        const n = q(`[data-f="${r.f}"]`);
        const p = q(`[data-f="${r.f2}"]`);
        /* 空就是空：0 与"没填"是两件事，前者写「增加0人」后者整侧不出现 */
        if (n) n.value = cfg[r.cfg] == null ? '' : cfg[r.cfg];
        if (p) p.value = cfg[r.cfg2] == null ? '' : cfg[r.cfg2];
        setDir(r.dir, cfg[r.dir]);
      });
    }

    function fill(c) {
      cfg = HT.normalizeCfg(c);
      /* 开关 / 数字 / 时间一律按 schema 走。
         0.24 及以前这里是十行手写赋值，加一个开关忘写一行，表现是
         "能点、但不落盘"——没有任何报错。 */
      HT.SETTINGS.bindable().forEach(r => {
        if (r.t === 'switch') { setSw(r.f, !!cfg[r.cfg]); return; }
        /* 复选组：配置里是顿号分隔的串，逐个认；没写分隔符的（手工改过配置）也认 */
        if (r.t === 'checks') {
          const on = String(cfg[r.cfg] || '').split(/[、,，;；\s]+/).filter(Boolean);
          root.querySelectorAll(`[data-f="${r.f}"] input[type="checkbox"]`).forEach(b => {
            b.checked = on.indexOf(b.dataset.n) >= 0;
          });
          return;
        }
        const el = q(`[data-f="${r.f}"]`);
        if (el) el.value = cfg[r.cfg];
      });
      coreSel = String(cfg.coreTowns || '').split('、').map(s => s.trim()).filter(Boolean);
      paintCore();
      paintDirRows();
      /* 整份换给编辑器，它会自己收掉编辑态——切档案时不该留着上一份的编辑区 */
      ed.load(cfg.templates);
      msg('');
    }

    /** 提示条：一行字进正文，处置与错误码进悬停——这一行很窄，塞不下两句。 */
    function msg(t, tip) {
      if (!msgEl) return;
      msgEl.textContent = t || '';
      msgEl.title = tip || '';
    }

    /* 下载回执。后台等到下载真正有了终态（下完 / 被拦 / 断流）才发这一条，
       所以下载中这一行会先停在"正在下载…"，不会被误读成已经好了——
       上一版正是拿到"任务已接下"就说"已开始下载"，而被安全浏览拦下的下载
       气泡会在这句话之后消失，看起来就是"点了没反应"。 */
    sayTo = (t, tip) => msg(t, tip);
    if (!dlHooked) {
      dlHooked = true;
      try {
        chrome.runtime.onMessage.addListener(m => {
          if (!m || m.type !== 'dlResult' || !sayTo) return;
          dlTick++;                        // 作废还没到点的超时兜底
          const r = HT.dlOut(m);
          sayTo(r.text, r.tip);
        });
      } catch (e) { /* 没有 runtime 监听权限时只是少一条回执，不影响别的 */ }
    }

    /**
     * 失败原因的一行化。
     * 与面板共用同一套事实文案（HT.errFact），只是这里空间小、不印短码。
     * 空原因兜成「未知原因」——否则屏幕上会出现「保存失败：」这样断掉的句子，
     * 看着像界面自己坏了。
     */
    function why(e) { return HT.errFact(e) || '未知原因'; }

    /* ── 云端配置 ───────────────────────────────────────── */
    /* 所有装了本扩展的电脑共用一份配置：没有同步码，也没有「上传 / 取回」按钮。
       打开设置页先对一次（限流 60 秒），之后每次保存由 config.js 的
       writePack 直接叫 HT.cloud.onCfgSaved()，不再经过界面。
       这一组没有一个是"配置项"（都不进 cfg），所以 collect() 不碰它们。 */
    let cloudMeta = null;

    /** 画一句状态 + 开关 + 覆盖后的还原入口。失败时额外露出「立即同步」 */
    async function paintCloud(patch) {
      const m = Object.assign({}, cloudMeta || {}, patch || {});
      const fresh = patch ? m : await HT.cloud.readMeta();
      cloudMeta = fresh;
      const el = q('[data-f="syncStat"]');
      if (el) el.textContent = HT.cloud.statusText(fresh);
      setSw('syncAuto', fresh.auto !== false);

      /* 「立即同步」平时是多余的按钮——自动同步就是它的全部工作。
         只有"没成功过"或"这次没传上去"的时候才露出来，那时人才需要一个手动重试。 */
      const nowBtn = q('[data-act="syncNow"]');
      if (nowBtn) nowBtn.hidden = !(fresh.fail || !fresh.at);

      const pv = await HT.cloud.prevInfo();
      const pvText = q('[data-f="syncPrev"]');
      const pvBtn = q('[data-act="syncRestore"]');
      if (pvBtn) pvBtn.hidden = !pv;
      if (pvText) {
        pvText.textContent = pv ? '覆盖前那份（' + HT.cloud.when(pv.at) + '）' : '—';
        const rowEl = pvText.closest ? pvText.closest('.st-row') : null;
        if (rowEl) rowEl.hidden = !pv;
      }
    }

    /** 立即同步：跳过 60 秒限流，拉或推由 cloud.js 判 */
    async function syncNow() {
      msg('正在同步…');
      try {
        const r = await HT.cloud.boot({ force: true });
        if (r && r.pulled) {
          /* fill 会把整份配置画回界面，并清掉提示条，所以提示放在它后面 */
          fill(await HT.loadCfg());
          msg('已取回云端那份（' + HT.cloud.when(r.pulled) + (r.replaced ? '，本机原来那份已留底' : '') + '）');
        } else if (r && r.pushed) {
          msg('已传上云端');
        } else if (r && r.err) {
          msg('没同步成：' + r.err);
        } else {
          msg('已经是最新的，不用同步');
        }
      } catch (e) {
        msg('没同步成：' + why(e));
      }
      await paintCloud();
    }

    /** 还原被云端覆盖之前的本机那份（只留一层，用过就没了） */
    async function syncRestore() {
      if (!confirm('把本机配置换回被云端覆盖之前的那一份？换完会传上云端，所有电脑都跟着变。')) return;
      msg('正在还原…');
      try {
        await HT.cloud.restorePrev();
        fill(await HT.loadCfg());
        msg('已还原，并已传上云端');
      } catch (e) {
        msg('还原没成：' + why(e));
      }
      await paintCloud();
    }


    /* 1.2 起没有「用户」这一组：多用户档案撤掉了。
       同一台机器就是同一套配置，切换用户这个动作没人用，还占着设置页第一屏。
       存储里那份 profiles 仍然读得到（老机器不会丢配置），只是不再给界面入口。 */

    /* ── 中心城区多选 ───────────────────────────────────── */
    const coreAll = () => {
      const all = DISTRICTS.slice();
      coreSel.forEach(n => {
        if (!all.some(d => shortName(d) === shortName(n))) all.push(n);
      });
      return all;
    };
    const isPicked = n => coreSel.some(x => shortName(x) === shortName(n));

    function paintCore() {
      const t = q('[data-f="coreText"]');
      t.textContent = coreSel.length
        ? `已选 ${coreSel.length} 个：` + coreSel.slice(0, 3).map(shortName).join('、') +
          (coreSel.length > 3 ? ' 等' : '')
        : '未选（不区分中心城区）';
    }

    function drawCore(kw) {
      const k = String(kw || '').trim();
      const items = coreAll().filter(n => !k || n.indexOf(k) >= 0 || shortName(n).indexOf(k) >= 0);
      return `<div class="st-ms">
        <input class="st-in st-ms-q" type="search" placeholder="搜索区县" value="${esc(k)}">
        <div class="st-ms-list">${items.length ? items.map(n =>
          `<label class="st-ms-i${isPicked(n) ? ' on' : ''}">
             <input type="checkbox" data-n="${esc(n)}"${isPicked(n) ? ' checked' : ''}>
             <span>${esc(shortName(n))}</span></label>`).join('')
          : '<div class="st-ms-none">没有匹配的区县</div>'}</div>
        <div class="st-ms-foot">
          <button class="st-btn" type="button" data-act="coreClear">清空</button>
          <span class="st-sp"></span>
          <button class="st-btn st-primary" type="button" data-act="coreDone">完成</button>
        </div>
      </div>`;
    }

    /* ── 浮层 ─────────────────────────────────────────────
       浮层本体留在设置页：中心城区选择器和模板编辑器共用同一个抽屉。
       "正在改哪个 chip" 属于编辑器自己的状态，已随编辑区一起搬走
       （src/ui/editor.js 的 editChip），这里不再留一份。 */
    let popOwner = null;

    function closePop() {
      pop.hidden = true;
      pop.innerHTML = '';
      popOwner = null;
      qa('[aria-expanded="true"]').forEach(b => b.setAttribute('aria-expanded', 'false'));
    }

    /** 弹出层：wide=true 时铺满编辑区宽度（插入菜单用），否则锚在按钮左边缘 */
    function openPop(anchor, html, wide) {
      closePop();
      popOwner = anchor;
      pop.innerHTML = html;
      pop.hidden = false;
      pop.classList.toggle('is-wide', !!wide);
      /* 锚点也可能是一个正文标签（改指标时），它不是按钮，别给它挂 aria-expanded */
      if (anchor.tagName === 'BUTTON') anchor.setAttribute('aria-expanded', 'true');
      const r = anchor.getBoundingClientRect();
      const hr = root.getBoundingClientRect();
      if (wide) {
        // 铺满：锚在按钮下，左右各留 4px。不这么做的话浮层只有 246px 宽、
        // 又对齐到按钮左沿，左边会露出半截 chip，看着像画错了。
        pop.style.left = '';
        pop.style.right = '';
      } else {
        const w = pop.offsetWidth || 260;
        let left = r.left - hr.left;
        left = Math.max(4, Math.min(left, Math.max(4, hr.width - w - 4)));
        pop.style.left = left + 'px';
      }
      /* 垂直方向要现算：编辑区在滚动容器里，锚点可能在面板下半部，
         而插入菜单有近 300px 高。只按"锚点下方"摆，浮层会伸到面板外面、
         压到网页上（面板本身没有裁切，看起来像画错了）。
         先按下方摆，量完高度再看放不放得下；放不下就翻到上方；
         上下都不够（面板很矮）就贴底，至少保证整块都在面板里。 */
      let top = Math.max(4, r.bottom - hr.top + 6);
      const room = (hr.height || root.clientHeight || 0) - 8;
      const ph = pop.offsetHeight || 0;
      if (ph && top + ph > room) {
        const up = r.top - hr.top - ph - 6;
        top = up >= 4 ? up : Math.max(4, room - ph);
      }
      pop.style.top = top + 'px';
      const inp = pop.querySelector('.st-ms-q');
      if (inp) { try { inp.focus({ preventScroll: true }); } catch (e) { } }
    }

    /* ── 模板编辑器 ───────────────────────────────────────
       列表、编辑区、chip、三级级联全在 src/ui/editor.js（0.25.0 拆出）。
       这里只做一件事：把浮层与提示条注入进去。浮层是中心城区选择器
       共用的，不能让编辑器自己再造一个——同一个抽屉两种开合手感，
       用户会以为点错了。
       编辑器自己管理自己那棵子树的事件，所以下面的事件分发里
       再也看不到 tplOn / edit / up / down / del 这些动作了。 */
    const ed = HT.mountEditor({ box: tplsBox, pop, openPop, closePop, msg });


    /* ── 收集并保存 ─────────────────────────────────────── */
    function collect() {
      ed.flush();
      /* 与 fill() 同一份 schema：界面上有几个可读写项，这里就收几个。
         空值的回落规则仍按行声明（empty），与 0.24 手写版的语义逐字一致：
         数字走 `Number(v) || 回落`，时间走 `v || 回落`。 */
      const ov = {};
      HT.SETTINGS.bindable().forEach(r => {
        if (r.t === 'switch') { ov[r.cfg] = getSw(r.f); return; }
        /* 复选组：按界面上的勾选结果拼回顿号串。全不勾就是空串——
           语义是"一个都不点名"，正文只写一句「其余正在调查中」，
           不做"空就回退全部"的隐藏兜底（那会让取消勾选毫无效果）。 */
        if (r.t === 'checks') {
          const box = q(`[data-f="${r.f}"]`);
          const on = box
            ? Array.prototype.slice.call(box.querySelectorAll('input[type="checkbox"]'))
              .filter(b => b.checked).map(b => b.dataset.n)
            : [];
          ov[r.cfg] = on.join('、');
          return;
        }
        const el = q(`[data-f="${r.f}"]`);
        const raw = el ? el.value : '';
        if (r.t === 'num') {
          const s = String(raw == null ? '' : raw).trim();
          const n = s === '' ? NaN : Number(s);
          /* 空格子：行上给了 empty 就用它（''= "这一项没填"，与 0 是两件事——
             受伤人数填 0 是"没人受伤"，空着是"照抄平台"）；
             没给 empty 的（冷却秒数这类本来就没有"没填"状态）按 0 存。 */
          ov[r.cfg] = Number.isFinite(n) ? n : (r.empty != null ? r.empty : 0);
        } else {
          ov[r.cfg] = raw || r.empty;
        }
      });
      /* 同比那一行：两个数字 + 一个方向。方向不在 bindable 里（它不是 input），
         但必须和数字一起收——否则界面上点了「减少」、存下来还是「增加」。 */
      HT.SETTINGS.rows().forEach(r => {
        if (r.t !== 'dirNum') return;
        const n = q(`[data-f="${r.f}"]`);
        const p = q(`[data-f="${r.f2}"]`);
        ov[r.cfg] = n ? String(n.value).trim() : '';
        ov[r.cfg2] = p ? String(p.value).trim() : '';
        ov[r.dir] = readDir(r.dir);
      });
      const c = Object.assign({}, cfg, ov, {
        coreTowns: coreSel.join('、'),
        /* 不截断（见 editor.js 里 flush 的注释）：超长的段落由下面的 tooLong 拦下来，
           让用户自己删，而不是替他剪一刀然后假装保存成功。 */
        templates: ed.value().map(t => ({
          id: t.id, title: t.title, on: t.on, text: String(t.text || '')
        }))
      });
      /* 失效占位符在 domain 层清（那里才知道字段目录）。
         记下"哪一段掉了哪几个"，只报总数等于让人自己去找半句话。 */
      const drops = [];
      c.templates.forEach((t, i) => {
        const r = HT.prune(t.text);
        t.text = r.text;
        if (r.dropped) drops.push({ title: t.title || ('第' + (i + 1) + '段'), n: r.dropped, gone: r.gone });
      });
      const tooLong = c.templates
        .map((t, i) => ({ i, n: t.text.length, title: t.title || ('第' + (i + 1) + '段') }))
        .filter(x => x.n > HT.TPL_MAX);
      return { cfg: HT.normalizeCfg(c), drops, tooLong };
    }

    async function save() {
      const r = collect();
      /* 超长必须挡在保存之前：静默截断会切坏占位符，正文里留下半截代码 */
      if (r.tooLong.length) {
        msg(r.tooLong.map(x => `${x.title}已 ${x.n} 字，上限 ${HT.TPL_MAX} 字，请删减后再保存`).join('；'));
        return false;
      }
      /* 改名不在这里做：它有自己的确认/取消，点了立刻生效。
         混进"保存"会造成两种时序——先改名再保存，中途失败就出现"名字变了、配置没存"。 */
      let ok = false;
      try {
        ok = await HT.saveCfg(r.cfg);
      } catch (e) {
        /* 读不到存储时 saveCfg 会 reject：这时**不能**继续用一份空配置往下走 */
        msg('保存失败：' + why(e));
        return false;
      }
      cfg = r.cfg;
      msg(!ok ? '保存失败：写入被拒绝，可能是空间不足' : dropNote(r.drops));
      if (ok && o.onSaved) o.onSaved(r.cfg);
      /* 不再在这里排上传：saveCfg → writePack 里已经挂了钩子，
         这里再来一次就会双发（而且面板改基准时间那条路根本走不到这儿）。 */
      return ok;
    }

    /**
     * 失效项提示：说清在哪一段、掉了哪几个、**为什么掉**。
     *
     * 原来只说"清掉 1 个失效项…请检查那几句是否还完整"——读的人第一反应是
     * "我是不是写坏了"，而实际上绝大多数是升级前模板里的旧字段被撤掉了。
     * 撤掉的那些在 render.js 的 RETIRED 里有死因，这里拼出来；
     * 认不出的键就说"多半是升级前的旧写法"，并说明保存一次之后不再提示。
     */
    function dropNote(drops) {
      if (!drops || !drops.length) return '已保存';
      const total = drops.reduce((s, d) => s + d.n, 0);
      const keys = [];
      const where = drops.map(d => {
        const g = d.gone || [];
        g.forEach(k => keys.push(k));
        const k = g.slice(0, 3).join('、');
        return `${d.title} ${d.n} 个${k ? '（' + k + (g.length > 3 ? ' 等' : '') + '）' : ''}`;
      }).join('；');

      const R = HT.RETIRED || {};
      const known = keys.map(k => R[k]).filter(Boolean)[0];
      const why = known
        ? `这些字段已经不在可选范围里了——${known}。`
        : '这些字段已经不在可选范围里了（多半是升级前模板里的旧写法）。'
        + '需要的话从插入菜单重新选一次。';
      return `已保存。模板里有 ${total} 个占位符被移除了：${where}。`
        + why + '这一步已经改在你的模板里，再保存一次就不会提示。';
    }

    async function reset() {
      if (!confirm('把中心城区、通用设置、模板全部恢复出厂值？这一步不可撤销。')) return;
      coreSel = String(HT.DEFAULT_CFG.coreTowns || '').split('、').filter(Boolean);
      /* 模板不在这里单独赋值：fill() 会整份交给编辑器，TEMPLATES 也由它深拷贝，
         这样 DEFAULT_TEMPLATES 不会被界面改坏（下次另一个档案还会用到它）。 */
      fill(Object.assign({}, HT.DEFAULT_CFG, { coreTowns: coreSel.join('、') }));
      msg('已恢复默认，记得保存');
    }

    /**
     * 导出备份。文件名带日期：同一个人可能存好几份（换机前、改模板前），
     * 不带日期的话第二次导出的文件会把第一份盖掉。
     */
    async function exportBackup() {
      try {
        const pack = await HT.exportCfg();
        const name = `简报助手备份-${new Date().toISOString().slice(0, 10)}.json`;
        /* 走共用出口（feedback.js 的 HT.download）。第三个参数之后不传 BOM：
           JSON 开头多三个字节，下次导入时 JSON.parse 会直接报错。 */
        HT.download(name, JSON.stringify(pack, null, 2), 'application/json');
        msg(`已导出 ${name}`);
      } catch (e) {
        msg('导出失败：' + why(e));
      }
    }

    /** 存储占用：四段模板只占几十 KB，但要让这个数字看得见，人才不用凭感觉担心 */
    async function showUsed() {
      const el = q('[data-f="used"]');
      if (!el) return;
      const u = await HT.storageInfo();
      if (u.unknown) { el.textContent = '—'; return; }
      const kb = u.used / 1024;
      el.textContent = `${kb < 1 ? '<1' : Math.round(kb)} KB / 10 MB`;
    }

    /* ── 诊断 ───────────────────────────────────────────── */
    /* 这一屏显示的是本机留痕，不是"日志文件"。一条只有三样：
       短码、模块、校验项名。数字一个都没记——所以它随手可以截图发人。
       谁能被记下来、记成什么样，全部由调用点与 domain/report.js 决定；
       这里只负责显示，不解释，也不推断。 */
    /* 上报状态只读 background 记的那一条（K_DIAG）：面板出错时自动发过一份，
       这里只是把"上次发到没发出去"摆出来，不再自己发请求。 */
    function askStat() {
      return new Promise(res => {
        try {
          chrome.runtime.sendMessage({ type: 'diagStat' }, r => {
            if (chrome.runtime.lastError || !r) return res(null);
            res(r);
          });
        } catch (e) { res(null); }
      });
    }

    /* 一句话说清"报没报出去"。使用者要知道的只有一件：这台机器现在是不是正常的。
       真要排查，维护者看的是服务器上那份日报，不是这一行。 */
    function paintStat(s) {
      const el = q('[data-f="obsStat"]');
      if (!el) return;
      el.title = '';
      if (!s) { el.textContent = '无法读取'; return; }
      if (!s.enabled) { el.textContent = '已关闭'; return; }
      if (!s.last || !s.last.at) { el.textContent = '运行正常'; return; }
      const m = Math.floor((Date.now() - s.last.at) / 60000);
      const when = m < 1 ? '刚刚' : m < 60 ? m + ' 分钟前'
        : m < 1440 ? Math.floor(m / 60) + ' 小时前' : Math.floor(m / 1440) + ' 天前';
      el.textContent = s.last.ok
        ? '运行正常 · 最近 ' + when
        : '最近一次未送达（' + when + '）';
    }

    /* 登录票据。只报事实：票面时间记的是签发那一刻，实测与能否取数无关
       （过期几小时照样取数，第二天首次打开才要重登），所以不打倒计时，
       扩展这边也没有换票的入口——摆一颗"续期"按钮是骗人的。
       独立设置页（options.html）跑在扩展自己的 origin 上，读不到站点的
       localStorage：那一档直说"需在站点页面查看"，不要假装"未登录"。 */
    function paintSess() {
      const el = q('[data-f="sessStat"]');
      if (!el) return;
      el.title = '';
      let onSite = false;
      try { onSite = g.location.origin === HT.ORIGIN; } catch (e) { }
      if (!onSite) { el.textContent = '需在站点页面查看'; return; }
      let li = null;
      try { li = HT.loginInfo(); } catch (e) { }
      if (!li) { el.textContent = '无法读取'; return; }
      if (!li.hasToken) { el.textContent = '未登录'; return; }
      /* 只答"页面里有没有票"。票面时间照实写在悬停里，但不做倒计时：
         票面 30 分钟只记签发那一刻，实测过期几小时仍能取数，倒计时会误导。 */
      el.textContent = '已登录';
      if (li.unknown) { el.title = '票据里没有可读的时间字段'; return; }
      el.title = '票面 ' + new Date(li.exp).toLocaleString()
        + '（只记签发那一刻，与能否取数无关）';
    }

    /* ── 事件 ─────────────────────────────────────────────
       模板列表（含编辑区、工具栏、行内按钮）和浮层里的页签 / 三级级联，
       事件全部由 src/ui/editor.js 自己绑、自己 stopPropagation。
       这里只剩"设置页本身"的动作：档案、开关、命令按钮。
       编辑器处理过的事件不会冒泡到这里，所以下面看不到 tplOn/edit/up/down/del。 */

    function onClick(e) {
      /* 同比的方向按钮：点一下在「增加 / 减少」之间翻，后面的「上升 / 下降」跟着变。
         只改界面，存盘走 collect（与旁边的数字一起收）。 */
      const dir = e.target.closest ? e.target.closest('.st-dir[data-dir]') : null;
      if (dir) {
        const name = dir.dataset.dir;
        setDir(name, readDir(name) === 'down' ? 'up' : 'down');
        return;
      }

      const sw = e.target.closest('.st-sw');
      if (sw) {
        const on = sw.getAttribute('aria-checked') !== 'true';
        sw.setAttribute('aria-checked', on ? 'true' : 'false');
        /* 这个开关不绑 cfg（它不在配置里，见上面云端那一段），
           所以得自己落盘，否则"点了、关了页、下次又是开着的" */
        if (sw.dataset.f === 'syncAuto') {
          HT.cloud.writeMeta({ auto: on }).then(() => {
            paintCloud({ auto: on });
            msg(on ? '已打开：改完自动传，打开站点自动取' : '已关闭自动同步，配置只存本机');
            /* 刚打开就该立刻对一次，别等下一次保存或下次开页面 */
            if (on) HT.cloud.boot({ force: true }).then(() => paintCloud());
          });
        }
        return;
      }

      const b = e.target.closest('button[data-act]');
      if (!b) {
        /* 点空白处收掉浮层（编辑区里的点击由编辑器 stopPropagation 拦住了） */
        if (!pop.hidden && !pop.contains(e.target)) closePop();
        return;
      }
      const act = b.dataset.act;

      if (act === 'panelReset') {
        /* 当场把面板挪回入口下方，而不是"写一把存储、等下次打开"——
           设置页里点一下、屏幕上没动静，人会以为没生效。 */
        if (o.onPanelReset) o.onPanelReset();
        msg('面板已复位到入口下方');
        return;
      }
      if (act === 'core') {
        if (!pop.hidden && popOwner === b) { closePop(); return; }
        openPop(b, drawCore(''));
        return;
      }
      if (act === 'coreClear') {
        coreSel = [];
        paintCore();
        const ms = pop.querySelector('.st-ms');
        if (ms) ms.outerHTML = drawCore('');
        return;
      }
      if (act === 'coreDone') { closePop(); paintCore(); return; }
      /* 模板的增删改序全在编辑器里（它持有那份列表），这里只转一手。
         恢复出厂要问一句"其它设置不受影响"——那句话属于设置页的措辞，
         编辑器不负责弹框。 */
      if (act === 'tplAdd') { ed.add(); return; }
      if (act === 'save') { save(); return; }
      if (act === 'reset') { reset(); return; }

      /* 只重置模板：内勤把某一段改坏了，最需要的是"回到出厂那四段"，
         而不是连框选区域、字号、屏蔽规则一起重设。 */
      if (act === 'tplReset') {
        if (!confirm('把四段模板恢复成出厂内容？其它设置不受影响，改完仍要点保存。')) return;
        ed.resetTo(HT.DEFAULT_TEMPLATES);
        msg('模板已恢复，记得保存');
        return;
      }
      if (act === 'updCheck' || act === 'updRetry') { updCheck(); return; }
      if (act === 'updGet') { updGet(b); return; }
      if (act === 'updCopy') { updCopy(b); return; }
      if (act === 'syncNow') { syncNow(); return; }
      if (act === 'syncRestore') { syncRestore(); return; }
      if (act === 'exp') { exportBackup(); return; }
      if (act === 'imp') {
        const f = q('[data-f="impFile"]');
        if (f) { f.value = ''; f.click(); }
        return;
      }
    }

    /* 点击分发的两个来源：设置正文，以及头部那两颗动作按钮。
       头部是外部传进来的节点，可能被同一页多次挂载（设置页重开），
       所以监听只绑一次，处理器每次挂载时换成最新的这一份闭包——
       直接 addEventListener 会越叠越多，第二次点保存会跑两遍。 */
    root.addEventListener('click', onClick);
    if (headActs) {
      if (!headActs.__stClick) {
        headActs.__stClick = ev => { if (headActs.__stHandler) headActs.__stHandler(ev); };
        headActs.addEventListener('click', headActs.__stClick);
      }
      headActs.__stHandler = onClick;
    }

    root.addEventListener('change', e => {
      const t = e.target;
      if (t.matches('.st-ms input[type="checkbox"]')) {
        const n = t.dataset.n;
        if (t.checked) { if (!isPicked(n)) coreSel.push(n); }
        else coreSel = coreSel.filter(x => shortName(x) !== shortName(n));
        paintCore();
        t.closest('.st-ms-i').classList.toggle('on', t.checked);
        return;
      }
    });

    root.addEventListener('input', e => {
      const t = e.target;
      if (t.matches('.st-ms-q')) {
        const ms = t.closest('.st-ms');
        const kw = t.value;
        if (ms) {
          ms.outerHTML = drawCore(kw);
          const q2 = pop.querySelector('.st-ms-q');
          if (q2) { q2.focus(); q2.setSelectionRange(kw.length, kw.length); }
        }
        return;
      }
    });

    root.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      if (!pop.hidden) { closePop(); e.stopPropagation(); return; }
      /* 编辑态：Esc 先退出编辑（把正文落回列表再收起编辑区）。
         "退出编辑"是编辑器的状态，所以问它一句，而不是在这里改它的变量。 */
      if (ed.exitEditing()) e.stopPropagation();
    });

    /* ── 对外 ───────────────────────────────────────────── */
    /* 导入：选文件 → 读文本 → 整份校验 → 重画表单。
       不做"合并"，只做"覆盖"：合并会让两个人的模板混在一起，分不清哪段是谁的。 */
    (function bindImport() {
      const f = q('[data-f="impFile"]');
      if (!f) return;
      f.addEventListener('change', async () => {
        const file = f.files && f.files[0];
        if (!file) return;
        /* 导入是"整份覆盖"，没有回滚路径：选错一个文件，现有的模板与偏好就全没了。
           所以在读文件之前先问一句。 */
        if (!confirm(`导入会用文件里的设置整份覆盖当前设置（现有的模板、区县、偏好都会消失）。\n\n继续导入「${file.name}」？`)) {
          f.value = '';
          return;
        }
        try {
          const text = await file.text();
          await HT.importCfg(text);
          fill(await HT.loadCfg());
          await showUsed();
          msg('已导入');
          if (o.onSaved) o.onSaved(HT.normalizeCfg(await HT.loadCfg()));
        } catch (e) {
          msg('导入失败：' + why(e));
        } finally {
          f.value = '';   // 同一个文件再选一次也要触发 change
        }
      });
    })();

    /* ── 版本对账 ────────────────────────────────────
       只核对版本号，不下载、不替换。请求必须由 background 发出：
       content script 的 fetch 走页面 origin，会被目标站的 CSP 拦掉
       （详见 background.js 里的说明）。

       这一屏**不自己写提示文案**：查得怎么样由 release.js 给短码，
       话在 errors.js 的 UPD 表里，这里只负责摆。以前四种"查不到"
       各写各的，最后变成一句「这次没查到：Failed to fetch」。 */
    function askUpdate(force) {
      const fallback = {
        reason: 'nobg', local: HT.localVer(), latest: '',
        hasNew: false, notes: [], url: '', detail: '后台未回话'
      };
      return new Promise(res => {
        try {
          chrome.runtime.sendMessage({ type: 'checkUpdate', force: !!force }, r => {
            if (chrome.runtime.lastError || !r) res(fallback);
            else res(r);
          });
        } catch (e) {
          res(fallback);
        }
      });
    }

    /** 一句"哪一段断了 + 能不能自己解决"，鼠标停上去给完整处置。 */
    function updTitle(i) {
      return i.title + '\n' + i.tip + (i.detail ? '\n' + i.code + '：' + i.detail : '');
    }

    /**
     * 「本机」「最新」两栏各写各的，但**必须能一起读**。
     *
     * 三种关系，不能只有两种：
     *   清单更高   → 有新版本
     *   一样       → 已是最新
     *   清单更低   → 分发源落后（这一版还没发布）
     * 少了第三种，「本机」比「最新」高的时候，两行会一起出现"… · 已是最新"，
     * 读起来是"分发源上那个号就是最新版"。查得到清单 ≠ 清单是新的。
     */
    function paintVer(v) {
      const local = q('[data-f="verLocal"]');
      const latest = q('[data-f="verLatest"]');
      const get = q('[data-act="updGet"]');
      const cp = q('[data-act="updCopy"]');
      const i = HT.updInfo(v);
      /* 本机版本优先取运行时清单，不用文件里的常量：同步盘换掉文件但没重载时，
         常量已经是新的，跑的还是旧的——那一行会显示成新版，把"没重载"这唯一的线索抹掉。 */
      if (local) local.textContent = v.local || HT.localVer();
      if (!latest) return;
      const W = HT.UPD_WORD;
      /* 只说结论，不把版本号拼进状态里——版本号已经在「当前」那一行。
         ahead 也要写清是哪个号：那句话和「当前」并排读，才不会被理解反。 */
      latest.textContent = i.ok
        ? (i.hasNew ? (i.latest + ' 可用')
          : (i.ahead ? ('分发源为 ' + i.latest) : W.same))
        : i.foot;
      latest.classList.toggle('is-new', i.hasNew);
      latest.title = i.ok
        ? (i.ahead
          ? '分发源上最新只到 ' + i.latest + '，本机是 ' + (v.local || HT.localVer()) +
            '——这一版还没发布，不是「已是最新」'
          : '')
        : updTitle(i);
      /* 自动检查已覆盖「有没有新版」，只在失败时留重试入口：
         成功时再多一个按钮，等于同一个动作给两个入口。 */
      const retry = q('[data-act="updRetry"]');
      if (retry) retry.hidden = !!i.ok;
      if (get) {
        get.hidden = !(i.hasNew && i.url);
        if (i.url) get.dataset.url = i.url;
        if (i.latest) get.dataset.ver = i.latest;
        /* 清单里的包指纹（发布脚本写的）。下载前由后台取一遍包比对，
           对不上就不下——手工解压覆盖的包，比"版本号对不对"更该核的是字节。
           老清单没有这两个字段，传空串，后台按"没有指纹"直接下。 */
        get.dataset.sha = v.sha256 || '';
        get.dataset.size = v.size ? String(v.size) : '';
        /* 清单里给的可能是 zip，也可能是说明页——按钮上的字要跟着变，
           否则点"获取安装包"却跳出一个网页，人以为下错了。 */
        get.textContent = /\.zip(\?|$)/i.test(i.url) ? '下载' : '打开页面';
      }
      /* 「更新说明」：清单 approve 之前用户要判断的正是"改了什么"。
         以前 notes 取回来了、存进对象、然后谁也没用——白取一趟。
         只在新版本时出现；多条压成一条 + 条数，全文进 title（不撑破这一行）。 */
      const notesEl = q('[data-f="verNotes"]');
      if (notesEl) {
        const list = (v && Array.isArray(v.notes))
          ? v.notes.map(x => String(x == null ? '' : x).trim()).filter(Boolean).slice(0, 5)
          : [];
        const notesRow = notesEl.closest ? notesEl.closest('.st-row') : null;
        if (notesRow) notesRow.hidden = !(i.hasNew && list.length);
        notesEl.textContent = list.length
          ? (list[0] + (list.length > 1 ? `（共 ${list.length} 条）` : ''))
          : '';
        notesEl.title = list.join('\n');
      }
      /* 「复制地址」与获取按钮同进同出：它只在新版本那一栏有用——下载被安全策略
         拦下时，粘到地址栏手动下是唯一还走得通的路。 */
      if (cp) {
        cp.hidden = !(i.hasNew && i.url);
        if (i.url) cp.dataset.url = i.url;
        cp.title = '把安装包地址复制到剪贴板，粘到浏览器地址栏就能手动下载';
      }
      /* 「重新加载」是常驻行（见 settings-schema 里的说明）：
         它不随版本状态显隐——覆盖文件之后运行中的脚本与已加载的清单都还是旧的，
         没有任何可判定的状态能说明"该重载了"。放常驻，靠 desc 说清在什么时候点。 */
    }

    async function updCheck() {
      msg('检查中…');
      const v = await askUpdate(true);
      paintVer(v);
      const i = HT.updInfo(v);
      const W = HT.UPD_WORD;
      /* 成功只说结论；失败说"哪一段断了"，有状态码才附上状态码。 */
      if (i.ok) {
        msg(i.hasNew ? (W.newer + ' ' + i.latest + '，点右侧按钮获取')
          : i.ahead
            ? ('分发源上最新只到 ' + i.latest + '，比本机旧——这一版还没发布')
            : (W.same + '（' + i.latest + '）'));
      } else {
        msg(i.title + (i.detail ? '（' + i.detail + '）' : ''));
      }
    }

    /* ── 获取安装包 / 重新加载 ──────────────────────────
       这两件事 content script 自己做不了（downloads 与 runtime.reload 都不是
       content script 能碰的 API），所以都转给 background。
       reload 之后这个页面会连同整个扩展一起重建，所以提示语先写上去再发。 */
    function updGet(btn) {
      const url = btn && btn.dataset.url;
      if (!url) { msg('还没有可下载的地址'); return; }
      const ver = (btn && btn.dataset.ver) || '';
      const sha256 = (btn && btn.dataset.sha) || '';
      const size = Number((btn && btn.dataset.size) || 0) || 0;
      const isZip = /\.zip(\?|$)/i.test(url);
      if (isZip) {
        msg('正在下载…', '下完会回报结果；被浏览器拦下也会说清原因。');
        /* 兜底：下载任务被浏览器挂起（等你在下载栏点「保留」）或干脆丢了，
           onChanged 就永远不来。90 秒还没结果就别让它一直停在"正在下载"。 */
        const stamp = ++dlTick;
        setTimeout(() => {
          if (stamp !== dlTick) return;    // 已经有结果，或人又点了一次
          msg('下载迟迟没有回报',
            '打开 chrome://downloads 看那一项：写着「已阻止」就点旁边的「保留」；' +
            '列表里根本没有它，就回来说「复制地址」手动下载。');
        }, 90000);
      }
      try {
        chrome.runtime.sendMessage({ type: 'updGet', url, ver, size, sha256 }, r => {
          if (chrome.runtime.lastError || !r) { msg('下载没开始：扩展后台没有响应'); return; }
          /* zip 的成败要等后台回报（dlResult）：回调只代表"任务被接下"，
             这一刻说"已下载"就是在骗人——被拦下的下载气泡会在这句话之后消失。 */
          if (r.ok) {
            if (!isZip) msg('已打开下载页');
            else if (sha256) msg('正在下载…', '安装包已与清单里的 sha256 核对一致。');
            return;
          }
          /* 两类失败要分开说："没开始下"是浏览器的事（安全策略拦了），
             "核对不通过"是包的事（清单与字节对不上，可能是被换过）。
             同一句话说出去，人会去点「保留」，而复用的是错的包。 */
          const blocked = /核对|清单|不一致|不符|取不到安装包/.test(String(r.why || ''));
          msg((blocked ? '没有下载：' : '下载没开始：') + String(r.why || '浏览器拒绝了这次下载'),
            r.raw ? (blocked ? '详情：' + r.raw : '浏览器原话：' + r.raw) : '');
        });
      } catch (e) { msg('下载没开始：扩展后台没有响应'); }
    }

    /* 手动取件。下载被安全浏览拦下时，downloads API 那条路已经走不通了，
       但把地址粘到地址栏回车仍然能下——这是最后一条不依赖扩展权限的路。 */
    function updCopy(btn) {
      const url = (btn && btn.dataset.url) || '';
      if (!url) { msg('还没有可复制的地址'); return; }
      const done = () => msg('地址已复制', url + '\n粘到浏览器地址栏回车即可下载');
      const fail = () => msg('复制失败，请手动抄下这个地址', url);
      /* 剪贴板只走 HT.copyText：它自己会从 clipboard API 退到 textarea 选中
         （面板刚打开时页面没焦点，clipboard API 会失手）。这里不再抄一遍回退逻辑。 */
      HT.copyText(url).then(ok => (ok ? done() : fail()), fail);
    }

    /* 1.3 起撤掉「上次检查」与「自动重载」两行：前者是维护者要看的时间戳，
       后者在真机上从没被打开过（换文件本来就得手动放）。
       background 仍在记 updLast，只是不再往界面上搬。

       （1.9.1）起「反馈问题」与「重新加载」两颗按钮也撤了：
       前者与"出错自动上报"是两套说法，留着只会让人以为不点就不报；
       后者浏览器扩展页自己就有，在这儿再摆一颗是重复入口。 */

    const api = {
      /** 每次打开都重新读一遍：面板那边可能刚改过基准时间 */
      async refresh() {
        fill(await HT.loadCfg());
        await paintCloud();                      // 先按本机记录画一句，不用等网络
        /* 然后对一次云端（60 秒内重复打开不会重复请求）。
           真取回了新的一份，界面上的模板要跟着换——否则人会以为"保存没生效"。 */
        const r = await HT.cloud.boot().catch(() => null);
        if (r && r.pulled) fill(await HT.loadCfg());
        await paintCloud();
        await showUsed();
        paintStat(await askStat());               // 上报是后台记的，不在这一层
        paintSess();                              // 本地读 token 就够，不用等网络
        paintVer(await askUpdate(true));    // 打开即查一次：设置页是唯一能看到版本的地方，不吃 24 小时缓存
      },
      save,
      collect,
      scrollTop: () => { bodyBox.scrollTop = 0; },
      dirty: () => {
        const r = collect();
        return JSON.stringify(r.cfg) !== JSON.stringify(HT.normalizeCfg(cfg));
      }
    };

    api.refresh();
    return api;
  };
})(typeof window !== 'undefined' ? window : globalThis);
