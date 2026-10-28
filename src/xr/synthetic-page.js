/*
 * Synthetic page content for the WebXR Phase 0 probe.
 *
 * Phase 0 answers two questions that are cheap to answer now and expensive to
 * answer after a streaming transport exists:
 *
 *   1. Does the spatial layout work at headset scale?
 *   2. Is a browser page rendered as a textured mesh legible at the Quest 3's
 *      roughly 25 pixels per degree, or are WebXR quad layers required?
 *
 * Neither question needs a real browser, so this module draws page-shaped
 * content onto a canvas instead. The canvas is deliberately the same pixel
 * size as a real Chromium source, so every downstream measurement matches what
 * the real provider will produce later.
 */

export const PAGE_KINDS = Object.freeze(['legibility', 'article', 'code', 'dashboard']);

const PALETTE = Object.freeze({
  paper: '#ffffff',
  ink: '#111827',
  muted: '#6b7280',
  faint: '#d1d5db',
  rule: '#e5e7eb',
  accent: '#2563eb',
  chrome: '#f3f4f6',
  shellInk: '#374151',
  terminalBg: '#0b1020',
  terminalInk: '#d7dcf0'
});

const CODE_COLORS = Object.freeze({
  keyword: '#c084fc',
  string: '#86efac',
  comment: '#64748b',
  ident: '#d7dcf0',
  fn: '#7dd3fc'
});

/* A browser page always has chrome above it. Drawing it keeps the apparent
 * content area honest, so a legibility judgement is not made against a texture
 * that is 100% body text when the real thing never is. */
