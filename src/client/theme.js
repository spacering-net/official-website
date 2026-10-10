// The theme of a page, set before its first paint: light if that was chosen
// here (sr-theme: light, dark, system), or "system" was and the system is
// light; dark otherwise. A plain blocking script: a file of its own on the
// pages in the site's frame (layouts/Page.astro), which allow no inline ones,
// and inlined on the homepage (layouts/Base.astro). client/theme-switch.ts
// switches it in place. The homepage's stills for share images (?capture)
// are of the night, whatever was chosen.
(function () {
  if (/[?&]capture\b/.test(location.search)) return;
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
