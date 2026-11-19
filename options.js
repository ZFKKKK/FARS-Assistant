/**
 * options.js —— 独立设置页的引导脚本（十行）
 *
 * @file        options.js
 * @version     见 src/data/release.js（此处不再写具体号，写了就会过期）
 * @license     MIT
 * @description 只做三件事：显示版本、把 settings.js 挂到 #host、把保存结果回显
 * @requires    src/ui/settings.js 与它依赖的 lib/data/domain
 *
 * 设置本身不在这里：面板里的齿轮浮层与这一页挂的是同一个
 * `HT.mountSettings`，改一处两边都生效。这一页只提供更宽的挂载点。
 */
(function () {
  'use strict';
  const HT = window.__HT;
  const $ = id => document.getElementById(id);

  /* 这一页是最需要装监听的：settings.js 一千多行，是整套脚本里唯一真有
     "未捕获异常把自己白屏掉"风险的地方。装在最前面，连下面 showVersion
     抛错也能记下来。 */
  try { if (HT.obs && HT.obs.install) HT.obs.install('options'); } catch (e) { }

  /** 版本：以清单为准，脚本与清单不一致时变红——那说明改了没重新加载扩展 */
  (function showVersion() {
    const META = HT.META || {};
    const el = $('ver');
    let v = META.version || '';
    try { v = chrome.runtime.getManifest().version; } catch (e) { }
    el.textContent = 'v' + v;
    el.title = META.build ? `构建 ${META.build}` : '';
    if (META.version && META.version !== v) {
      el.textContent = `v${v} ≠ ${META.version}`;
      el.classList.add('is-stale');
      el.title = `清单 ${v} 与脚本 ${META.version} 不一致，请重新加载扩展`;
    }
  })();

  /* 界面字体（fonts/ht-sans.woff2）。这一页是普通扩展页，字体照样走
     HT.loadFont——两条挂载点共用一份实现，别在这里另写一条 CSS。
     不 await：设置页正文先出，字体到了自己换上去，卡在字体上是本末倒置。 */
  try { HT.loadFont(); } catch (e) { }

  HT.mountSettings($('host'), {});
})();
