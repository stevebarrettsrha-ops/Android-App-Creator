'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DENSITIES = [
  { dir: 'mipmap-mdpi', size: 48 },
  { dir: 'mipmap-hdpi', size: 72 },
  { dir: 'mipmap-xhdpi', size: 96 },
  { dir: 'mipmap-xxhdpi', size: 144 },
  { dir: 'mipmap-xxxhdpi', size: 192 },
];

// Adaptive-icon foregrounds live on a 108dp canvas where only the middle 72dp is guaranteed
// visible, so the artwork sits inside a 66% safe zone.
const FOREGROUND_SIZES = [
  { dir: 'mipmap-mdpi', size: 108 },
  { dir: 'mipmap-hdpi', size: 162 },
  { dir: 'mipmap-xhdpi', size: 216 },
  { dir: 'mipmap-xxhdpi', size: 324 },
  { dir: 'mipmap-xxxhdpi', size: 432 },
];

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i];
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

/** Encode raw RGBA pixels as a PNG. No native dependencies. */
function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function parseHex(hex, fallback = [16, 24, 34]) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!match) return fallback;
  const value = parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/**
 * Draw a placeholder mark: a rounded plate with a downward chevron, which reads as
 * "page goes in, package comes out" at launcher sizes.
 */
function drawMark(size, background, ink, transparentBackground) {
  const scale = 4; // supersample, then box-filter down, so edges are not jagged
  const big = size * scale;

  const inset = transparentBackground ? big * 0.21 : 0;
  const radius = big * (transparentBackground ? 0.15 : 0.22);
  const plateMin = inset;
  const plateMax = big - inset;
  const span = plateMax - plateMin;

  const stroke = Math.max(2, span * 0.085);
  const centre = big / 2;
  const armReach = span * 0.19;
  const chevronTop = plateMin + span * 0.24;
  const chevronTip = plateMin + span * 0.56;
  const trayY = plateMin + span * 0.74;

  const hi = Buffer.alloc(big * big * 4);

  for (let y = 0; y < big; y++) {
    for (let x = 0; x < big; x++) {
      const offset = (y * big + x) * 4;
      if (!insideRoundedRect(x, y, plateMin, plateMin, plateMax, plateMax, radius)) continue;

      let [r, g, b] = background;

      const dx = Math.abs(x - centre);

      // Vertical stem running down to the tip.
      const onStem = dx <= stroke / 2 && y >= chevronTop && y <= chevronTip;

      // Arms rising away from the tip: an arrowhead pointing down.
      const armY = chevronTip - dx;
      const onArm =
        dx <= armReach && dx >= 0 && Math.abs(y - armY) <= stroke * 0.72 && y <= chevronTip;

      // Tray the arrow points into.
      const onTray = Math.abs(y - trayY) <= stroke / 2 && dx <= armReach * 1.35;

      if (onStem || onArm || onTray) [r, g, b] = ink;

      hi[offset] = r;
      hi[offset + 1] = g;
      hi[offset + 2] = b;
      hi[offset + 3] = 255;
    }
  }

  return encodePng(size, size, downsample(hi, big, scale));
}

function downsample(source, sourceSize, factor) {
  const target = sourceSize / factor;
  const out = Buffer.alloc(target * target * 4);
  const samples = factor * factor;

  for (let y = 0; y < target; y++) {
    for (let x = 0; x < target; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < factor; sy++) {
        for (let sx = 0; sx < factor; sx++) {
          const i = ((y * factor + sy) * sourceSize + (x * factor + sx)) * 4;
          const alpha = source[i + 3];
          // Premultiply so transparent pixels do not drag colour toward black.
          r += source[i] * alpha;
          g += source[i + 1] * alpha;
          b += source[i + 2] * alpha;
          a += alpha;
        }
      }
      const o = (y * target + x) * 4;
      out[o] = a ? Math.round(r / a) : 0;
      out[o + 1] = a ? Math.round(g / a) : 0;
      out[o + 2] = a ? Math.round(b / a) : 0;
      out[o + 3] = Math.round(a / samples);
    }
  }
  return out;
}

function insideRoundedRect(x, y, left, top, right, bottom, radius) {
  if (x < left || x > right || y < top || y > bottom) return false;
  const cx = Math.min(Math.max(x, left + radius), right - radius);
  const cy = Math.min(Math.max(y, top + radius), bottom - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

async function resizeWithSharp(sourcePath, size, background) {
  let sharp;
  try {
    sharp = require('sharp');
  } catch (e) {
    return null;
  }
  return sharp(sourcePath)
    .resize(size, size, { fit: 'contain', background })
    .png()
    .toBuffer();
}

/**
 * Write launcher icons into the generated project's res/ tree.
 * A supplied PNG is used when present; otherwise a generated placeholder is written.
 */
async function writeIcons(resDir, options) {
  const { iconPath, themeColor, iconBackground } = options;
  const background = parseHex(iconBackground || themeColor);
  const ink = [0, 194, 178];
  const notes = [];

  let sharpAvailable = true;
  try {
    require.resolve('sharp');
  } catch (e) {
    sharpAvailable = false;
  }

  const usingCustom = Boolean(iconPath && fs.existsSync(iconPath));
  if (iconPath && !usingCustom) {
    notes.push(`Icon file not found at ${iconPath}; using the generated placeholder instead.`);
  }
  if (usingCustom && !sharpAvailable) {
    notes.push(
      'sharp is not installed, so your icon is copied at its original size to every density. ' +
        'Supply a square 512x512 PNG, or run "npm install sharp" for proper downscaling.'
    );
  }
  if (!usingCustom) {
    notes.push('No icon supplied. A placeholder mark was generated — replace it before publishing.');
  }

  for (const { dir, size } of DENSITIES) {
    const target = path.join(resDir, dir);
    fs.mkdirSync(target, { recursive: true });
    let buffer = null;
    if (usingCustom) {
      buffer = sharpAvailable
        ? await resizeWithSharp(iconPath, size, { r: 0, g: 0, b: 0, alpha: 0 })
        : fs.readFileSync(iconPath);
    }
    if (!buffer) buffer = drawMark(size, background, ink, false);
    fs.writeFileSync(path.join(target, 'ic_launcher.png'), buffer);
    fs.writeFileSync(path.join(target, 'ic_launcher_round.png'), buffer);
  }

  for (const { dir, size } of FOREGROUND_SIZES) {
    const target = path.join(resDir, dir);
    let buffer = null;
    if (usingCustom && sharpAvailable) {
      const inner = Math.round(size * 0.62);
      const pad = Math.round((size - inner) / 2);
      try {
        const sharp = require('sharp');
        buffer = await sharp(iconPath)
          .resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .extend({
            top: pad,
            bottom: size - inner - pad,
            left: pad,
            right: size - inner - pad,
            background: { r: 0, g: 0, b: 0, alpha: 0 },
          })
          .png()
          .toBuffer();
      } catch (e) {
        buffer = null;
      }
    }
    if (!buffer) buffer = drawMark(size, background, ink, true);
    fs.writeFileSync(path.join(target, 'ic_launcher_foreground.png'), buffer);
  }

  return notes;
}

module.exports = { writeIcons, encodePng, parseHex };
