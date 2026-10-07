export type Tier = 'high' | 'medium' | 'low';

export interface QualityProfile {
  tier: Tier;
  dpr: number;
  minDpr: number;
  particles: number;
  stars: number;
  samples: number;
  ringSegments: number;
}

function gpuName(): string {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') as WebGL2RenderingContext | null;
    if (!gl) return '';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return name;
  } catch {
    return '';
  }
}

export function detectQuality(): QualityProfile {
  const coarse = matchMedia('(pointer: coarse)').matches;
  const cores = navigator.hardwareConcurrency || 4;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
  const gpu = gpuName();
  const weak =
    /swiftshader|llvmpipe|software|mali-[gt]\d{2}\b|adreno \(tm\) [3-5]\d{2}|powervr|intel.*hd graphics [2-5]\d{2,3}\b/i.test(gpu);
  const deviceDpr = window.devicePixelRatio || 1;
  let tier: Tier = 'high';
  if (weak || cores <= 2 || memory <= 2) tier = 'low';
  else if (coarse || cores <= 4 || memory <= 4) tier = 'medium';

  const url = new URLSearchParams(location.search).get('quality');
  if (url === 'high' || url === 'medium' || url === 'low') tier = url;

  switch (tier) {
    case 'high':
      return { tier, dpr: Math.min(deviceDpr, 2), minDpr: 1, particles: 46000, stars: 2600, samples: 4, ringSegments: 320 };
    case 'medium':
      return { tier, dpr: Math.min(deviceDpr, 1.6), minDpr: 0.9, particles: 24000, stars: 1700, samples: 0, ringSegments: 220 };
    default:
      return { tier, dpr: Math.min(deviceDpr, 1), minDpr: 0.75, particles: 10000, stars: 900, samples: 0, ringSegments: 160 };
  }
}
