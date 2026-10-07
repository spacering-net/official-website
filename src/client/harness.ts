/**
 * Harness pages, once scripts run. Browsing swaps the results in place:
 * search as you type, filters (a runtime as soon as it is chosen from its
 * list) and order, more to load, with the address and the history kept in
 * step; on small screens the filters open in a sheet.
 * Copy buttons; on an item page, the summary folds, the section bar follows
 * the reading, and a dock keeps "Open in Codeg" at hand. Everything works
 * without it, with plain links and the form.
 */
const root = document.documentElement;
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** A polite live region, for what changes without the focus moving. */
const live = document.createElement('p');
live.className = 'sr-only';
live.setAttribute('role', 'status');
live.setAttribute('aria-live', 'polite');
document.body.append(live);
const announce = (text: string | null | undefined) => {
  live.textContent = '';
  if (text) requestAnimationFrame(() => (live.textContent = text.trim()));
};

/** How far down the page the HUD (and any bar stuck under it) reaches. */
const covered = (...extra: (Element | null)[]) =>
  [document.querySelector('.hud'), ...extra].reduce((y, el) => Math.max(y, el?.getBoundingClientRect().bottom ?? 0), 0);

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');

// -------------------------------------------------------------------- copy

function initCopy() {
  if (!navigator.clipboard) return;
  document.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((b) => (b.hidden = false));
  const timers = new WeakMap<HTMLButtonElement, number>();
  document.addEventListener('click', async (e) => {
    const button = (e.target as Element | null)?.closest<HTMLButtonElement>('[data-copy]');
    if (!button) return;
    try {
      await navigator.clipboard.writeText(button.dataset.copy ?? '');
    } catch {
      return;
    }
    button.classList.add('is-done');
    announce(button.dataset.done);
    clearTimeout(timers.get(button));
    timers.set(
      button,
      window.setTimeout(() => button.classList.remove('is-done'), 1600),
    );
  });
}

// ------------------------------------------------------------------ browse

