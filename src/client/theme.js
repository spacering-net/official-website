// The theme of a page in the site's frame (layouts/Page.astro), set before its
// first paint: light if that was chosen here (sr-theme: light, dark, system),
// or "system" was and the system is light; dark otherwise. A plain blocking
// script, as these pages allow no inline ones. client/page.ts switches it.
(function () {
  var pref = null;
  try {
    pref = localStorage.getItem('sr-theme');
  } catch (e) {}
  if (pref === 'light' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: light)').matches)) {
    document.documentElement.setAttribute('data-theme', 'light');
    var color = document.querySelector('meta[name="theme-color"]');
    var scheme = document.querySelector('meta[name="color-scheme"]');
    if (color) color.setAttribute('content', '#f6f5f1');
    if (scheme) scheme.setAttribute('content', 'light');
  }
})();
