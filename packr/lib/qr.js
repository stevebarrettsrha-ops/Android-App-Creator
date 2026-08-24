'use strict';

/**
 * QR Code generator (model 2), byte mode, no dependencies.
 * Produces the module matrix and an SVG rendering. Used to put a
 * scannable install link on screen after a build finishes.
 */

// Error-correction level indicators as they appear in the format information.
const ECL = {
  L: { ordinal: 0, formatBits: 1 },
  M: { ordinal: 1, formatBits: 0 },
  Q: { ordinal: 2, formatBits: 3 },
  H: { ordinal: 3, formatBits: 2 },
};

// ECC codewords per block, indexed [eclOrdinal][version]. Version 0 is padding.
const ECC_CODEWORDS_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];

// Number of error-correction blocks, indexed [eclOrdinal][version].
const NUM_ERROR_CORRECTION_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

// ------------------------------------------------------------------ capacity

/** Modules available for data after function patterns are placed. */
function numRawDataModules(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function numDataCodewords(version, ecl) {
  return (
    Math.floor(numRawDataModules(version) / 8) -
    ECC_CODEWORDS_PER_BLOCK[ecl.ordinal][version] *
      NUM_ERROR_CORRECTION_BLOCKS[ecl.ordinal][version]
  );
}

/** Byte-mode character count field is 8 bits for versions 1-9, 16 after. */
function byteCapacity(version, ecl) {
  const headerBits = 4 + (version <= 9 ? 8 : 16);
  return Math.floor((numDataCodewords(version, ecl) * 8 - headerBits) / 8);
}

// ------------------------------------------------------------- reed-solomon

function rsMultiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsGeneratorPolynomial(degree) {
  const result = new Array(degree - 1).fill(0).concat([1]);
  // Multiply (x - 2^0)(x - 2^1)...(x - 2^{degree-1}).
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = rsMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = rsMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data, generator) {
  const result = new Array(generator.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ result.shift();
    result.push(0);
    for (let i = 0; i < result.length; i++) {
      result[i] ^= rsMultiply(generator[i], factor);
    }
  }
  return result;
}

// -------------------------------------------------------------- bit plumbing

function appendBits(bits, value, length) {
  for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
}

// ---------------------------------------------------------------- the matrix

class Matrix {
  constructor(version) {
    this.version = version;
    this.size = version * 4 + 17;
    this.modules = new Array(this.size * this.size).fill(false);
    this.isFunction = new Array(this.size * this.size).fill(false);
  }

  get(x, y) {
    return this.modules[y * this.size + x];
  }

  set(x, y, dark, isFunction) {
    this.modules[y * this.size + x] = dark;
    if (isFunction) this.isFunction[y * this.size + x] = true;
  }

  alignmentPositions() {
    if (this.version === 1) return [];
    const numAlign = Math.floor(this.version / 7) + 2;
    const step =
      this.version === 32
        ? 26
        : Math.ceil((this.version * 4 + 4) / (numAlign * 2 - 2)) * 2;
    const result = [6];
    for (let pos = this.size - 7; result.length < numAlign; pos -= step) {
      result.splice(1, 0, pos);
    }
    return result;
  }

  drawFunctionPatterns(ecl) {
    // Timing patterns.
    for (let i = 0; i < this.size; i++) {
      this.set(6, i, i % 2 === 0, true);
      this.set(i, 6, i % 2 === 0, true);
    }

    // Finder patterns with separators, clipped at the edges.
    this.drawFinder(3, 3);
    this.drawFinder(this.size - 4, 3);
    this.drawFinder(3, this.size - 4);

    // Alignment patterns, skipping the three finder corners.
    const positions = this.alignmentPositions();
    const last = positions.length - 1;
    for (let i = 0; i < positions.length; i++) {
      for (let j = 0; j < positions.length; j++) {
        if (
          (i === 0 && j === 0) ||
          (i === 0 && j === last) ||
          (i === last && j === 0)
        ) {
          continue;
        }
        this.drawAlignment(positions[i], positions[j]);
      }
    }

    this.drawFormatBits(ecl, 0); // reserves the areas; real value drawn after masking
    this.drawVersion();
  }

  drawFinder(cx, cy) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || x >= this.size || y < 0 || y >= this.size) continue;
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        this.set(x, y, distance !== 2 && distance !== 4, true);
      }
    }
  }

  drawAlignment(cx, cy) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        this.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1, true);
      }
    }
  }

  drawFormatBits(ecl, mask) {
    const data = (ecl.formatBits << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;

    for (let i = 0; i <= 5; i++) this.set(8, i, ((bits >>> i) & 1) !== 0, true);
    this.set(8, 7, ((bits >>> 6) & 1) !== 0, true);
    this.set(8, 8, ((bits >>> 7) & 1) !== 0, true);
    this.set(7, 8, ((bits >>> 8) & 1) !== 0, true);
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, ((bits >>> i) & 1) !== 0, true);

    for (let i = 0; i < 8; i++) {
      this.set(this.size - 1 - i, 8, ((bits >>> i) & 1) !== 0, true);
    }
    for (let i = 8; i < 15; i++) {
      this.set(8, this.size - 15 + i, ((bits >>> i) & 1) !== 0, true);
    }
    this.set(8, this.size - 8, true, true); // the always-dark module
  }

  drawVersion() {
    if (this.version < 7) return;
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.version << 12) | rem;

    for (let i = 0; i < 18; i++) {
      const bit = ((bits >>> i) & 1) !== 0;
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.set(a, b, bit, true);
      this.set(b, a, bit, true);
    }
  }

  drawCodewords(codewords) {
    let bitIndex = 0;
    // Zigzag upward and downward in two-column bands, right to left.
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < this.size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? this.size - 1 - vert : vert;
          if (this.isFunction[y * this.size + x]) continue;
          if (bitIndex < codewords.length * 8) {
            const dark =
              ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) !== 0;
            this.set(x, y, dark, false);
            bitIndex++;
          }
        }
      }
    }
  }

  applyMask(mask) {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (this.isFunction[y * this.size + x]) continue;
        let invert;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        }
        if (invert) this.modules[y * this.size + x] = !this.modules[y * this.size + x];
      }
    }
  }

  penalty() {
    let result = 0;
    const size = this.size;

    // Adjacent same-colour runs, and finder-lookalike patterns, in both axes.
    for (let y = 0; y < size; y++) {
      let runColor = false;
      let runLength = 0;
      const history = [0, 0, 0, 0, 0, 0, 0];
      for (let x = 0; x < size; x++) {
        if (this.get(x, y) === runColor) {
          runLength++;
          if (runLength === 5) result += 3;
          else if (runLength > 5) result++;
        } else {
          this.finderPenaltyAdd(history, runLength);
          if (!runColor) result += this.finderPenaltyCount(history) * 40;
          runColor = this.get(x, y);
          runLength = 1;
        }
      }
      result += this.finderPenaltyTerminate(history, runLength, runColor) * 40;
    }
    for (let x = 0; x < size; x++) {
      let runColor = false;
      let runLength = 0;
      const history = [0, 0, 0, 0, 0, 0, 0];
      for (let y = 0; y < size; y++) {
        if (this.get(x, y) === runColor) {
          runLength++;
          if (runLength === 5) result += 3;
          else if (runLength > 5) result++;
        } else {
          this.finderPenaltyAdd(history, runLength);
          if (!runColor) result += this.finderPenaltyCount(history) * 40;
          runColor = this.get(x, y);
          runLength = 1;
        }
      }
      result += this.finderPenaltyTerminate(history, runLength, runColor) * 40;
    }

    // 2x2 blocks of a single colour.
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = this.get(x, y);
        if (c === this.get(x + 1, y) && c === this.get(x, y + 1) && c === this.get(x + 1, y + 1)) {
          result += 3;
        }
      }
    }

    // Overall dark/light balance.
    let dark = 0;
    for (const module of this.modules) if (module) dark++;
    const total = size * size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += k * 10;
    return result;
  }

  finderPenaltyAdd(history, runLength) {
    if (history[0] === 0) runLength += this.size; // light border pads the first run
    history.pop();
    history.unshift(runLength);
  }

  finderPenaltyCount(history) {
    // Looks for 1:1:3:1:1 dark modules flanked by a light run of at least 4.
    const n = history[1];
    const core =
      n > 0 &&
      history[2] === n &&
      history[3] === n * 3 &&
      history[4] === n &&
      history[5] === n;
    return (
      (core && history[0] >= n * 4 && history[6] >= n ? 1 : 0) +
      (core && history[6] >= n * 4 && history[0] >= n ? 1 : 0)
    );
  }

  finderPenaltyTerminate(history, runLength, runColor) {
    if (runColor) {
      this.finderPenaltyAdd(history, runLength);
      runLength = 0;
    }
    runLength += this.size; // treat the border as light
    this.finderPenaltyAdd(history, runLength);
    return this.finderPenaltyCount(history);
  }
}

