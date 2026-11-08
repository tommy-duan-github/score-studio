const SVG_NS = 'http://www.w3.org/2000/svg';
const lensCache = new Map<string, string>();
export const lensSupported = /Chrome\/|Chromium\/|Edg\//.test(navigator.userAgent)
  && !/Firefox\/|CriOS\//.test(navigator.userAgent)
  && CSS.supports('backdrop-filter', 'url("#lens")');

// Liquid-glass optics: convex bezel, flat centre, RGB dispersion and specular rim.
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
/** bezel: rim width in px (default: thin, for small thumbs); depth: glass thickness relative to the bezel; rim: specular strength. */
export type LensOptions = { bezel?: number; depth?: number; rim?: number };
function lensImages(width: number, height: number, radius: number, options: LensOptions = {}) {
  const light = getComputedStyle(document.documentElement).getPropertyValue('--glint-rgb').trim().split(/\s+/).map(Number);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(2, Math.ceil(width));
  canvas.height = Math.max(2, Math.ceil(height));
  const context = canvas.getContext('2d');
  if (!context) return null;
  const map = context.createImageData(canvas.width, canvas.height);
  const rim = context.createImageData(canvas.width, canvas.height);
  // A thin bezel: magnification hugs the rim and the centre stays undistorted.
  const bezel = Math.min(Math.min(width, height) / 2, options.bezel ?? Math.max(6, Math.min(height * .26, 11)));
  const thickness = bezel * (options.depth ?? 1.5);
  const profile = (t: number) => (1 - (1 - clamp01(t)) ** 4) ** .25;
  for (let y = 0;y < canvas.height;y++) {
    for (let x = 0;x < canvas.width;x++) {
      const px = x + .5 - width / 2;
      const py = y + .5 - height / 2;
      const qx = Math.abs(px) - (width / 2 - radius);
      const qy = Math.abs(py) - (height / 2 - radius);
      const ox = Math.max(qx, 0);
      const oy = Math.max(qy, 0);
      const outside = Math.hypot(ox, oy);
      const depth = -(outside + Math.min(Math.max(qx, qy), 0) - radius);
      let nx = outside ? ox / outside : qx > qy ? 1 : 0;
      let ny = outside ? oy / outside : qx > qy ? 0 : 1;
      nx *= Math.sign(px);
      ny *= Math.sign(py);
      let displacement = 0;
      if (depth >= 0 && depth < bezel) {
        const t = depth / bezel;
        const slope = (profile(t + .001) - profile(t - .001)) / .002 * thickness / bezel;
        const incidence = Math.atan(slope);
        displacement = Math.tan(incidence - Math.asin(Math.sin(incidence) / 1.5)) * thickness * profile(t);
      }
      const k = (y * canvas.width + x) * 4;
      // Opaque alpha matters: Chromium premultiplies transparent displacement channels.
      map.data[k] = Math.round(128 - nx * clamp01(displacement / thickness) * 127);
      map.data[k + 1] = Math.round(128 - ny * clamp01(displacement / thickness) * 127);
      map.data[k + 2] = 128;
      map.data[k + 3] = 255;
      const facing = Math.max(0, nx * -.65 + ny * -.76) + Math.max(0, nx * .5 + ny * .86) * .45;
      const edge = depth >= 0 ? Math.exp(-(((depth - 1.1) / 1.4) ** 2)) : 0;
      rim.data[k] = light[0];
      rim.data[k + 1] = light[1];
      rim.data[k + 2] = light[2];
      rim.data[k + 3] = Math.round(edge * (options.rim ?? .28) * Math.min(1, facing) ** 2 * 255);
    }
  }
  context.putImageData(map, 0, 0);
  const displacementUrl = canvas.toDataURL();
  context.putImageData(rim, 0, 0);
  return { displacement: displacementUrl, specular: canvas.toDataURL(), scale: thickness * 2 };
}
function svgNode(tag: string, attributes: Record<string, string | number>) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}
export function lensFilter(defs: SVGDefsElement, width: number, height: number, radius: number, options: LensOptions = {}) {
  const key = `${Math.round(width)}x${Math.round(height)}r${Math.round(radius)}:${document.documentElement.dataset.theme}:${JSON.stringify(options)}`;
  if (lensCache.has(key)) return lensCache.get(key);
  const maps = lensImages(Math.round(width), Math.round(height), Math.round(radius), options);
  if (!maps) return null;
  const id = `lens-${lensCache.size + 1}`;
  const filter = svgNode('filter', {
    id, filterUnits: 'userSpaceOnUse', primitiveUnits: 'userSpaceOnUse',
    x: 0, y: 0, width: Math.round(width), height: Math.round(height),
    'color-interpolation-filters': 'sRGB',
  });
  filter.append(svgNode('feImage', { href: maps.displacement, x: 0, y: 0, width: Math.round(width), height: Math.round(height), preserveAspectRatio: 'none', result: 'map' }));
  const displace = (scale: number, result: string) => [
    svgNode('feDisplacementMap', { in: 'SourceGraphic', in2: 'map', scale, xChannelSelector: 'R', yChannelSelector: 'G', result: `${result}-raw` }),
    svgNode('feOffset', { in: `${result}-raw`, dx: -scale / 510, dy: -scale / 510, result })
  ];
  // Slight chromatic dispersion at the curved rim, none in the flat centre.
  filter.append(...displace(maps.scale, 'refracted'), ...displace(maps.scale + 2.5, 'red-shift'), ...displace(maps.scale - 2.5, 'blue-shift'));
  const channels = [
    ['red-shift', 'red', '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0'],
    ['refracted', 'green', '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0'],
    ['blue-shift', 'blue', '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0'],
  ];
  for (const [source, result, values] of channels) {
    filter.append(svgNode('feColorMatrix', { in: source, type: 'matrix', values, result }));
  }
  filter.append(svgNode('feComposite', { in: 'red', in2: 'green', operator: 'arithmetic', k2: 1, k3: 1, result: 'rg' }),
    svgNode('feComposite', { in: 'rg', in2: 'blue', operator: 'arithmetic', k2: 1, k3: 1, result: 'dispersed' }),
    svgNode('feImage', { href: maps.specular, x: 0, y: 0, width: Math.round(width), height: Math.round(height), preserveAspectRatio: 'none', result: 'specular' }),
    svgNode('feBlend', { in: 'specular', in2: 'dispersed', mode: 'screen' }));
  defs.append(filter);
  lensCache.set(key, id);
  return id;
}