function initBrowse() {
  const browse = document.querySelector<HTMLElement>('[data-browse]');
  const form = browse?.querySelector<HTMLFormElement>('[data-search]');
  const input = form?.querySelector<HTMLInputElement>('input[name="q"]');
  if (!browse || !form || !input) return;
  const results = browse.querySelector<HTMLElement>('[data-region="results"]');
  const bar = browse.querySelector('.browse__bar');
  const sheet = browse.querySelector<HTMLDialogElement>('[data-sheet]');
  /** the state on show: a move within the page (to #main) is not another state */
  const here = () => location.pathname + location.search;
  let shown = here();
  // Every state asked for gets the next number, and only the latest is shown:
  // an answer that comes back after another state was asked for is dropped.
  let generation = 0;
  /** the list on show; more of it is added only to the same list */
  let list = 0;
  let controller: AbortController | null = null;
  let moreController: AbortController | null = null;
  const settle = () => {
    generation++;
    controller?.abort();
    moreController?.abort();
    results?.removeAttribute('aria-busy');
  };

  /** Bring the top of the results under the bars, if the page is further down. */
  const toResults = () => {
    if (!results) return;
    const top = results.getBoundingClientRect().top;
    const line = covered(bar) + 21;
    if (top < line) window.scrollTo({ top: window.scrollY + top - line, behavior: reduceMotion ? 'auto' : 'smooth' });
  };

  /**
   * Load another state of this page and swap its regions in. `sync`: the
   * state came from a link, so the search box takes its query.
   */
  const load = async (url: string, how: 'push' | 'replace' | 'pop', sync = false) => {
    settle();
    const gen = generation;
    const mine = (controller = new AbortController());
    results?.setAttribute('aria-busy', 'true');
    // what has the focus, to give it to its counterpart once the parts are swapped
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const activeRegion = active?.closest<HTMLElement>('[data-region]') ?? null;
    const activeHref = active?.closest('a')?.getAttribute('href') ?? null;
    // a list's own option has the focus while its choice is being made
    const activeList = active?.closest('select')?.name ?? null;
    try {
      const res = await fetch(url, { signal: mine.signal, headers: { accept: 'text/html' } });
      if (!res.ok) throw new Error(`answered ${res.status}`);
      const html = await res.text();
      if (gen !== generation) return;
      const doc = parse(html);
      browse.querySelectorAll<HTMLElement>('[data-region]').forEach((region) => {
        const next = doc.querySelector(`[data-region="${region.dataset.region}"]`);
        if (next) region.innerHTML = next.innerHTML;
      });
      list++;
      // the other language's link carries the same query
      const other = doc.querySelector('[data-lang-switch]')?.getAttribute('href');
      if (other) document.querySelectorAll('[data-lang-switch]').forEach((a) => a.setAttribute('href', other));
      document.title = doc.title;
      if (how === 'push') history.pushState({ harness: true }, '', url);
      else if (how === 'replace') history.replaceState({ harness: true }, '', url);
      shown = here();
      if ((sync || how === 'pop') && document.activeElement !== input) input.value = new URL(location.href).searchParams.get('q') ?? '';
      if (activeRegion && active && !active.isConnected) {
        const again = activeList
          ? (activeRegion.querySelector<HTMLSelectElement>(`select[name="${activeList}"]`) ?? undefined)
          : activeHref
            ? [...activeRegion.querySelectorAll<HTMLAnchorElement>('a')].find((a) => a.getAttribute('href') === activeHref)
            : undefined;
        // (a list's own button is part of the list, never focused alone)
        (again ?? [...activeRegion.querySelectorAll<HTMLElement>('a, button')].find((el) => !el.closest('select')) ?? results)?.focus({ preventScroll: true });
      }
      announce(browse.querySelector('.results__count')?.textContent);
      toResults();
    } catch (err) {
      if ((err as Error).name === 'AbortError' || gen !== generation) return;
      location.assign(url);
    } finally {
      if (gen === generation) results?.removeAttribute('aria-busy');
    }
  };

  /**
   * The next page of results, added to these: only to the same list, and only
   * while nothing else has been asked for since. Otherwise the link is as it was.
   */
  const more = async (link: HTMLAnchorElement) => {
    if (link.getAttribute('aria-busy') === 'true') return;
    moreController?.abort();
    const mine = (moreController = new AbortController());
    const gen = generation;
    const at = list;
    const label = link.firstChild?.textContent ?? '';
    const restore = () => {
      link.removeAttribute('aria-busy');
      if (link.firstChild) link.firstChild.textContent = label;
    };
    link.setAttribute('aria-busy', 'true');
    if (link.firstChild) link.firstChild.textContent = link.dataset.busy ?? label;
    const keyboard = document.activeElement === link;
    try {
      const res = await fetch(link.href, { signal: mine.signal, headers: { accept: 'text/html' } });
      if (!res.ok) throw new Error(`answered ${res.status}`);
      const html = await res.text();
      if (gen !== generation || at !== list) {
        restore();
        return;
      }
      const doc = parse(html);
      const grid = browse.querySelector('[data-grid]');
      const items = [...doc.querySelectorAll('[data-grid] > li')].map((li) => document.importNode(li, true));
      grid?.append(...items);
      const pager = browse.querySelector('[data-pager]');
      const next = doc.querySelector('[data-pager]');
      if (pager && next) {
        pager.innerHTML = next.innerHTML;
        // this page still starts at the beginning
        pager.querySelector('.pager__first')?.remove();
      }
      announce(browse.dataset.loaded?.replace('{n}', String(items.length)) ?? null);
      if (keyboard) items[0]?.querySelector<HTMLElement>('a')?.focus({ preventScroll: true });
    } catch (err) {
      if ((err as Error).name === 'AbortError' || gen !== generation || at !== list) {
        restore();
        return;
      }
      location.assign(link.href);
    }
  };

  browse.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const link = (e.target as Element | null)?.closest<HTMLAnchorElement>('a[href]');
    if (!link || link.target || link.hasAttribute('download')) return;
    const url = new URL(link.href, location.href);
    // other pages (an item, the API) load as usual
    if (url.origin !== location.origin || url.pathname !== location.pathname) return;
    e.preventDefault();
    if (link.hasAttribute('data-more')) void more(link);
    else void load(url.href, 'push', true);
  });

  // a runtime chosen from its list applies at once, as its link would
  browse.addEventListener('change', (e) => {
    const picker = (e.target as Element | null)?.closest<HTMLSelectElement>('select[data-pick]');
    const href = picker?.selectedOptions[0]?.dataset.href;
    if (href) void load(new URL(href, location.href).href, 'push', true);
  });

  // search as you type; a word being composed (pinyin, kana) waits until it is chosen
  let timer = 0;
  let composing = false;
  const search = () => {
    window.clearTimeout(timer);
    const url = new URL(form.action, location.href);
    for (const [key, value] of new FormData(form)) {
      if (typeof value === 'string' && value.trim()) url.searchParams.set(key, value.trim());
    }
    if (url.href === location.href) return;
    // a new search goes into the history; refining it does not
    void load(url.href, new URL(location.href).searchParams.has('q') && url.searchParams.has('q') ? 'replace' : 'push');
  };
  input.addEventListener('compositionstart', () => (composing = true));
  input.addEventListener('compositionend', () => {
    composing = false;
    timer = window.setTimeout(search, 280);
  });
  input.addEventListener('input', () => {
    if (composing) return;
    window.clearTimeout(timer);
    timer = window.setTimeout(search, 280);
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    search();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || composing) return;
    if (input.value) {
      input.value = '';
      search();
    } else input.blur();
  });

  // "/" anywhere goes to the search
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
    if ((e.target as Element | null)?.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (root.classList.contains('is-locked') || document.querySelector('dialog[open]')) return;
    e.preventDefault();
    input.focus();
    input.select();
  });

  window.addEventListener('popstate', () => {
    window.clearTimeout(timer);
    // back to what is on show: nothing on its way is wanted any more
    if (here() === shown) settle();
    else void load(location.href, 'pop');
  });

  // the filters' sheet, on small screens
  if (sheet) {
    const open = browse.querySelector<HTMLButtonElement>('[data-sheet-open]');
    open?.addEventListener('click', () => {
      sheet.showModal();
      root.classList.add('is-locked');
    });
    sheet.addEventListener('close', () => {
      root.classList.remove('is-locked');
      open?.focus({ preventScroll: true });
    });
    sheet.querySelector('[data-sheet-close]')?.addEventListener('click', () => sheet.close());
    // a tap on the veil above the sheet closes it
    sheet.addEventListener('click', (e) => {
      if (e.target === sheet) sheet.close();
    });
    // grown past the small screen, the sidebar shows the same filters
    window.matchMedia('(min-width: 1101px)').addEventListener('change', (e) => {
      if (e.matches && sheet.open) sheet.close();
    });
  }
}

