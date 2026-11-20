/**
 * src/ui/faq.js —— 面板里的「口径与常见问题」浮层
 *
 * @file      src/ui/faq.js
 * @version   1.6.16
 * @build     2026-11-13
 * @license   MIT
 *
 * 统一合集：窗口口径、术语、校验项说明、导出差异、界面操作，全在一个浮层里。
 * 校验项按 key 引到同一份 CHECK_DOCS —— 规则改了不会出现"说明跟代码对不上"。
 * 浮层只盖住 .ht-body，标题栏和状态栏不动，所以它仍然"在面板里"，
 * 不是又一个窗口（这一点和专注一致）。
 *
 * 从 panel.js 摘出来（0.25.0）。摘的理由和段落区、模板编辑器一样：
 * 这一块的**开关状态**（`open`）以前混在面板的闭包里，于是"设置和问答互斥"
 * 这条规矩要靠两个文件里的两句注释维持——一句在 openFaq 里，一句在
 * openSettings 里，谁改漏一句就会出现"点「?」没反应"。
 * 现在互斥只写在 open() 一处：进来之前先把另一个叫 `closeOther()` 关掉。
 *
 * 依赖：HT.FAQ / HT.CHECK_DOCS（data/faq.js 的固定文案）与 `esc`。
 * 不碰存储、不碰配置、不认识通道与校验规则。
 */
