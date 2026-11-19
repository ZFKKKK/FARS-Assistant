/**
 * src/ui/editor.js — 段落模板编辑器
 *
 * 从 settings.js 里整段搬出来的（0.25.0）。搬的理由不是行数，是**职责**：
 * 这一段管的是「一段公文正文怎么被编辑」——光标、chip、序列化、三级级联，
 * 全都是编辑器自己的事；而 settings.js 该管的是「有哪些设置项、怎么存」。
 * 两者混在一起时，加一个设置项要在一份 1,400 行的文件里翻到第 900 行去改事件分发。
 *
 * 依赖注入的两样东西：
 *   - openPop / closePop：浮层是设置页共用的（中心城区选择器也用它），
 *     编辑器不自己造第二套浮层，否则同一个抽屉会有两种开合手感。
 *   - msg：提示条归设置页所有，编辑器只说"最多 6 段"这类事实。
 *
 * 事件边界：编辑器**自己**在自己那棵子树（box）和浮层里绑事件，
 * 不再让 settings.js 用一个 190 行的分发器代劳。处理完的事件 stopPropagation，
 * 于是"哪些点击属于编辑器"在代码里是看得见的。
 *
 * @version   1.6.16
 */
(function () {
  'use strict';

  const g = typeof window !== 'undefined' ? window : globalThis;
  const HT = (g.__HT = g.__HT || {});
  const esc = s => (HT.esc ? HT.esc(s) : String(s == null ? '' : s));

  /** 模板正文 → 编辑区 DOM：文字照写，占位符变成不可编辑的 chip */
  function toEditor(text) {
    return HT.parse(text).map(p => {
      if (p.t === 'text') return esc(p.s).replace(/\n/g, '<br>');
      return '<span class="tk" contenteditable="false" data-t="' +
        esc(p.k === 'seg' ? 'seg:' + p.key : 'f:' + p.key + '|' + p.mode) + '">' +
        esc(HT.chipLabel(p)) + '</span>';
    }).join('');
  }

  /** 编辑区 DOM → 模板正文。这里读，别处不再读一遍，免得两套规则 */
  function readEditor(el) {
    let out = '';
    (function walk(node) {
      const kids = node.childNodes || [];
      for (let i = 0; i < kids.length; i++) {
        const n = kids[i];
        if (n.nodeType === 3) { out += n.nodeValue; continue; }
        if (n.nodeType !== 1) continue;
        const tag = n.nodeName;
        if (tag === 'BR') { out += '\n'; continue; }
        if (n.classList && n.classList.contains('tk')) {
          out += '{{' + (n.dataset.t || '') + '}}';
          continue;
        }
        walk(n);
        if (tag === 'DIV' || tag === 'P') out += '\n';
      }
    })(el);
    return out.replace(/\u00a0/g, ' ').replace(/\n+$/, '');
  }

  /**
   * 挂一个模板编辑器。
   * @param {{
   *   box: HTMLElement,            // [data-f="tpls"] 容器
   *   pop: HTMLElement,            // 设置页共用的浮层
   *   openPop: Function,           // (anchor, html, wide)
   *   closePop: Function,
   *   msg?: Function               // (text, tip)
   * }} o
   */
  HT.mountEditor = function (o) {
    const box = o.box;
    const pop = o.pop;
    const say = o.msg || function () { };
    if (!box) throw new Error('mountEditor 需要一个 box 容器');

    /* ── 状态 ─────────────────────────────────────────────
       list 是工作副本：编辑区是唯一真相，编辑完才落回 list。
       切换档案时整份换掉（load），不会出现"上一份的正文还在编辑区里"。 */
    let list = [];
    let editing = -1;       // 正在编辑的模板下标
    let caret = null;       // 开浮层前记下的光标位置
    let editChip = null;    // 正在改的那个 chip（null = 插入新的）
    let popAnchor = null;   // 浮层锚点（改标签时是那个 chip）
    let pickCat = (HT.INS_CATS && HT.INS_CATS[0] && HT.INS_CATS[0].c) || 'time';

    /* 段落操作图标：arrow-up / arrow-down / trash（Tabler Outline）。
       尺寸与颜色由 .st-ops button svg 决定。 */
    /* 上移/下移/删除三个图标取自 HT.ICON（src/ui/dom.js）：
       这里不再自己写一份 svg——同一个"删除"在两个文件里各写一遍，
       迟早一个改了线宽、一个忘了 aria-hidden。 */
    /* ── 渲染 ───────────────────────────────────────────── */
    function draw() {
      box.innerHTML = list.map((t, i) => {
        const sum = HT.summary(t.text);
        const ed = editing === i;
        return `<div class="st-tpl${ed ? ' is-ed' : ''}" data-i="${i}">
          <div class="st-tpl-h">
            <button class="st-sw" type="button" role="switch" aria-checked="${t.on ? 'true' : 'false'}"
                    data-act="tplOn"><i></i></button>
            <input class="st-tin" type="text" value="${esc(t.title)}" maxlength="30" data-act="tplTitle" aria-label="段落标题">
            <span class="st-sum">${esc(sum)}</span>
            <span class="st-ops">
              <button type="button" data-act="edit">${ed ? '完成' : '编辑'}</button>
              <button type="button" data-act="up" aria-label="上移"${i === 0 ? ' disabled' : ''}>${HT.ICON.arrowUp}</button>
              <button type="button" data-act="down" aria-label="下移"${i === list.length - 1 ? ' disabled' : ''}>${HT.ICON.arrowDown}</button>
              <button type="button" data-act="del" aria-label="删除这一段"${list.length <= 1 ? ' disabled' : ''}>${HT.ICON.trash}</button>
            </span>
          </div>
          ${ed ? `<div class="st-ed">
            <div class="st-tools">${(HT.INS_CATS || []).map(x =>
          `<button type="button" data-cat-ins="${esc(x.c)}"
                       title="插入${esc(x.label)}类默认项">${esc(x.label)}</button>`
        ).join('')}</div>
            <div class="st-ce" contenteditable="true" spellcheck="false"
                 role="textbox" aria-multiline="true" aria-label="模板正文">${toEditor(t.text)}</div>
          </div>` : ''}
        </div>`;
      }).join('');
      if (editing >= 0) {
        const ce = box.querySelector('.st-ce');
        if (ce) syncCnt(ce);
      }
    }

    function syncCnt(ce) {
      if (!ce) return;
      const text = readEditor(ce);
      /* 行头那句「28 个数据」得跟着变：刚插了两个数，
         摘要却还停在插入前，会让人以为插入没生效。
         字数不显示（0.19.0）——模板是给机器读的，写的人不需要边写边数字。 */
      const row = ce.closest('.st-tpl');
      const sum = row && row.querySelector('.st-sum');
      if (sum) sum.textContent = HT.summary(text);
    }

    /** 保存正在编辑的那段文字（编辑区是唯一真相，切换前先落回 list） */
    function flush() {
      if (editing < 0) return;
      const ce = box.querySelector('.st-ce');
      /* 这里不做长度截断：截断点可能正好落在 {{f:xxx}} 中间，剪出半截 "{{f"
         之后 prune 认不出来（它不是坏 token，只是普通文字），于是一段乱码
         原样进正文，用户还不知道自己被截了。超长交给 collect() 拒绝保存。 */
      if (ce && list[editing]) list[editing].text = readEditor(ce);
    }

    /* ── 插入占位符 ─────────────────────────────────────── */
    /* ── 光标位置：点选插入必须落在用户指的那个地方 ──────────
       动线是"编辑区点一下 → 点工具栏按钮 → 在浮层里选 → 点插入"，
       这中间焦点两次离开 contenteditable。浏览器在 blur 之后不保证
       selection 还停在原处，很多情况下 getSelection() 拿到的是空，
       于是标签被默默 append 到段尾——用户以为没插上，或者插错了地方。
       所以开浮层的那一刻就把光标记下来，插入时优先用它。 */
    const editorEl = () => box.querySelector('.st-ce');

    function saveCaret() {
      const ce = editorEl();
      const sel = selOf(ce);
      caret = (ce && sel && sel.rangeCount && ce.contains(sel.anchorNode))
        ? sel.getRangeAt(0).cloneRange() : null;
    }

    /** 记下的位置可能因为重绘而失效，用之前必须确认容器还在这块 DOM 里 */
    function liveCaret(ce) {
      return (caret && ce.contains(caret.startContainer) && ce.contains(caret.endContainer))
        ? caret : null;
    }

    function insertChip(raw) {
      const ce = editorEl();
      if (!ce) return;
      const tok = HT.parseTok(raw);
      if (!tok) return;
      const span = document.createElement('span');
      span.className = 'tk';
      span.contentEditable = 'false';
      span.dataset.t = raw;
      span.textContent = HT.chipLabel(tok);

      ce.focus();
      const sel = selOf(ce);
      /* 三级回退：开浮层时记下的位置 → 当前选区 → 段尾 */
      let r = liveCaret(ce);
      if (!r && sel && sel.rangeCount && ce.contains(sel.anchorNode)) r = sel.getRangeAt(0);

      if (r) {
        try {
          r.deleteContents();
          r.insertNode(span);
          /* 插完把光标放到 chip 后面，接着能打字 */
          const after = document.createRange();
          after.setStartAfter(span);
          after.collapse(true);
          sel.removeAllRanges();
          sel.addRange(after);
        } catch (e) {
          /* 位置已随重绘失效时 insertNode 会抛错，别让整段话停在半截 */
          ce.appendChild(span);
        }
      } else {
        ce.appendChild(span);
      }
      caret = null;
      syncCnt(ce);
    }

    /* ── 改已插入的标签 ───────────────────────────────────
       变量化之后一段正文里有二三十个标签，改错一个就得删掉重插的话，
       这段文字就没法维护了。所以点标签直接打开对应的选择器，选完就地替换：
       seg 标签打开整段列表，数据标签打开三级级联并预先选回它当前的指标。 */
    function replaceChip(tk, raw) {
      const tok = HT.parseTok(raw);
      if (!tok || !tk || !tk.parentNode) return;
      tk.dataset.t = raw;
      tk.textContent = HT.chipLabel(tok);
      const ce = box.querySelector('.st-ce');
      if (ce) syncCnt(ce);
    }

    /** 选定一个占位符：有正在改的标签就替换它，否则在光标处插入 */
    function useRaw(raw) {
      const target = editChip;
      editChip = null;          // 一次只改一个：用完就清，免得下一次误替换
      if (target) replaceChip(target, raw); else insertChip(raw);
      o.closePop();
    }

    /* ── 插入：七大类就是七个按钮 ─────────────────────────
       0.19 起工具栏直接把七大类摆出来，点一下该类默认项就落到光标处，
       不再有「插入」按钮 + 浮层选卡这一步。理由很直白：九成的插入就是
       "接处警总数""成灾火灾起数"这么几个数，为一个动作开两次界面不值。
       要精细选择，就点正文里刚插进去的那个标签——它打开的才是这一类的小类、
       全部字段和写法。清单全部来自 fields.js，界面不自己拼选项。 */

    /** 改标签时的页签：只切大类，下面的级联始终跟着走 */
    function catTabs(cat) {
      return `<div class="st-cats">${(HT.INS_CATS || []).map(x =>
        `<button type="button" class="st-cat${x.c === cat ? ' is-on' : ''}" data-cat="${x.c}"
                 aria-pressed="${x.c === cat ? 'true' : 'false'}">${esc(x.label)}</button>`
      ).join('')}</div>`;
    }

    /** 级联体：只出现在"改已有标签"这条路上（插入是卡片一步到位）
     *  浮层只剩"改已有标签"一条路，所以这里永远是「替换」；留 data-act 是因为
     *  替换要走 insertChip 之外的分支（就地换 dataset）。
     *  顺手修掉一处（0.25.0）：这段说明原来写在模板字符串**里面**，用 CSS 那种
     *  块注释包着，浏览器不认，于是整段中文原样显示在浮层底部——0.19 起就这样。 */
    function cascadeBody() {
      return `<div class="st-cas">
        <select class="st-sel" data-c="g" aria-label="分组"></select>
        <select class="st-sel" data-c="k" aria-label="指标"></select>
        <select class="st-sel" data-c="v" aria-label="写法" hidden></select>
      </div>
      <div class="st-cas-foot"><span class="st-sp"></span>
        <button class="st-btn st-primary" type="button" data-act="casIns">替换</button></div>`;
    }

    /** 整段成文：只剩历史标签还用得上，入口已经撤了（见 renderPicker） */
    function segBody() {
      return `<div class="st-pop-g">插入后可直接改字</div>` + HT.autoOptions().map(a =>
        `<button type="button" class="st-pop-i" data-ins-seg="${esc(a.k)}">${esc(a.label)}</button>`
      ).join('');
    }

    /**
     * 画「改标签」菜单（浮层只剩这一条路：点正文里的标签）。
     * @param {Element|null} anchor  浮层锚点（正文里的那个标签）
     * @param {string} cat           大类
     * @param {string} [preKey]      要预选的字段
     * @param {string} [preMode]     要预选的写法
     */
    function renderPicker(anchor, cat, preKey, preMode) {
      const wanted = cat || pickCat;
      /* 「整段成文」不在大类清单里了，但老正文里的 {{seg:xxx}} 标签点开
         还得能换一套——否则那些标签只能删掉重写。所以这一支保留，
         只是没有卡片、也不在工具栏暴露。
         注意这里判的是 wanted 而不是 pickCat：pickCat 是"改标签时停在哪一类"，
         被 seg 污染之后下次点标签会直接看到整段成文列表。 */
      if (!(HT.INS_CATS || []).some(x => x.c === wanted)) {
        popAnchor = anchor;
        o.openPop(anchor, segBody(), true);
        return;
      }
      /* 改已有标签：给这一类的全部小类 / 字段 / 写法 */
      pickCat = wanted;
      popAnchor = anchor;
      o.openPop(anchor, catTabs(pickCat) + cascadeBody(), true);
      fillCascade(preKey, preMode);
    }

    function openChipEditor(tk) {
      const tok = HT.parseTok(tk.dataset.t || '');
      if (!tok) return;
      /* 先记下来再开浮层：菜单底部的按钮要按它写成「替换」 */
      editChip = tk;
      if (tok.k === 'seg') {
        renderPicker(tk, 'seg');
      } else {
        renderPicker(tk, HT.catOf ? HT.catOf(tok.key) : 'data', tok.key, tok.mode);
      }
    }

    /** 当前分类下的组（数据里不会出现时间） */
    const curGroups = () => (HT.groupsOf ? HT.groupsOf(pickCat) : (HT.FIELD_GROUPS || []));

    /**
     * 填级联：先按分类重画组下拉，再按预选把组和字段拉回去。
     * @param {string} [preKey]  要预选的字段
     * @param {string} [preMode] 要预选的写法
     */
    function fillCascade(preKey, preMode) {
      const gSel = pop.querySelector('[data-c="g"]');
      if (!gSel) return;
      const groups = curGroups();
      gSel.innerHTML = groups.map((grp, i) => `<option value="${i}">${esc(grp.g)}</option>`).join('');
      /* 预选要把"组"也一起拉回去：字段按组分布，停在第一组时
         那个字段根本不在列表里，select 会静默显示成组里的第一项。 */
      if (preKey) {
        const gi = groups.findIndex(grp => (grp.items || []).some(f => f.k === preKey));
        if (gi >= 0) gSel.value = String(gi);
      }
      fillFields(preKey, preMode);
    }

    function fillFields(preKey, preMode) {
      const kSel = pop.querySelector('[data-c="k"]');
      if (!kSel) return;
      const groups = curGroups();
      const gSel = pop.querySelector('[data-c="g"]');
      const grp = groups[Number(gSel.value)] || groups[0];
      const items = grp ? grp.items : [];
      kSel.innerHTML = items.map(f => `<option value="${esc(f.k)}">${esc(f.label)}</option>`).join('');
      if (preKey && items.some(f => f.k === preKey)) kSel.value = preKey;
      fillModes(preMode);
    }

    function fillModes(preMode) {
      const kSel = pop.querySelector('[data-c="k"]');
      const vSel = pop.querySelector('[data-c="v"]');
      if (!kSel || !vSel) return;
      const modes = HT.modesOf(kSel.value) || [];
      vSel.innerHTML = modes.map(m => `<option value="${esc(m.k)}">${esc(m.label)}</option>`).join('');
      /* 只有一种写法就收起来。成品句、原文类字段永远只有「原文」一项，
         摆在那儿只会让人以为还有别的可选，点开又发现没有。 */
      vSel.hidden = modes.length <= 1;
      if (preMode && [].some.call(vSel.options, o2 => o2.value === preMode)) vSel.value = preMode;
    }

    /* ── 列表级操作（新增 / 恢复出厂 / 换一份） ───────────── */

    /** 换一份列表并重画（切档案、导入、首次打开都走这里） */
    function load(arr) {
      list = (arr || []).map(t => Object.assign({}, t));
      editing = -1;
      caret = null;
      editChip = null;
      draw();
    }

    /** 当前列表（编辑区内容先落回，调用方拿到的一定是最新的） */
    function value() {
      flush();
      return list;
    }

    function add() {
      if (list.length >= HT.MAX_TPL) { say(`最多 ${HT.MAX_TPL} 段`); return; }
      flush();
      list.push({
        id: 't' + Date.now().toString(36),
        title: '第' + (list.length + 1) + '段',
        on: true,
        text: ''
      });
      editing = list.length - 1;
      draw();
    }

    /** 整份替换成出厂内容（确认那句由调用方问，编辑器不弹框） */
    function resetTo(arr) {
      list = (arr || []).map(t => Object.assign({}, t));
      editing = -1;
      draw();
    }

    /* ── 事件：编辑器只在自己这两棵子树里绑 ─────────────────
       box  = 模板列表（含编辑区、工具栏、行内按钮）
       pop  = 浮层里的页签与三级级联
       两处的坐标都由 mountEditor 注入，不再让设置页代管。 */

    /* 点工具栏那七个按钮时，编辑区会先失去焦点。必须在 pointerdown 的捕获阶段
       就把光标记下来——等 click 再记，选区已经不在编辑区里，
       插入会默默跑到段尾，人只会觉得"插错地方了"。 */
    box.addEventListener('pointerdown', e => {
      if (e.target.closest && e.target.closest('.st-tools [data-cat-ins]')) saveCaret();
    }, true);

    box.addEventListener('click', e => {
      /* 点正文里的标签 = 改这个指标。必须排在 data-act 判定之前：
         标签上没有 data-act，落下去会被当成"点空白"，只是把浮层关掉。 */
      const tk = e.target.closest ? e.target.closest('.st-ce .tk') : null;
      if (tk) {
        e.preventDefault();
        e.stopPropagation();
        openChipEditor(tk);
        return;
      }

      /* 大类按钮：点它 = 立刻插入该类的默认项并收起浮层。
         这一路永远是"插新的"——0.19 撤掉「插入」按钮时，把
         editChip = null 也一起撤掉了，结果点过某个标签之后再点工具栏，
         会去替换那个标签而不是插入。这里补回来。 */
      const cc = e.target.closest('[data-cat-ins]');
      if (cc) {
        e.stopPropagation();
        editChip = null;
        const d = HT.defaultOf ? HT.defaultOf(cc.dataset.catIns) : null;
        if (d) useRaw('f:' + d.k + '|' + d.mode);
        else o.closePop();
        return;
      }

      const b = e.target.closest('button[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      const tplEl = b.closest('.st-tpl');
      const i = tplEl ? Number(tplEl.dataset.i) : -1;
      if (i < 0) return;

      /* 启用开关：**必须**改 list 里的值，不能只翻 aria-checked。
         0.24 的通用 .st-sw 分支排在 data-act 之前就 return 了，
         这条 tplOn 从来没被执行过——开关点着像生效，保存后原样回去。 */
      if (act === 'tplOn') {
        e.stopPropagation();
        list[i].on = !list[i].on;
        b.setAttribute('aria-checked', list[i].on ? 'true' : 'false');
        return;
      }
      if (act === 'edit') {
        e.stopPropagation();
        flush();
        editing = editing === i ? -1 : i;
        draw();
        return;
      }
      if (act === 'up' && i > 0) {
        e.stopPropagation();
        flush();
        const t = list[i - 1]; list[i - 1] = list[i]; list[i] = t;
        if (editing === i) editing = i - 1; else if (editing === i - 1) editing = i;
        draw();
        return;
      }
      if (act === 'down' && i < list.length - 1) {
        e.stopPropagation();
        flush();
        const t = list[i + 1]; list[i + 1] = list[i]; list[i] = t;
        if (editing === i) editing = i + 1; else if (editing === i + 1) editing = i;
        draw();
        return;
      }
      if (act === 'del' && list.length > 1) {
        e.stopPropagation();
        flush();
        list.splice(i, 1);
        if (editing === i) editing = -1;
        else if (editing > i) editing--;
        draw();
      }
    });

    /* ── 逐字晕开 ─────────────────────────────────────────
       手动打字时，刚上屏的字从 blur(6px) 化开，单字 90ms，
       相邻字错开 30ms——一串字进来是"晕开"，不是一个一个往外蹦。
       为什么只认 insertText：中文输入法还在候选框里（composition）时动 DOM
       会打断输入法；粘贴与删除也不是"打字"，都不该有这道动画。
       为什么包 span 是安全的：readEditor 是递归 walk 文本节点的，
       多一层 .ch 只多走一层递归，取到的字一个不差（取值规则只有一份）。
       ─────────────────────────────────────────────────── */
    /**
     * 取"自己这棵树"里的选区。
     *
     * 面板整块在 Shadow Root 里，`window.getSelection()` 拿到的是**文档**那棵树
     * 的选区——实测 startContainer 是 `<body>`、rangeCount 恒为 1。
     * 拿它去算偏移永远对不上 data，于是每个字都静默地不演（症状：
     * 打字完全正常，但一个 `.ch` 都生不出来，界面上只是"没有动画"）。
     * Chrome 给 ShadowRoot 补了 getSelection()，优先用它；其它内核退回 window，
     * 退回去的那条最多是"没有动画"，不影响打字。
     */
    function selOf(node) {
      const root = node && node.getRootNode ? node.getRootNode() : null;
      if (root && typeof root.getSelection === 'function') return root.getSelection();
      return g.getSelection();
    }

    function inkNewChars(ev) {
      if (ev.inputType !== 'insertText' || ev.isComposing) return;
      const data = ev.data;
      /* 一次上屏超过 24 字（长词、输入法整句）不逐字演：那边界的动画
         会拖到 700ms 以上，读的人会以为卡住了。 */
      if (!data || data.length > 24) return;
      const sel = selOf(ev.target);
      if (!sel || !sel.rangeCount) return;
      const r = sel.getRangeAt(0);
      const node = r.startContainer;
      if (!node || node.nodeType !== 3) return;
      const end = r.startOffset;
      const start = end - data.length;
      /* 光标的偏移与 data 对不上，说明这次插入不是"在这里打了这几个字"
         （常见于输入法组合、浏览器自带撤销重做），放过，别猜。 */
      if (start < 0 || node.nodeValue.slice(start, end) !== data) return;
      /* 只**包裹**，不删除、不重建：
         surroundContents 把已有的这几个字包进一个 span，文本一个都不动；
         写坏的后果最多是"这一串没有动画"，不会吞字。
         （先用 deleteContents 再 insertNode 的写法试过——只要偏移算错一位，
           整段字就被替换掉了，在 contenteditable 上这是不可接受的失败方式。） */
      const range = g.document.createRange();
      range.setStart(node, start);
      range.setEnd(node, end);
      const wrap = g.document.createElement('span');
      wrap.className = 'in';
      try { range.surroundContents(wrap); } catch (e) { return; }
      /* 再在这个刚包出来的安全区域里逐字拆开——拆的是文本节点，内容不变，
         只是为了给每个字错开 30ms。 */
      const chars = [...wrap.textContent];
      wrap.textContent = '';
      let made = 0;
      chars.forEach((ch, i) => {
        if (/\s/.test(ch)) { wrap.appendChild(g.document.createTextNode(ch)); return; }
        const s = g.document.createElement('span');
        s.className = 'ch';
        s.style.animationDelay = (i * 30) + 'ms';
        s.textContent = ch;
        wrap.appendChild(s);
        made++;
      });
      /* 只上屏了空白（敲一个空格、一次换行）：没有字要演，壳当场拆掉。
         留着它永远等不到 animationend，正文里会越堆越多空 span。 */
      if (!made) {
        const p0 = wrap.parentNode;
        while (wrap.firstChild) p0.insertBefore(wrap.firstChild, wrap);
        p0.removeChild(wrap);
        return;                    // 光标本来就在插入点之后，不用再设
      }
      /* 光标落到包好的这一串之后。不重设的话，range 还指着已经被包进 span
         的旧文本节点，下一个字会打不进去。 */
      const after = g.document.createRange();
      after.setStartAfter(wrap);
      after.collapse(true);
      sel.removeAllRanges();
      sel.addRange(after);
    }

    /* 动画播完把 .ch 拆回纯文本，再把空掉的 .in 外壳展开，别让 span 越堆越多。
       两个关键做法：
       ① 只**搬节点**、不重建——把 .ch 里的文本节点原样挪到父级再删空壳。
          光标锚在这个文本节点上时，搬完仍在原位，一个字都不会吞。
       ② 因此不需要"光标在不在里面"的闸门。早先那道闸门会漏掉最后一个字：
          浏览器在 input 事件之后会把光标落回插入点，也就是最后一个 .ch 内部，
          于是它永远收不掉，每打一批字就留下一个 .ch 加一个 .in。 */
    box.addEventListener('animationend', e => {
      const s = e.target;
      if (!s.classList || !s.classList.contains('ch')) return;
      const wrap = s.closest && s.closest('.in');
      if (s.parentNode) {
        const p = s.parentNode;
        while (s.firstChild) p.insertBefore(s.firstChild, s);
        p.removeChild(s);
      }
      if (!wrap || !wrap.parentNode) return;
      if (wrap.querySelector('.ch')) return;      // 还有字在演，等它们
      const p2 = wrap.parentNode;
      while (wrap.firstChild) p2.insertBefore(wrap.firstChild, wrap);
      p2.removeChild(wrap);
    });

    box.addEventListener('input', e => {
      const t = e.target;
      if (t.matches('[data-act="tplTitle"]')) {
        const i = Number(t.closest('.st-tpl').dataset.i);
        if (list[i]) list[i].title = t.value;
        return;
      }
      if (t.classList && t.classList.contains('st-ce')) {
        inkNewChars(e);
        syncCnt(t);
      }
    });

    /* 编辑区：粘贴一律转纯文本；Enter 插换行而不是 <div>（序列化更稳） */
    box.addEventListener('paste', e => {
      const ce = e.target.closest && e.target.closest('.st-ce');
      if (!ce) return;
      e.preventDefault();
      const txt = (e.clipboardData || g.clipboardData || {}).getData
        ? (e.clipboardData || g.clipboardData).getData('text/plain') : '';
      if (!txt) return;
      const sel = selOf(ce);
      if (!sel || !sel.rangeCount) return;
      const r = sel.getRangeAt(0);
      r.deleteContents();
      const frag = document.createDocumentFragment();
      txt.split(/\r?\n/).forEach((line, i2) => {
        if (i2) frag.appendChild(document.createElement('br'));
        frag.appendChild(document.createTextNode(line));
      });
      r.insertNode(frag);
      syncCnt(ce);
    });

    /* 浮层里属于编辑器的部分：页签、三级级联、「替换」、整段成文列表 */
    pop.addEventListener('click', e => {
      const catBtn = e.target.closest('[data-cat]');
      if (catBtn) {
        e.stopPropagation();
        renderPicker(popAnchor, catBtn.dataset.cat);
        return;
      }
      const seg = e.target.closest('[data-ins-seg]');
      if (seg) {
        e.stopPropagation();
        useRaw('seg:' + seg.dataset.insSeg);
        return;
      }
      const b = e.target.closest('button[data-act="casIns"]');
      if (b) {
        e.stopPropagation();
        const k = pop.querySelector('[data-c="k"]');
        const v = pop.querySelector('[data-c="v"]');
        if (k && k.value) useRaw('f:' + k.value + '|' + (v ? v.value : 'num'));
        else o.closePop();
      }
    });

    pop.addEventListener('change', e => {
      const t = e.target;
      if (t.matches('[data-c="g"]')) { fillFields(); return; }
      if (t.matches('[data-c="k"]')) { fillModes(); }
    });

    /** Esc：退出编辑态。返回 true 表示"这次 Esc 归我" */
    function exitEditing() {
      if (editing < 0) return false;
      flush();
      editing = -1;
      draw();
      return true;
    }

    return {
      load,
      value,
      draw,
      flush,
      add,
      resetTo,
      exitEditing,
      isEditing: () => editing >= 0
    };
  };
})(typeof window !== 'undefined' ? window : globalThis);