// -------------------------------------------------------------------- item

function initItem() {
  // a long summary folds to three lines
  const clamp = document.querySelector<HTMLElement>('[data-clamp]');
  const text = clamp?.querySelector('p');
  const toggle = clamp?.querySelector<HTMLButtonElement>('[data-clamp-toggle]');
  if (clamp && text && toggle) {
    clamp.classList.add('is-clamped');
    if (text.scrollHeight > text.clientHeight + 2) {
      const more = toggle.textContent ?? '';
      toggle.hidden = false;
      toggle.setAttribute('aria-expanded', 'false');
      toggle.addEventListener('click', () => {
        const folded = clamp.classList.toggle('is-clamped');
        toggle.textContent = folded ? more : (toggle.dataset.less ?? more);
        toggle.setAttribute('aria-expanded', String(!folded));
      });
    } else clamp.classList.remove('is-clamped');
  }

  // the section bar marks the section being read, and moves to a section smoothly
  const toc = document.querySelector<HTMLElement>('[data-toc]');
  if (toc) {
    const links = [...toc.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')];
    const sections = links.map((a) => document.getElementById(a.hash.slice(1))).filter((s): s is HTMLElement => !!s);
    let raf = 0;
    const mark = () => {
      raf = 0;
      const line = covered(toc) + 34;
      let current = sections[0];
      for (const s of sections) if (s.getBoundingClientRect().top <= line) current = s;
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) current = sections[sections.length - 1];
      for (const a of links) {
        const on = a.hash === `#${current?.id}`;
        if (on && a.getAttribute('aria-current') !== 'true') {
          a.setAttribute('aria-current', 'true');
          // keep it in sight where the bar scrolls sideways
          const l = a.offsetLeft - toc.offsetLeft;
          if (l < toc.scrollLeft || l + a.offsetWidth > toc.scrollLeft + toc.clientWidth) toc.scrollTo({ left: l - 21, behavior: reduceMotion ? 'auto' : 'smooth' });
        } else if (!on) a.removeAttribute('aria-current');
      }
    };
    window.addEventListener(
      'scroll',
      () => {
        if (!raf) raf = requestAnimationFrame(mark);
      },
      { passive: true },
    );
    window.addEventListener('resize', mark);
    mark();
    toc.addEventListener('click', (e) => {
      const link = (e.target as Element | null)?.closest<HTMLAnchorElement>('a[href^="#"]');
      const target = link && document.getElementById(link.hash.slice(1));
      if (!link || !target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
      history.replaceState(history.state, '', link.hash);
    });
  }

  // once the install panel has scrolled away (small screens), the dock keeps its call at hand
  const dock = document.querySelector<HTMLElement>('[data-dock]');
  const panel = document.querySelector('[data-install]');
  if (dock && panel && 'IntersectionObserver' in window) {
    new IntersectionObserver(([e]) => {
      dock.hidden = e.isIntersecting || e.boundingClientRect.top > 0;
    }).observe(panel);
  }
}

initCopy();
initBrowse();
initItem();
