/* 进站引导状态机（每会话一次）。
   这个站线上 CSP 会拦内联脚本，所以套件写在同源文件里。
   playing = 品牌 + 光标已可见的静态预引导；
   go = 遮罩首帧真正上屏后才起播全部阶段动画（慢网络下不会被提前跑完截断）；
   进度条 chFill 结束 +450ms → 加 boot-out 淡出 → chOut 结束切 done 卸载。
   无 JS / 减少动效 → 遮罩不出现，直接进正文。
   整体包在 IIFE 里：避免 d / s / go / start / out 这些全局名和页面自身脚本互相覆盖。 */
(function () {
try {
  var d = document.documentElement, s = sessionStorage;
  if (s.getItem('boot-seen')) {
    d.dataset.boot = 'done';
  } else if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) {
    d.dataset.boot = 'done';
    s.setItem('boot-seen', '1');
  } else {
    s.setItem('boot-seen', '1');
    d.dataset.boot = 'playing';
    var out = function () { if (d.dataset.boot === 'go') { d.classList.add('boot-out'); } };
    var cap = setTimeout(function () { if (d.dataset.boot === 'playing') { d.dataset.boot = 'done'; } else { out(); } }, 9000);
    var start = function () {
      if (d.dataset.boot !== 'playing') return;
      d.dataset.boot = 'go';
      clearTimeout(cap);
      cap = setTimeout(out, 5600);
    };
    document.addEventListener('animationend', function (e) {
      if (e.animationName === 'chFill') { setTimeout(out, 450); }
      else if (e.animationName === 'chOut') { d.dataset.boot = 'done'; }
    });
    var go = function () {
      if (d.dataset.boot !== 'playing') return;
      if (!document.getElementById('boot')) { if (go.n++ !== 100) { setTimeout(go, 30); return; } }
      var r = window.requestAnimationFrame;
      r ? r(function () { r(start); }) : setTimeout(start, 32);
    };
    go.n = 0;
    go();
  }
} catch (e) {}
})();
