/*
 * Run as soon as the HUD is parsed, before the first frame (Hud.astro): the
 * last signed-in user (client/account.ts keeps the hint) goes in the HUD's
 * end at once, so it never shows "Sign in" first, nor in the picture a page
 * change takes of it. Only a hint: /api/me has the last word. A plain script
 * of its own, as the pages that allow scripts from this site only need.
 */
(function () {
  var me = null;
  try {
    me = JSON.parse(localStorage.getItem('sr-account') || 'null');
  } catch (e) {}
  if (!me || typeof me.number !== 'number' || typeof me.name !== 'string') return;
  document.documentElement.classList.add('has-account');
  var image = typeof me.image === 'string' && /^\/api\/avatars\//.test(me.image) ? me.image : null;
  var initial = Array.from(me.name.trim())[0] || '';
  var i, el;
  el = document.querySelectorAll('[data-account-name]');
  for (i = 0; i < el.length; i++) el[i].textContent = me.name;
  el = document.querySelectorAll('[data-account-number]');
  for (i = 0; i < el.length; i++) el[i].textContent = String(me.number);
  el = document.querySelectorAll('[data-account-initial]');
  for (i = 0; i < el.length; i++) el[i].textContent = initial.toUpperCase();
  el = document.querySelectorAll('[data-account-avatar]');
  for (i = 0; i < el.length; i++) {
    el[i].hidden = !image;
    if (image) el[i].src = image;
  }
  el = document.querySelectorAll('[data-console-link]');
  for (i = 0; i < el.length; i++) el[i].setAttribute('aria-label', me.name + ' · SRN ' + me.number + ' · ' + el[i].getAttribute('data-label'));
})();
