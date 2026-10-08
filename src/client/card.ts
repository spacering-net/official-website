import type { CardLang, RingCard } from '../lib/ring-card';

/** The signed-in holder's card and their choices for it (GET /api/me/card). */
interface HolderCard {
  number: number;
  name: string;
  /** their picture, when there is a copy of it here to show */
  image: string | null;
  since: string;
  shared: boolean;
  showName: boolean;
  showImage: boolean;
}

type Note = 'loading' | 'private' | 'shared' | 'stopped';

interface CardViewOptions {
  /** the dialog's ring card view (components/Account.astro) */
  root: HTMLElement;
  /** the session has ended: the dialog goes back to signing in */
  signedOut(): void;
}

const json = { 'content-type': 'application/json', accept: 'application/json' };

/**
 * The account dialog's ring card view: a preview of the card as it will be
 * seen, what it shows (nothing of the holder until they choose), sharing it
 * and stopping, and the ways to pass it on: its link, the system's share
 * sheet, X, and the picture itself.
 */
export function initCardView({ root, signedOut }: CardViewOptions) {
  const $ = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const preview = $<HTMLElement>('[data-card-preview]');
  const showName = $<HTMLInputElement>('[data-card-show="name"]');
  const showImage = $<HTMLInputElement>('[data-card-show="image"]');
  const imageOption = $<HTMLElement>('[data-card-image-option]');
  const status = $<HTMLElement>('[data-card-status]');
  const error = $<HTMLElement>('[data-card-error]');
  const linkRow = $<HTMLElement>('[data-card-link]');
  const url = $<HTMLInputElement>('[data-card-url]');
  const copy = $<HTMLButtonElement>('[data-card-copy]');
  const share = $<HTMLButtonElement>('[data-card-share]');
  const native = $<HTMLButtonElement>('[data-card-native]');
  const post = $<HTMLAnchorElement>('[data-card-post]');
  const save = $<HTMLAnchorElement>('[data-card-save]');
  const stop = $<HTMLButtonElement>('[data-card-stop]');
  const lang: CardLang = root.dataset.cardLang === 'zh' ? 'zh' : 'en';
  const copyLabel = copy.textContent ?? '';

  let template: typeof import('../lib/ring-card') | null = null;
  let card: HolderCard | null = null;
  let note: Note = 'loading';
  let busy = false;
  // bumped by every load and every reset: an answer for an earlier one is dropped
  let epoch = 0;
  let copied = 0;

  const pageUrl = (number: number) => new URL(`${root.dataset.cardPath ?? '/ring/'}${number}/`, location.origin).href;
  const postText = (number: number) => (post.dataset.text ?? '').replace('{n}', String(number));

  /** The card as the boxes say, which is how it will be seen once shared. */
  const shown = (c: HolderCard): RingCard => ({
    number: c.number,
    name: showName.checked ? c.name : null,
    image: showImage.checked && c.image ? c.image : null,
    since: c.since,
    lang,
  });

  const drawPreview = () => {
    if (!card || !template) {
      preview.replaceChildren();
      preview.classList.add('is-loading');
      return;
    }
    preview.classList.remove('is-loading');
    // the drawing escapes everything it is given (the name above all)
    preview.innerHTML = template.ringCardSvg(shown(card), { faces: template.PAGE_FACES, art: template.CARD_ART_SMALL, id: 'account-card' });
  };

  const drawControls = () => {
    const ready = !!card && !!template;
    const shared = !!card?.shared;
    // a card that could not be had: the error says so, not "loading"
    status.textContent = card || error.hidden ? (status.dataset[note] ?? '') : '';
    imageOption.hidden = !card?.image;
    for (const box of [showName, showImage]) box.disabled = !ready || busy;
    share.hidden = shared;
    share.disabled = !ready || busy;
    linkRow.hidden = !shared;
    native.hidden = !shared || typeof navigator.share !== 'function';
    post.hidden = !shared;
    stop.hidden = !shared;
    stop.disabled = busy;
    save.toggleAttribute('aria-disabled', !ready);
    root.toggleAttribute('aria-busy', busy || !ready);
    if (!card) {
      save.removeAttribute('href');
      return;
    }
    const link = pageUrl(card.number);
    url.value = link;
    post.href = `https://x.com/intent/post?text=${encodeURIComponent(postText(card.number))}&url=${encodeURIComponent(link)}`;
    const q = new URLSearchParams({ name: showName.checked ? '1' : '0', image: showImage.checked && card.image ? '1' : '0', lang, download: '1' });
    save.href = `/api/me/card.jpg?${q}`;
    save.download = `spacering-srn-${card.number}.jpg`;
  };

  const draw = () => {
    drawPreview();
    drawControls();
  };

  /** Ask the server to share the card as the boxes say, or to stop. False if it did not. */
  async function send(method: 'PUT' | 'DELETE'): Promise<boolean> {
    const mine = epoch;
    busy = true;
    error.hidden = true;
    drawControls();
    const res = await fetch('/api/me/card', {
      method,
      credentials: 'same-origin',
      headers: json,
      body: method === 'PUT' ? JSON.stringify({ showName: showName.checked, showImage: showImage.checked }) : undefined,
    }).catch(() => null);
    const data = res?.ok ? ((await res.json().catch(() => null)) as { card?: HolderCard } | null) : null;
    if (mine !== epoch) return false;
    busy = false;
    if (res?.status === 401) {
      signedOut();
      return false;
    }
    if (!data?.card) {
      error.hidden = false;
      drawControls();
      return false;
    }
    card = data.card;
    // the server has the last word on what a shared card shows (a picture needs one kept there)
    if (method === 'PUT') {
      showName.checked = card.showName;
      showImage.checked = card.showImage;
    }
    return true;
  }

  for (const box of [showName, showImage]) {
    box.addEventListener('change', async () => {
      if (!card) return;
      drawPreview();
      // until the card is shared, only the preview changes
      if (!card.shared) return drawControls();
      if (await send('PUT')) note = 'shared';
      else if (card) {
        // not saved: the boxes go back to what the shared card shows
        showName.checked = card.showName;
        showImage.checked = card.showImage;
      }
      draw();
    });
  }

  share.addEventListener('click', async () => {
    if (!(await send('PUT'))) return;
    note = 'shared';
    draw();
    copy.focus();
  });

  stop.addEventListener('click', async () => {
    if (!(await send('DELETE'))) return;
    note = 'stopped';
    draw();
    share.focus();
  });

  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(url.value);
    } catch {
      // no clipboard here: the link is selected for copying by hand
      url.focus();
      url.select();
      return;
    }
    copy.textContent = copy.dataset.copied ?? copyLabel;
    clearTimeout(copied);
    copied = window.setTimeout(() => (copy.textContent = copyLabel), 1600);
  });

  native.addEventListener('click', () => {
    if (!card) return;
    navigator.share({ title: `SRN ${card.number} · SpaceRing`, text: postText(card.number), url: url.value }).catch(() => {
      /* closed without sharing */
    });
  });

  // nothing to save until the card is there
  save.addEventListener('click', (e) => {
    if (!save.hasAttribute('href')) e.preventDefault();
  });

  return {
    /** Show the view afresh: the holder's card and choices, from the server. */
    async load() {
      const mine = ++epoch;
      card = null;
      note = 'loading';
      busy = false;
      error.hidden = true;
      draw();
      try {
        const [mod, res] = await Promise.all([
          template ?? import('../lib/ring-card'),
          fetch('/api/me/card', { credentials: 'same-origin', headers: { accept: 'application/json' } }),
        ]);
        if (mine !== epoch) return;
        template = mod;
        if (res.status === 401) return signedOut();
        const data = res.ok ? ((await res.json()) as { card?: HolderCard }) : null;
        if (mine !== epoch) return;
        if (!data?.card) throw new Error(`GET /api/me/card: ${res.status}`);
        card = data.card;
        showName.checked = card.showName;
        showImage.checked = card.showImage && !!card.image;
        note = card.shared ? 'shared' : 'private';
      } catch {
        if (mine !== epoch) return;
        error.hidden = false;
      }
      draw();
    },
    /** Leaving the view: whatever is still on its way is dropped. */
    reset() {
      epoch++;
      busy = false;
      clearTimeout(copied);
      copy.textContent = copyLabel;
    },
  };
}
