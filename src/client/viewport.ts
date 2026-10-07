/**
 * Width of the layout viewport in CSS pixels. Unlike `innerWidth` it leaves
 * out a classic scrollbar, so the canvas, the panels and the ring placement
 * all share one coordinate space.
 */
export const viewW = () => document.documentElement.clientWidth || window.innerWidth;
