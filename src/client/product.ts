/**
 * The pages of Space, the personal assistant and open source
 * (layouts/Product.astro), on top of client/page.ts:
 *
 * - A concept preview that starts below the fold fills in when it scrolls
 *   into view (its rows arrive one by one); one already in view is simply
 *   there, so nothing on screen disappears and comes back.
 * - The hero's drawing moves only while it is on screen. Its animations are
 *   CSS and SMIL: off screen both are paused.
 * - With reduced motion the SMIL drawings rest on one moment (`data-rest`, in
 *   seconds); CSS ones are stopped by their own styles.
 */
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const watching = 'IntersectionObserver' in window;

if (watching && !reduceMotion) {
  const reveal = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-in');
        reveal.unobserve(entry.target);
      }
    },
    { threshold: 0.3 },
  );
  for (const el of document.querySelectorAll<HTMLElement>('[data-reveal]')) {
    if (el.getBoundingClientRect().top < window.innerHeight) continue;
    el.classList.add('is-waiting');
    reveal.observe(el);
  }
}

const smil = [...document.querySelectorAll<SVGSVGElement>('svg[data-smil]')];
if (reduceMotion) {
  for (const svg of smil) {
    svg.pauseAnimations();
    svg.setCurrentTime(Number(svg.dataset.rest) || 0);
  }
} else if (watching) {
  const art = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const el = entry.target as HTMLElement;
      el.classList.toggle('is-paused', !entry.isIntersecting);
      for (const svg of el.querySelectorAll<SVGSVGElement>('svg[data-smil]')) {
        if (entry.isIntersecting) svg.unpauseAnimations();
        else svg.pauseAnimations();
      }
    }
  });
  for (const el of document.querySelectorAll<HTMLElement>('[data-art]')) art.observe(el);
}

// a module of its own: nothing here is shared with the other pages' scripts
export {};
