/** Path data for the SpaceRing mark on its 512 × 512 canvas, shared by everything that draws it. */
export const MARK_BAND =
  'M447.95 366.91A221.8 192.09 30 0 1 159.82 422.36A221.8 192.09 30 0 1 63.78 145.11A221.8 192.09 30 0 1 351.91 89.66A221.8 192.09 30 0 1 447.95 366.91ZM416.77 323.09A172.89 149.73 30 0 0 341.91 106.98A172.89 149.73 30 0 0 117.32 150.2A172.89 149.73 30 0 0 192.18 366.31A172.89 149.73 30 0 0 416.77 323.09ZM188.32 413A20 10 30 0 0 176 394.34A20 10 30 0 0 153.68 393A20 10 30 0 0 166 411.66A20 10 30 0 0 188.32 413Z';

/** The inner-wall crescent. */
export const MARK_CRESCENT = 'M134.69 146.1A160.53 137.37 30 0 1 411.63 305.99A172.89 149.73 30 0 0 134.69 146.1Z';

/** The node cut out of the band: a 20 × 10 ellipse turned 30°, like the third subpath of MARK_BAND. */
export const MARK_NODE = { x: 171, y: 403, rx: 20, ry: 10, angle: 30 } as const;