const drawBrowserChrome = (ctx, width, title, url) => {
  const barHeight = 56;
  ctx.fillStyle = PALETTE.chrome;
  ctx.fillRect(0, 0, width, barHeight);
  ctx.fillStyle = PALETTE.rule;
  ctx.fillRect(0, barHeight - 1, width, 1);

  const dotY = barHeight / 2;
  const dots = ['#ef4444', '#f59e0b', '#22c55e'];
  dots.forEach((color, index) => {
    ctx.beginPath();
    ctx.arc(28 + index * 20, dotY, 6, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  });

  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = PALETTE.rule;
  ctx.lineWidth = 1;
  const fieldX = 104;
  const fieldW = width - fieldX - 32;
  ctx.beginPath();
  ctx.roundRect(fieldX, 14, fieldW, 28, 14);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = PALETTE.muted;
  ctx.font = '15px system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(url, fieldX + 16, 28);

  ctx.fillStyle = PALETTE.shellInk;
  ctx.font = '600 15px system-ui, -apple-system, "Segoe UI", sans-serif';
  const titleWidth = ctx.measureText(title).width;
  ctx.fillText(title, Math.max(fieldX + 16, width - 32 - titleWidth), 28);
  ctx.textBaseline = 'alphabetic';

  return barHeight;
};

/*
 * The legibility card is the load-bearing surface of Phase 0.
 *
 * Every row is labelled with the CSS pixel size it was drawn at, so a reading
 * in the headset produces an actionable number rather than an impression: the
 * smallest legible row is the smallest text a textured mesh can carry at that
 * world size and viewing distance. The same card rendered through a quad layer
 * gives the directly comparable number.
 */
const drawLegibilityCard = (ctx, width, height, top) => {
  ctx.fillStyle = PALETTE.ink;
  ctx.font = '700 34px system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.fillText('Legibility reference', 48, top + 56);

  ctx.fillStyle = PALETTE.muted;
  ctx.font = '16px system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.fillText(
    `Texture ${width} by ${height}. Read the smallest row you can resolve and note its label.`,
    48,
    top + 86
  );

  const sample = 'The quick brown fox jumps over the lazy dog 0123456789';
  const sizes = [32, 24, 20, 18, 16, 14, 13, 12, 11, 10];
  let y = top + 132;

  sizes.forEach((size) => {
    ctx.fillStyle = PALETTE.accent;
    ctx.font = '600 13px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(`${String(size).padStart(2, ' ')}px`, 48, y);

    ctx.fillStyle = PALETTE.ink;
    ctx.font = `${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.fillText(sample, 104, y);

    y += Math.max(26, size + 12);
  });

  /* Low contrast fails before high contrast does, and real pages are full of
   * secondary grey text. Measuring only black on white would flatter the mesh. */
  ctx.fillStyle = PALETTE.muted;
  ctx.font = '600 13px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillText('LOW CONTRAST', 48, y + 14);
  ctx.fillStyle = '#9ca3af';
  ctx.font = '14px system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.fillText(sample, 180, y + 14);

  /* Single pixel rules expose resampling directly: if these shimmer or vanish,
   * the texture is being minified and no font size will read cleanly. */
  const gridTop = y + 40;
  ctx.fillStyle = PALETTE.muted;
  ctx.font = '600 13px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillText('1px RULES', 48, gridTop + 12);
  ctx.fillStyle = PALETTE.ink;
  for (let index = 0; index < 40; index += 1) {
    ctx.fillRect(180 + index * 6, gridTop, 1, 18);
  }

  ctx.fillStyle = PALETTE.muted;
  ctx.font = '13px system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.fillText(
    'If the rules moire or disappear, the surface is minified and quad layers are required.',
    48,
    gridTop + 44
  );
};

const drawArticle = (ctx, width, height, top) => {
  ctx.fillStyle = PALETTE.ink;
  ctx.font = '700 40px Georgia, "Times New Roman", serif';
  ctx.fillText('Spatial interfaces and the', 48, top + 64);
  ctx.fillText('cost of a pixel', 48, top + 112);

  ctx.fillStyle = PALETTE.muted;
  ctx.font = '15px system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.fillText('Research note  ·  12 min read', 48, top + 146);

  ctx.fillStyle = PALETTE.rule;
  ctx.fillRect(48, top + 168, width - 96, 1);

  const paragraph = [
    'A head mounted display spends its angular resolution the moment a surface is',
    'placed in the world. A panel that fills forty degrees of view on a Quest 3 has',
    'roughly one thousand crisp horizontal pixels available to it, no matter how',
    'many pixels the source texture actually contains. Rendering more is not free;',
    'it is simply discarded during minification, and the discarding is what makes',
    'small text shimmer rather than sharpen.',
    '',
    'This is why the choice between a textured mesh and a compositor layer is not',
    'a rendering detail. A mesh is sampled twice: once into the eye buffer, and',
    'again by the display pipeline. A quad layer is sampled once, directly by the',
    'compositor, at the resolution the source provides.'
  ];

  ctx.fillStyle = PALETTE.ink;
  ctx.font = '17px Georgia, "Times New Roman", serif';
  paragraph.forEach((line, index) => {
    ctx.fillText(line, 48, top + 206 + index * 27);
  });
};

const drawCode = (ctx, width, height, top) => {
  ctx.fillStyle = PALETTE.terminalBg;
  ctx.fillRect(0, top, width, height - top);

  const lines = [
    [['const ', 'keyword'], ['createSource', 'fn'], [' = async (options) => {', 'ident']],
    [['  const ', 'keyword'], ['id', 'ident'], [' = options.id;', 'ident']],
    [['  // one Chromium webContents per spatial screen', 'comment']],
    [['  const ', 'keyword'], ['view', 'ident'], [' = new BrowserWindow({', 'ident']],
    [['    webPreferences: { offscreen: ', 'ident'], ['true', 'keyword'], [' }', 'ident']],
    [['  });', 'ident']],
    [['', 'ident']],
    [['  view.webContents.on(', 'ident'], ["'paint'", 'string'], [', (event, dirty, image) => {', 'ident']],
    [['    transport.publish({ sourceId: id, image });', 'ident']],
    [['  });', 'ident']],
    [['', 'ident']],
    [['  return ', 'keyword'], ['snapshot', 'ident'], ['(view);', 'ident']],
    [['};', 'ident']]
  ];

  ctx.font = '15px ui-monospace, SFMono-Regular, Menlo, monospace';
  lines.forEach((segments, row) => {
    const y = top + 44 + row * 24;
    ctx.fillStyle = '#3f4666';
    ctx.fillText(String(row + 1).padStart(3, ' '), 24, y);
    let x = 72;
    segments.forEach(([text, kind]) => {
      ctx.fillStyle = CODE_COLORS[kind] || CODE_COLORS.ident;
      ctx.fillText(text, x, y);
      x += ctx.measureText(text).width;
    });
  });
};

const drawDashboard = (ctx, width, height, top) => {
  ctx.fillStyle = PALETTE.ink;
  ctx.font = '700 26px system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.fillText('Session throughput', 40, top + 48);

  const cardWidth = (width - 120) / 3;
  const metrics = [
    ['Frames delivered', '61.4/s'],
    ['Dropped', '0.2%'],
    ['Sources live', '4']
  ];
  metrics.forEach(([label, value], index) => {
    const x = 40 + index * (cardWidth + 20);
    ctx.fillStyle = PALETTE.chrome;
    ctx.beginPath();
    ctx.roundRect(x, top + 72, cardWidth, 92, 12);
    ctx.fill();
    ctx.fillStyle = PALETTE.muted;
    ctx.font = '14px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.fillText(label, x + 16, top + 100);
    ctx.fillStyle = PALETTE.ink;
    ctx.font = '700 30px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.fillText(value, x + 16, top + 140);
  });

  const chartTop = top + 196;
  const chartHeight = Math.max(120, height - chartTop - 56);
  ctx.strokeStyle = PALETTE.rule;
  ctx.lineWidth = 1;
  for (let index = 0; index <= 4; index += 1) {
    const y = chartTop + (chartHeight / 4) * index;
    ctx.beginPath();
    ctx.moveTo(40, y);
    ctx.lineTo(width - 40, y);
    ctx.stroke();
  }

  ctx.strokeStyle = PALETTE.accent;
  ctx.lineWidth = 2;
  ctx.beginPath();
  const points = 48;
  for (let index = 0; index <= points; index += 1) {
    const x = 40 + ((width - 80) / points) * index;
    const wave = Math.sin(index / 4) * 0.28 + Math.sin(index / 11) * 0.16;
    const y = chartTop + chartHeight / 2 - wave * chartHeight * 0.6;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
};

/* Canvas2D roundRect is widely available but still absent in some engines.
 * Falling back keeps the probe usable rather than throwing mid draw. */
const ensureRoundRect = (ctx) => {
  if (typeof ctx.roundRect === 'function') return;
  ctx.roundRect = function roundRect(x, y, w, h, r) {
    const radius = Math.min(r, w / 2, h / 2);
    this.moveTo(x + radius, y);
    this.arcTo(x + w, y, x + w, y + h, radius);
    this.arcTo(x + w, y + h, x, y + h, radius);
    this.arcTo(x, y + h, x, y, radius);
    this.arcTo(x, y, x + w, y, radius);
    this.closePath();
  };
};

/**
 * Draw one synthetic page onto a canvas and return it.
 *
 * @param {Object} options
 * @param {number} options.width  physical pixel width, matching a real source
 * @param {number} options.height physical pixel height
 * @param {string} options.kind   one of PAGE_KINDS
 * @param {string} options.title  shown in the drawn browser chrome
 * @param {string} options.url    shown in the drawn address field
 * @param {HTMLCanvasElement=} options.canvas reused when supplied
 * @returns {HTMLCanvasElement}
 */
export const drawSyntheticPage = ({
  width = 1280,
  height = 800,
  kind = 'article',
  title = 'Untitled',
  url = 'https://example.com/',
  canvas
} = {}) => {
  const target = canvas || document.createElement('canvas');
  target.width = width;
  target.height = height;
  const ctx = target.getContext('2d', { alpha: false, willReadFrequently: true });
  ensureRoundRect(ctx);

  ctx.fillStyle = PALETTE.paper;
  ctx.fillRect(0, 0, width, height);

  const top = drawBrowserChrome(ctx, width, title, url);

  if (kind === 'legibility') drawLegibilityCard(ctx, width, height, top);
  else if (kind === 'code') drawCode(ctx, width, height, top);
  else if (kind === 'dashboard') drawDashboard(ctx, width, height, top);
  else drawArticle(ctx, width, height, top);

  return target;
};

/*
 * Convert canvas RGBA into the premultiplied BGRA byte order that Electron's
 * offscreen paint path produces.
 *
 * Emitting Electron's exact byte order rather than RGBA is deliberate: the
 * renderer's un-swizzle shader then runs unchanged, so Phase 0 exercises the
 * real texture path instead of a parallel one that could hide a defect.
 */
export const canvasToBgraBuffer = (canvas, reusable) => {
  const { width, height } = canvas;
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  const rgba = ctx.getImageData(0, 0, width, height).data;
  const byteLength = width * height * 4;
  const output = reusable && reusable.byteLength === byteLength
    ? reusable
    : new Uint8Array(byteLength);
  for (let index = 0; index < byteLength; index += 4) {
    output[index] = rgba[index + 2];
    output[index + 1] = rgba[index + 1];
    output[index + 2] = rgba[index];
    output[index + 3] = rgba[index + 3];
  }
  return output;
};
