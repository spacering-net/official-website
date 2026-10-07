const LATIN = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const isCjk = (ch: string) => /[\u3000-\u9fff\uff00-\uffef]/.test(ch);
const pick = (pool: string) => pool[(Math.random() * pool.length) | 0];

const running = new WeakMap<Element, number>();
const originals = new WeakMap<Text, string>();

/** Decode-style text scramble on the element's first non-empty text node. */
export function scramble(el: HTMLElement, cjkPool: string) {
  const node = [...el.childNodes].find((n): n is Text => n.nodeType === Node.TEXT_NODE && !!n.textContent?.trim());
  if (!node) return;
  const original = originals.get(node) ?? node.textContent ?? '';
  originals.set(node, original);
  cancelAnimationFrame(running.get(el) ?? 0);
  const chars = [...original];
  let frame = 0;
  const tick = () => {
    frame++;
    const revealed = Math.max(0, Math.floor((frame - 3) / 2.2));
    if (revealed >= chars.length) {
      node.textContent = original;
      running.delete(el);
      return;
    }
    node.textContent = chars
      .map((ch, i) => (i < revealed || ch.trim() === '' ? ch : isCjk(ch) ? pick(cjkPool) : pick(LATIN)))
      .join('');
    running.set(el, requestAnimationFrame(tick));
  };
  tick();
}

export function initScramble(root: ParentNode, cjkPool: string) {
  root.querySelectorAll<HTMLElement>('[data-scramble]').forEach((el) => {
    const run = () => scramble(el, cjkPool);
    el.addEventListener('pointerenter', run);
    el.addEventListener('focus', run);
  });
}