(function (g) {
  'use strict';
  const HT = (g.__HT = g.__HT || {});

  /**
   * @param {object}   d
   * @param {Element}  d.el        浮层根 #ht-faq
   * @param {Element}  d.input     搜索框 #ht-fqinput
   * @param {Element}  d.list      结果列表 #ht-fqlist
   * @param {Element}  d.cnt       条数 #ht-fqcnt
   * @param {Element}  d.btn       标题栏那颗「?」 #ht-help
   * @param {Element}  d.back      「返回」#ht-fqback
   * @param {Element}  d.body      .ht-body（打开时回到顶部，否则浮层会跟着偏上去）
   * @param {Function} d.esc       转义
   * @param {object}   d.throttled HT.createThrottle() 实例
   * @param {Function} d.fitBox    面板高度重算（问答按"清单"的上限算）
   * @param {Function} d.closeOther 打开前先关掉另一块内容（设置）
   */
  HT.mountFaq = function (d) {
    const el = d.el;
    const input = d.input;
    const list = d.list;
    const cnt = d.cnt;
    const btn = d.btn;
    const body = d.body;
    const esc = d.esc;
    const throttled = d.throttled;
    const fitBox = d.fitBox;
    const closeOther = d.closeOther || (() => { });

    /** 浮层是否开着。外面只经 isOpen() 问，不直接读这根指针 */
    let open = false;

    /* 与设置同一套进出（feedback.js 的 HT.veil）。缺了它就退回硬切。 */
    const veil = HT.veil ? HT.veil(el, 130)
      : { show: () => { el.hidden = false; }, hide: cb => { el.hidden = true; if (cb) cb(); } };

    const stripTags = s => String(s == null ? '' : s).replace(/<[^>]+>/g, ' ');

    /**
     * 每条问答的元数据：条目自己写的优先，否则用所在分组的默认值。
     *
     * 为什么要"组默认 + 条目覆盖"：77 条每条都手写一遍模块与版本，改一次模块名要改 77 处，
     * 必然漏。分组是同一件事的不同侧面，默认值天然一致；个别例外（版本不同、已失效）
     * 在条目上覆盖即可。
     */
    function metaOf(it, grp) {
      const g = grp || {};
      return {
        mod: it.mod || g.mod || '',
        ver: it.ver || g.ver || '',
        upd: it.upd || g.upd || '',
        rel: it.rel || g.rel || '',
        st: it.st || '生效'
      };
    }

    /**
     * 元数据（归属模块 / 适用版本 / 更新日 / 关联 / 状态）**不显示**。
     *
     * 它原本贴在每条答案末尾，五个字段挤一行——那是给维护者对账用的，
     * 使用者看到只会以为"这条答案还在草稿阶段"。真正要让人知道的
     * 只有一件事：这条是不是已经失效了。那个用摘要上的 `.fq-tag` 表达，
     * 不用展开也看得见。
     *
     * 字段本身留着：搜索仍按模块名匹配（搜「校验」能搜到整组），
     * 只是不再占版面。
     */
    function metaOf(it, grp) {
      const g = grp || {};
      return {
        mod: it.mod || g.mod || '',
        ver: it.ver || g.ver || '',
        upd: it.upd || g.upd || '',
        rel: it.rel || g.rel || '',
        st: it.st || '生效'
      };
    }

    /** 校验项的说明并进 FAQ 的「数据校验」组，点校验行可直接跳到对应条目 */
    function checkEntries() {
      const docs = HT.CHECK_DOCS || {};
      return Object.keys(docs).map(k => ({
        key: k,
        q: docs[k].name,
        a: '<p><b>核对内容：</b>' + docs[k].what + '</p>' +
          '<p><b>异常含义：</b>' + docs[k].why + '</p>' +
          '<p><b>处置方法：</b>' + docs[k].fix + '</p>'
      }));
    }

    function faqGroups() {
      /* 校验说明单独成组（1.10.5）。它原本并进「数据校验」组，与「怎么读校验结果」
         那五条混在一起——一组三十一条，读者找不到头。两者是两个模块：
         前者讲这一栏怎么用，后者是每条判据在核什么。 */
      const out = [];
      (HT.FAQ || []).forEach(g => {
        out.push({ g: g.g, mod: g.mod, ver: g.ver, upd: g.upd, rel: g.rel, items: g.items });
        if (g.key === 'checks') {
          const docs = checkEntries();
          if (docs.length) {
            out.push({
              g: '校验项说明', mod: '自动核对', ver: g.ver, upd: g.upd, rel: '', items: docs
            });
          }
        }
      });
      /* 已知问题单独成组，排在最后：它不是"解答"，是"确实会出错的清单"。
         两者混在一列里，读者会以为"已知问题"也是一种解释。 */
      const ki = (HT.KNOWN_ISSUES || []).map(k => ({
        key: k.id,
        q: k.t,
        a: '<p>' + k.sym + '</p>' +
          '<p><b>临时做法：</b>' + k.work + '</p>' +
          '<p><b>修复计划：</b>' + k.plan + '</p>' +
          '<p class="fq-scope">影响版本 ' + k.ver + ' · ' + k.scope + '</p>',
        mod: '已知缺陷', ver: k.ver, upd: k.upd, rel: '', st: k.st
      }));
      if (ki.length) {
        out.push({ g: '已知问题（Known Issue）', mod: '已知缺陷', ver: '见各条',
          upd: '2026-11-15', rel: '', items: ki });
      }
      return out;
    }

    function draw(kw, focusKey) {
      const q = String(kw || '').trim().toLowerCase();
      let total = 0;
      const html = faqGroups().map(grp => {
        /* 组名也参与匹配：搜「口径」时整组留下。
           只匹配条目文本的话，最该看的那一组反而一条都搜不到——
           用户按分类找东西，分类名本身必须能被搜到。 */
        const byGroup = !!q && grp.g.toLowerCase().indexOf(q) >= 0;
        const items = byGroup ? grp.items : grp.items.filter(it => !q ||
          (it.q + ' ' + stripTags(it.a) + ' ' + (it.mod || grp.mod || ''))
            .toLowerCase().includes(q));
        if (!items.length) return '';
        total += items.length;
        /* 分类标题后面挂条数：清单长的时候，人先看"这一类有几条"再决定要不要翻 */
        return '<div class="fq-g">' + esc(grp.g) +
          '<i class="fq-gn">' + items.length + '</i></div>' + items.map(it => {
            const m = metaOf(it, grp);
            const isOpen = focusKey && it.key === focusKey ? ' open' : '';
            const k = it.key ? ' data-key="' + esc(it.key) + '"' : '';
            /* 已修复/已失效的留档条目在摘要上直接标出来，不用展开才知道。
               用 span 而不是 ::after：标签要能选中、能被搜索到，也要能单独调字号。 */
            const done = m.st === '已修复' || m.st === '已失效';
            const attr = done ? ' data-st="' + esc(m.st) + '"' : '';
            const tag = done ? ' <span class="fq-tag">' + esc(m.st) + '</span>' : '';
            /* it.a 全部来自 data/faq.js 的固定文案，不接受外部输入 */
            return '<details class="fq"' + k + attr + isOpen + '><summary>' + esc(it.q) + tag + '</summary>' +
              '<div class="fq-a">' + it.a + '</div></details>';
          }).join('');
      }).join('');
      list.innerHTML = html || '<div class="fq-none">没有匹配的问题，换个词试试</div>';
      cnt.textContent = q ? total + ' 条' : '共 ' + total + ' 条';
    }

    /**
     * @param {string} [kw]        预填搜索词
     * @param {string} [focusKey]  直接展开某条校验项的说明
     */
    function openFaq(kw, focusKey) {
      /* 设置和问答是同一块地方的两种内容，必须互斥。
         少了这一句就会出现：面板在设置里 → 点「?」没反应（问答被设置盖住了）
         → 再点齿轮想回到设置，却把设置关掉，露出底下那个一直开着的问答。 */
      closeOther();
      open = true;
      veil.show();
      btn.setAttribute('aria-expanded', 'true');
      /* 浮层是绝对定位在 .ht-body 的 padding box 上的，
         body 若还停在滚到一半的位置，浮层就会跟着偏上去 */
      body.scrollTop = 0;
      if (typeof kw === 'string') input.value = kw;
      draw(input.value, focusKey);
      list.scrollTop = 0;
      fitBox();          // 问答按"清单"的高度上限重算，切换回来时再算回去
      const hit = focusKey && list.querySelector('details[data-key="' + focusKey + '"]');
      if (hit) {
        /* 滚到那一条眼前。offsetTop 相对 .fq-list（它自己就是定位容器）。
           多减 30px 是给分组标题让位——它是 sticky 的，会盖住滚到最上面的那一行，
           正好把要看的那个问题压住。 */
        list.scrollTop = Math.max(0, hit.offsetTop - 30);
      } else {
        try { input.focus({ preventScroll: true }); } catch (e) { }
      }
    }

    /** @param {boolean} [restore] 关掉后把焦点还给标题栏那颗「?」 */
    function close(restore) {
      if (!open) return;
      open = false;
      /* 面板高度等淡出结束再回落，否则浮层会在还剩一半不透明时被裁一截 */
      veil.hide(fitBox);
      btn.setAttribute('aria-expanded', 'false');
      input.value = '';
      if (restore) { try { btn.focus({ preventScroll: true }); } catch (e) { } }
    }

    const toggle = () => (open ? close() : openFaq(''));

    /* ── 事件 ─────────────────────────────────────────────────
       绑在自己的三处：标题栏那颗「?」、浮层里的「返回」、搜索框。
       以前这四行散在面板的事件区里，和设置、生成、导出混在一段。 */
    btn.addEventListener('click', () => { if (!throttled('faq', 200)) toggle(); });
    d.back.addEventListener('click', () => close(true));
    input.addEventListener('input', () => draw(input.value));
    btn.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' && open) { e.preventDefault(); input.focus(); }
    });

    return { open: openFaq, close, toggle, isOpen: () => open };
  };
})(typeof window !== 'undefined' ? window : globalThis);