// -------------------------------------------------------------------- encode

/**
 * Encode text into a QR module matrix.
 * Returns { size, version, mask, get(x, y) } where get() reports dark modules.
 */
function encode(text, eclName = 'M') {
  const ecl = ECL[eclName] || ECL.M;
  const data = Buffer.from(String(text), 'utf8');

  let version = 0;
  for (let candidate = 1; candidate <= 40; candidate++) {
    if (byteCapacity(candidate, ecl) >= data.length) {
      version = candidate;
      break;
    }
  }
  if (!version) {
    throw new Error(`Text is too long for a QR code (${data.length} bytes).`);
  }

  // Bit stream: mode indicator, character count, data, terminator, padding.
  const bits = [];
  appendBits(bits, 4, 4); // byte mode
  appendBits(bits, data.length, version <= 9 ? 8 : 16);
  for (const byte of data) appendBits(bits, byte, 8);

  const capacityBits = numDataCodewords(version, ecl) * 8;
  appendBits(bits, 0, Math.min(4, capacityBits - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  for (let filler = 0xec; bits.length < capacityBits; filler ^= 0xec ^ 0x11) {
    appendBits(bits, filler, 8);
  }

  const dataCodewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    dataCodewords.push(byte);
  }

  // Split into blocks, compute ECC, interleave.
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ecl.ordinal][version];
  const eccLength = ECC_CODEWORDS_PER_BLOCK[ecl.ordinal][version];
  const rawCodewords = Math.floor(numRawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLength = Math.floor(rawCodewords / numBlocks);

  const blocks = [];
  const generator = rsGeneratorPolynomial(eccLength);
  for (let i = 0, offset = 0; i < numBlocks; i++) {
    const blockDataLength = shortBlockLength - eccLength + (i < numShortBlocks ? 0 : 1);
    const block = dataCodewords.slice(offset, offset + blockDataLength);
    offset += blockDataLength;
    blocks.push({ data: block, ecc: rsRemainder(block, generator) });
  }

  const interleaved = [];
  for (let i = 0; i <= shortBlockLength - eccLength; i++) {
    for (const block of blocks) {
      if (i < block.data.length) interleaved.push(block.data[i]);
    }
  }
  for (let i = 0; i < eccLength; i++) {
    for (const block of blocks) interleaved.push(block.ecc[i]);
  }

  // Draw and pick the mask with the lowest penalty.
  const matrix = new Matrix(version);
  matrix.drawFunctionPatterns(ecl);
  matrix.drawCodewords(interleaved);

  let bestMask = 0;
  let bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    matrix.applyMask(mask);
    matrix.drawFormatBits(ecl, mask);
    const penalty = matrix.penalty();
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMask = mask;
    }
    matrix.applyMask(mask); // undo — XOR masking is its own inverse
  }
  matrix.applyMask(bestMask);
  matrix.drawFormatBits(ecl, bestMask);

  return {
    size: matrix.size,
    version,
    mask: bestMask,
    get: (x, y) => matrix.get(x, y),
  };
}

// ----------------------------------------------------------------------- svg

/**
 * Render text as an SVG QR code with a quiet zone.
 * Colours default to black on white; pass { dark, light } to override.
 */
function toSvg(text, options = {}) {
  const { ecl = 'M', dark = '#12181F', light = '#FFFFFF', quiet = 4 } = options;
  const code = encode(text, ecl);
  const span = code.size + quiet * 2;

  const parts = [];
  for (let y = 0; y < code.size; y++) {
    for (let x = 0; x < code.size; x++) {
      if (code.get(x, y)) {
        parts.push(`M${x + quiet} ${y + quiet}h1v1h-1z`);
      }
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${span} ${span}" ` +
    `shape-rendering="crispEdges" role="img" aria-label="QR code">` +
    `<rect width="${span}" height="${span}" fill="${light}"/>` +
    `<path d="${parts.join('')}" fill="${dark}"/>` +
    `</svg>`
  );
}

module.exports = { encode, toSvg };
