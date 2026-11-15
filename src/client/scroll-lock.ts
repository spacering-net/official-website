/**
 * What stops the page from scrolling while the narrow screens' menu or a
 * dialog is open: Lenis on the homepage, a class on the other pages.
 */
export interface ScrollLock {
  stop(): void;
  start(): void;
}
