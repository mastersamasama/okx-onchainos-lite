// Common QR — port of upstream cli/src/qr.rs (4.6.3) and of the parts of the
// `qrcode` 0.14.1 crate it drives (QrCode::new: EC level M, optimised segments,
// version choice, best mask; Dense1x2 unicode renderer). Byte-exact against
// test/oracle-qr (the real crate): module matrix, unicode block, PNG bytes.
import { openSync, readSync, closeSync, statSync, mkdirSync, chmodSync, writeFileSync, opendirSync } from 'node:fs';
import { isatty } from 'node:tty';
import * as zlib from 'node:zlib';
import { userInfo } from 'node:os';
import { execFileSync } from 'node:child_process';
import { struct, parse as serdeParse } from './json.mjs';
import { home } from './home.mjs';

// ===========================================================================
// qrcode 0.14.1 — Normal QR versions 1..=40 at EC level M (QrCode::new)
// ===========================================================================

export class QrError extends Error {
  // types.rs::QrError Display strings.
  static DataTooLong = 'data too long';
  static InvalidVersion = 'invalid version';
  static UnsupportedCharacterSet = 'unsupported character set';
  static InvalidCharacter = 'invalid character';
  constructor(message) { super(message); this.name = 'QrError'; }
}

const NUMERIC = 0, ALNUM = 1, BYTE = 2, KANJI = 3;          // types.rs::Mode
const LIGHT = 0, DARK = 1;                                   // types.rs::Color

// bits.rs::DATA_LENGTHS, column M (bits of data per version).
const DATA_LENGTHS_M = [
  128, 224, 352, 512, 688, 864, 992, 1232, 1456, 1728, 2032, 2320, 2672, 2920, 3320, 3624, 4056, 4504, 5016, 5352,
  5712, 6256, 6880, 7312, 8000, 8496, 9024, 9544, 10136, 10984, 11640, 12328, 13048, 13800, 14496, 15312, 15936,
  16816, 17728, 18672,
];
// ec.rs::EC_BYTES_PER_BLOCK, column M.
const EC_BYTES_PER_BLOCK_M = [
  10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28,
  28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
];
// ec.rs::DATA_BYTES_PER_BLOCK, column M: [block1 size, block1 count, block2 size, block2 count].
const DATA_BYTES_PER_BLOCK_M = [
  [16, 1, 0, 0], [28, 1, 0, 0], [44, 1, 0, 0], [32, 2, 0, 0], [43, 2, 0, 0], [27, 4, 0, 0], [31, 4, 0, 0],
  [38, 2, 39, 2], [36, 3, 37, 2], [43, 4, 44, 1], [50, 1, 51, 4], [36, 6, 37, 2], [37, 8, 38, 1], [40, 4, 41, 5],
  [41, 5, 42, 5], [45, 7, 46, 3], [46, 10, 47, 1], [43, 9, 44, 4], [44, 3, 45, 11], [41, 3, 42, 13], [42, 17, 0, 0],
  [46, 17, 0, 0], [47, 4, 48, 14], [45, 6, 46, 14], [47, 8, 48, 13], [46, 19, 47, 4], [45, 22, 46, 3],
  [45, 3, 46, 23], [45, 21, 46, 7], [47, 19, 48, 10], [46, 2, 47, 29], [46, 10, 47, 23], [46, 14, 47, 21],
  [46, 14, 47, 23], [47, 12, 48, 26], [47, 6, 48, 34], [46, 29, 47, 14], [46, 13, 47, 32], [47, 40, 48, 7],
  [47, 18, 48, 31],
];
// canvas.rs::ALIGNMENT_PATTERN_POSITIONS (versions 7..=40).
const ALIGNMENT_PATTERN_POSITIONS = [
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66],
  [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90],
  [6, 28, 50, 72, 94], [6, 26, 50, 74, 98], [6, 30, 54, 78, 102], [6, 28, 54, 80, 106], [6, 32, 58, 84, 110],
  [6, 30, 58, 86, 114], [6, 34, 62, 90, 118], [6, 26, 50, 74, 98, 122], [6, 30, 54, 78, 102, 126],
  [6, 26, 52, 78, 104, 130], [6, 30, 56, 82, 108, 134], [6, 34, 60, 86, 112, 138], [6, 30, 58, 86, 114, 142],
  [6, 34, 62, 90, 118, 146], [6, 30, 54, 78, 102, 126, 150], [6, 24, 50, 76, 102, 128, 154],
  [6, 28, 54, 80, 106, 132, 158], [6, 32, 58, 84, 110, 136, 162], [6, 26, 54, 82, 110, 138, 166],
  [6, 30, 58, 86, 114, 142, 170],
];
// canvas.rs::VERSION_INFOS (versions 7..=40).
const VERSION_INFOS = [
  0x07c94, 0x085bc, 0x09a99, 0x0a4d3, 0x0bbf6, 0x0c762, 0x0d847, 0x0e60d, 0x0f928, 0x10b78, 0x1145d, 0x12a17,
  0x13532, 0x149a6, 0x15683, 0x168c9, 0x177ec, 0x18ec4, 0x191e1, 0x1afab, 0x1b08e, 0x1cc1a, 0x1d33f, 0x1ed75,
  0x1f250, 0x209d5, 0x216f0, 0x228ba, 0x2379f, 0x24b0b, 0x2542e, 0x26a64, 0x27541, 0x28c69,
];
// canvas.rs::FORMAT_INFOS_QR[((EcLevel::M as usize) ^ 1) << 3 | mask] = entries 0..8.
const FORMAT_INFOS_QR_M = [0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0];

// GF(256) with the QR polynomial 0x11d — ec.rs EXP_TABLE / LOG_TABLE / GENERATOR_POLYNOMIALS
// (derived here; test/unit/qr.test.mjs pins them to the crate's literal tables).
const EXP_TABLE = new Uint8Array(256);
const LOG_TABLE = new Uint8Array(256);
{
  let v = 1;
  for (let i = 0; i < 256; i++) { EXP_TABLE[i] = v; v <<= 1; if (v & 0x100) v ^= 0x11d; }
  LOG_TABLE[0] = 0xff;
  for (let i = 0; i < 255; i++) LOG_TABLE[EXP_TABLE[i]] = i;
}
const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP_TABLE[(LOG_TABLE[a] + LOG_TABLE[b]) % 255]);
const GENERATOR_CACHE = new Map();
/** Logs of the coefficients (x^(n-1) … x^0) of ∏_{i<n}(x − α^i) — ec.rs GENERATOR_POLYNOMIALS[n]. */
export function generatorPolynomial(n) {
  let logs = GENERATOR_CACHE.get(n);
  if (logs) return logs;
  let poly = [1];                                            // coefficients, highest degree first
  for (let i = 0; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let k = 0; k < poly.length; k++) {
      next[k] ^= poly[k];
      next[k + 1] ^= gfMul(poly[k], EXP_TABLE[i]);
    }
    poly = next;
  }
  logs = Uint8Array.from(poly.slice(1), (c) => LOG_TABLE[c]);
  GENERATOR_CACHE.set(n, logs);
  return logs;
}

// types.rs::Mode::length_bits_count / data_bits_count / max (Normal versions).
function lengthBitsCount(mode, version) {
  if (version <= 9) return [10, 9, 8, 8][mode];
  if (version <= 26) return [12, 11, 16, 10][mode];
  return [14, 13, 16, 12][mode];
}
function dataBitsCount(mode, n) {
  switch (mode) {
    case NUMERIC: return Math.floor((n * 10 + 2) / 3);
    case ALNUM: return Math.floor((n * 11 + 1) / 2);
    case BYTE: return n * 8;
    default: return n * 13;
  }
}
function modePartialCmp(a, b) {
  if (a === b) return 0;
  if ((a === NUMERIC && b === ALNUM) || b === BYTE) return -1;
  if ((a === ALNUM && b === NUMERIC) || a === BYTE) return 1;
  return null;
}
function modeMax(a, b) {
  const c = modePartialCmp(a, b);
  return c === 1 ? a : c === null ? BYTE : b;
}

// optimize.rs::Segment::encoded_len (mode indicator is 4 bits on Normal versions).
function encodedLen(seg, version) {
  const bytes = seg.end - seg.begin;
  const chars = seg.mode === KANJI ? Math.floor(bytes / 2) : bytes;
  return 4 + lengthBitsCount(seg.mode, version) + dataBitsCount(seg.mode, chars);
}

// optimize.rs::ExclCharSet::from_u8.
const END = 0, SYMBOL = 1, NUMBER = 2, ALPHA = 3, HI1 = 4, HI2 = 5, HI3 = 6, LO1 = 7, LO2 = 8, OTHER = 9;
const CHAR_SET = new Uint8Array(256).map((_, c) => {
  if (c === 0x20 || c === 0x24 || c === 0x25 || c === 0x2a || c === 0x2b || (c >= 0x2d && c <= 0x2f) || c === 0x3a) return SYMBOL;
  if (c >= 0x30 && c <= 0x39) return NUMBER;
  if (c >= 0x41 && c <= 0x5a) return ALPHA;
  if (c >= 0x81 && c <= 0x9f) return HI1;
  if (c >= 0xe0 && c <= 0xea) return HI2;
  if (c === 0xeb) return HI3;
  if (c === 0x40 || (c >= 0x5b && c <= 0x7e) || c === 0x80 || (c >= 0xa0 && c <= 0xbf)) return LO1;
  if ((c >= 0xc0 && c <= 0xdf) || (c >= 0xec && c <= 0xfc)) return LO2;
  return OTHER;
});
// optimize.rs::State (values index STATE_TRANSITION) and Action.
const S_INIT = 0, S_NUM = 10, S_ALPHA = 20, S_BYTE = 30, S_HI12 = 40, S_HI3 = 50, S_KANJI = 60;
const A_IDLE = 0, A_NUM = 1, A_ALPHA = 2, A_BYTE = 3, A_KANJI = 4, A_KANJI_SINGLE = 5;
// optimize.rs::STATE_TRANSITION[state + char_set] = [next_state, action]; columns:
// End, Symbol, Numeric, Alpha, KanjiHi1, KanjiHi2, KanjiHi3, KanjiLo1, KanjiLo2, Byte.
const STATE_TRANSITION = [
  // Init
  [S_INIT, A_IDLE], [S_ALPHA, A_IDLE], [S_NUM, A_IDLE], [S_ALPHA, A_IDLE], [S_HI12, A_IDLE], [S_HI12, A_IDLE],
  [S_HI3, A_IDLE], [S_BYTE, A_IDLE], [S_BYTE, A_IDLE], [S_BYTE, A_IDLE],
  // Numeric
  [S_INIT, A_NUM], [S_ALPHA, A_NUM], [S_NUM, A_IDLE], [S_ALPHA, A_NUM], [S_HI12, A_NUM], [S_HI12, A_NUM],
  [S_HI3, A_NUM], [S_BYTE, A_NUM], [S_BYTE, A_NUM], [S_BYTE, A_NUM],
  // Alpha
  [S_INIT, A_ALPHA], [S_ALPHA, A_IDLE], [S_NUM, A_ALPHA], [S_ALPHA, A_IDLE], [S_HI12, A_ALPHA], [S_HI12, A_ALPHA],
  [S_HI3, A_ALPHA], [S_BYTE, A_ALPHA], [S_BYTE, A_ALPHA], [S_BYTE, A_ALPHA],
  // Byte
  [S_INIT, A_BYTE], [S_ALPHA, A_BYTE], [S_NUM, A_BYTE], [S_ALPHA, A_BYTE], [S_HI12, A_BYTE], [S_HI12, A_BYTE],
  [S_HI3, A_BYTE], [S_BYTE, A_IDLE], [S_BYTE, A_IDLE], [S_BYTE, A_IDLE],
  // KanjiHi12
  [S_INIT, A_KANJI_SINGLE], [S_ALPHA, A_KANJI_SINGLE], [S_NUM, A_KANJI_SINGLE], [S_KANJI, A_IDLE],
  [S_KANJI, A_IDLE], [S_KANJI, A_IDLE], [S_KANJI, A_IDLE], [S_KANJI, A_IDLE], [S_KANJI, A_IDLE],
  [S_BYTE, A_KANJI_SINGLE],
  // KanjiHi3
  [S_INIT, A_KANJI_SINGLE], [S_ALPHA, A_KANJI_SINGLE], [S_NUM, A_KANJI_SINGLE], [S_KANJI, A_IDLE],
  [S_KANJI, A_IDLE], [S_HI12, A_KANJI_SINGLE], [S_HI3, A_KANJI_SINGLE], [S_KANJI, A_IDLE],
  [S_BYTE, A_KANJI_SINGLE], [S_BYTE, A_KANJI_SINGLE],
  // Kanji
  [S_INIT, A_KANJI], [S_ALPHA, A_KANJI], [S_NUM, A_KANJI], [S_ALPHA, A_KANJI], [S_HI12, A_IDLE], [S_HI12, A_IDLE],
  [S_HI3, A_IDLE], [S_BYTE, A_KANJI], [S_BYTE, A_KANJI], [S_BYTE, A_KANJI],
];
const ACTION_MODE = [undefined, NUMERIC, ALNUM, BYTE, KANJI];

/** optimize.rs::Parser — split `data` into segments of their exclusive character sets. */
export function parseSegments(data) {
  const out = [];
  let state = S_INIT, begin = 0, pendingSingleByte = false, index = 0, ended = false;
  for (;;) {
    if (pendingSingleByte) {
      pendingSingleByte = false;
      begin += 1;
      out.push({ mode: BYTE, begin: begin - 1, end: begin });
      continue;
    }
    let seg = null;
    while (!ended) {
      let i, ecs;
      if (index >= data.length) { ended = true; i = index; ecs = END; } else { i = index; ecs = CHAR_SET[data[index]]; index++; }
      const [nextState, action] = STATE_TRANSITION[state + ecs];
      state = nextState;
      const oldBegin = begin;
      let pushMode;
      if (action === A_IDLE) continue;
      if (action === A_KANJI_SINGLE) {
        const nextBegin = i - 1;
        if (begin === nextBegin) pushMode = BYTE;
        else {
          pendingSingleByte = true;
          begin = nextBegin;
          seg = { mode: KANJI, begin: oldBegin, end: nextBegin };
          break;
        }
      } else pushMode = ACTION_MODE[action];
      begin = i;
      seg = { mode: pushMode, begin: oldBegin, end: i };
      break;
    }
    if (!seg) return out;
    out.push(seg);
  }
}

/** optimize.rs::Optimizer — greedy left-to-right merge while it does not grow the encoding. */
export function optimizeSegments(segments, version) {
  const out = [];
  if (!segments.length) return out;
  let last = segments[0];
  let lastSize = encodedLen(last, version);
  for (let k = 1; k < segments.length; k++) {
    const seg = segments[k];
    const segSize = encodedLen(seg, version);
    const merged = { mode: modeMax(last.mode, seg.mode), begin: last.begin, end: seg.end };
    const newSize = encodedLen(merged, version);
    if (lastSize + segSize >= newSize) { last = merged; lastSize = newSize; } else { out.push(last); last = seg; lastSize = segSize; }
  }
  out.push(last);
  return out;
}

// bits.rs::alphanumeric_digit.
const ALNUM_DIGIT = new Uint16Array(256).map((_, c) => {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x5a) return c - 0x41 + 10;
  return { 0x20: 36, 0x24: 37, 0x25: 38, 0x2a: 39, 0x2b: 40, 0x2d: 41, 0x2e: 42, 0x2f: 43, 0x3a: 44 }[c] ?? 0;
});

/** bits.rs::Bits for a Normal version. */
class Bits {
  constructor(version) { this.data = []; this.bitOffset = 0; this.version = version; }

  pushNumber(n, number) {
    const b = this.bitOffset + n;
    const last = this.data.length - 1;
    if (this.bitOffset === 0) {
      if (b <= 8) this.data.push((number << (8 - b)) & 0xff);
      else { this.data.push((number >> (b - 8)) & 0xff); this.data.push((number << (16 - b)) & 0xff); }
    } else if (b <= 8) {
      this.data[last] |= (number << (8 - b)) & 0xff;
    } else if (b <= 16) {
      this.data[last] |= (number >> (b - 8)) & 0xff;
      this.data.push((number << (16 - b)) & 0xff);
    } else {
      this.data[last] |= (number >> (b - 8)) & 0xff;
      this.data.push((number >> (b - 16)) & 0xff);
      this.data.push((number << (24 - b)) & 0xff);
    }
    this.bitOffset = b & 7;
  }

  pushNumberChecked(n, number) {
    if (n > 16 || number >= 2 ** n) throw new QrError(QrError.DataTooLong);
    this.pushNumber(n, number);
  }

  len() { return this.bitOffset === 0 ? this.data.length * 8 : (this.data.length - 1) * 8 + this.bitOffset; }

  pushHeader(mode, rawDataLen) {
    this.pushNumber(4, [0b0001, 0b0010, 0b0100, 0b1000][mode]);   // push_mode_indicator (4 bits, cannot overflow)
    this.pushNumberChecked(lengthBitsCount(mode, this.version), rawDataLen);
  }

  pushNumericData(data) {
    this.pushHeader(NUMERIC, data.length);
    for (let k = 0; k < data.length; k += 3) {
      const chunk = data.subarray(k, k + 3);
      let number = 0;
      for (const b of chunk) number = (number * 10 + ((b - 0x30) & 0xff)) & 0xffff;
      this.pushNumber(chunk.length * 3 + 1, number);
    }
  }

  pushAlphanumericData(data) {
    this.pushHeader(ALNUM, data.length);
    for (let k = 0; k < data.length; k += 2) {
      const chunk = data.subarray(k, k + 2);
      let number = 0;
      for (const b of chunk) number = (number * 45 + ALNUM_DIGIT[b]) & 0xffff;
      this.pushNumber(chunk.length * 5 + 1, number);
    }
  }

  pushByteData(data) {
    this.pushHeader(BYTE, data.length);
    for (const b of data) this.pushNumber(8, b);
  }

  pushKanjiData(data) {
    this.pushHeader(KANJI, Math.floor(data.length / 2));
    for (let k = 0; k < data.length; k += 2) {
      if (k + 1 >= data.length) throw new QrError(QrError.InvalidCharacter);
      const cp = data[k] * 256 + data[k + 1];
      const bytes = (cp < 0xe040 ? cp - 0x8140 : cp - 0xc140) & 0xffff;
      this.pushNumber(13, ((bytes >> 8) * 0xc0 + (bytes & 0xff)) & 0xffff);
    }
  }

  pushSegments(data, segments) {
    for (const seg of segments) {
      const slice = data.subarray(seg.begin, seg.end);
      if (seg.mode === NUMERIC) this.pushNumericData(slice);
      else if (seg.mode === ALNUM) this.pushAlphanumericData(slice);
      else if (seg.mode === BYTE) this.pushByteData(slice);
      else this.pushKanjiData(slice);
    }
  }

  pushTerminator() {
    const curLength = this.len();
    const dataLength = DATA_LENGTHS_M[this.version - 1];
    if (curLength > dataLength) throw new QrError(QrError.DataTooLong);
    const terminatorSize = Math.min(4, dataLength - curLength);
    if (terminatorSize > 0) this.pushNumber(terminatorSize, 0);
    if (this.len() < dataLength) {
      this.bitOffset = 0;
      const padding = dataLength / 8 - this.data.length;
      for (let k = 0; k < padding; k++) this.data.push(k % 2 === 0 ? 0b1110_1100 : 0b0001_0001);
    }
    if (this.len() < dataLength) this.data.push(0);
  }
}

// bits.rs::find_min_version (binary search exactly as the crate does it).
function findMinVersion(length) {
  let base = 0, size = 39;
  while (size > 1) {
    const half = size >> 1;
    const mid = base + half;
    base = DATA_LENGTHS_M[mid] > length ? base : mid;
    size -= half;
  }
  base = DATA_LENGTHS_M[base] >= length ? base : base + 1;
  return base + 1;
}

/** bits.rs::encode_auto(data, EcLevel::M) → Bits. */
function encodeAuto(data) {
  const segments = parseSegments(data);
  for (const version of [9, 26, 40]) {
    const opt = optimizeSegments(segments, version);
    const total = opt.reduce((sum, seg) => sum + encodedLen(seg, version), 0);
    if (total <= DATA_LENGTHS_M[version - 1]) {
      const bits = new Bits(findMinVersion(total));
      bits.pushSegments(data, opt);
      bits.pushTerminator();
      return bits;
    }
  }
  throw new QrError(QrError.DataTooLong);
}

// ec.rs::create_error_correction_code.
function createErrorCorrectionCode(data, ecCodeSize) {
  const logDen = generatorPolynomial(ecCodeSize);
  const res = new Uint8Array(data.length + ecCodeSize);
  res.set(data);
  for (let i = 0; i < data.length; i++) {
    const lead = res[i];
    if (lead === 0) continue;
    const logLead = LOG_TABLE[lead];
    for (let k = 0; k < logDen.length; k++) res[i + 1 + k] ^= EXP_TABLE[(logDen[k] + logLead) % 255];
  }
  return res.subarray(data.length);
}

// ec.rs::interleave.
function interleave(blocks) {
  const lastLen = blocks[blocks.length - 1].length;
  const out = [];
  for (let i = 0; i < lastLen; i++) for (const t of blocks) if (i < t.length) out.push(t[i]);
  return out;
}

// ec.rs::construct_codewords(rawbits, version, EcLevel::M).
function constructCodewords(raw, version) {
  const [size1, count1, size2] = DATA_BYTES_PER_BLOCK_M[version - 1];
  const end1 = size1 * count1;
  const blocks = [];
  for (let k = 0; k < end1; k += size1) blocks.push(raw.subarray(k, k + size1));
  if (size2 > 0) for (let k = end1; k < raw.length; k += size2) blocks.push(raw.subarray(k, k + size2));
  const ecBytes = EC_BYTES_PER_BLOCK_M[version - 1];
  const ecCodes = blocks.map((block) => createErrorCorrectionCode(block, ecBytes));
  return [interleave(blocks), interleave(ecCodes)];
}

// canvas.rs::Module — EMPTY, Masked(color) = 2|color, Unmasked(color) = 4|color.
const EMPTY = 0, MASKED = 2, UNMASKED = 4;
const moduleColor = (m) => (m === EMPTY ? LIGHT : m & 1);

// canvas.rs::FORMAT_INFO_COORDS_QR_MAIN / _SIDE, VERSION_INFO_COORDS_BL / _TR.
const FORMAT_INFO_COORDS_QR_MAIN = [[0, 8], [1, 8], [2, 8], [3, 8], [4, 8], [5, 8], [7, 8], [8, 8], [8, 7], [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0]];
const FORMAT_INFO_COORDS_QR_SIDE = [[8, -1], [8, -2], [8, -3], [8, -4], [8, -5], [8, -6], [8, -7], [-8, 8], [-7, 8], [-6, 8], [-5, 8], [-4, 8], [-3, 8], [-2, 8], [-1, 8]];
const VERSION_INFO_COORDS_BL = [5, 4, 3, 2, 1, 0].flatMap((x) => [[x, -9], [x, -10], [x, -11]]);
const VERSION_INFO_COORDS_TR = [5, 4, 3, 2, 1, 0].flatMap((y) => [[-9, y], [-10, y], [-11, y]]);

// canvas.rs::mask_functions (x, y ≥ 0).
const MASK_FUNCTIONS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];
const FINDER_PENALTY_PATTERN = [DARK, LIGHT, DARK, DARK, DARK, LIGHT, DARK];

/** canvas.rs::Canvas for a Normal version. */
class Canvas {
  constructor(version, modules) {
    this.version = version;
    this.width = version * 4 + 17;
    this.modules = modules ?? new Uint8Array(this.width * this.width);
  }
  index(x, y) {
    const w = this.width;
    return (y < 0 ? y + w : y) * w + (x < 0 ? x + w : x);
  }
  get(x, y) { return this.modules[this.index(x, y)]; }
  put(x, y, color) { this.modules[this.index(x, y)] = MASKED | color; }

  drawFinderPatternAt(x, y) {
    const [dxLeft, dxRight] = x >= 0 ? [-3, 4] : [-4, 3];
    const [dyTop, dyBottom] = y >= 0 ? [-3, 4] : [-4, 3];
    for (let j = dyTop; j <= dyBottom; j++) {
      for (let i = dxLeft; i <= dxRight; i++) {
        const ai = Math.abs(i), aj = Math.abs(j);
        const color = ai === 4 || aj === 4 ? LIGHT : ai === 3 || aj === 3 ? DARK : ai === 2 || aj === 2 ? LIGHT : DARK;
        this.put(x + i, y + j, color);
      }
    }
  }

  drawAlignmentPatternAt(x, y) {
    if (this.get(x, y) !== EMPTY) return;
    for (let j = -2; j <= 2; j++) {
      for (let i = -2; i <= 2; i++) {
        const color = Math.abs(i) === 2 || Math.abs(j) === 2 || (i === 0 && j === 0) ? DARK : LIGHT;
        this.put(x + i, y + j, color);
      }
    }
  }

  drawAlignmentPatterns() {
    const v = this.version;
    if (v === 1) return;
    if (v <= 6) { this.drawAlignmentPatternAt(-7, -7); return; }
    const positions = ALIGNMENT_PATTERN_POSITIONS[v - 7];
    for (const x of positions) for (const y of positions) this.drawAlignmentPatternAt(x, y);
  }

  drawLine(x1, y1, x2, y2, colorEven, colorOdd) {
    if (y1 === y2) for (let x = x1; x <= x2; x++) this.put(x, y1, x % 2 === 0 ? colorEven : colorOdd);
    else for (let y = y1; y <= y2; y++) this.put(x1, y, y % 2 === 0 ? colorEven : colorOdd);
  }

  drawTimingPatterns() {
    const w = this.width;
    this.drawLine(8, 6, w - 9, 6, DARK, LIGHT);
    this.drawLine(6, 8, 6, w - 9, DARK, LIGHT);
  }

  drawNumber(number, bits, onColor, offColor, coords) {
    let mask = 2 ** (bits - 1);
    for (const [x, y] of coords) {
      this.put(x, y, Math.floor(number / mask) % 2 === 0 ? offColor : onColor);
      mask /= 2;
    }
  }

  drawFormatInfoPatternsWithNumber(formatInfo) {
    this.drawNumber(formatInfo, 15, DARK, LIGHT, FORMAT_INFO_COORDS_QR_MAIN);
    this.drawNumber(formatInfo, 15, DARK, LIGHT, FORMAT_INFO_COORDS_QR_SIDE);
    this.put(8, -8, DARK);                                   // dark module
  }

  drawVersionInfoPatterns() {
    if (this.version <= 6) return;
    const info = VERSION_INFOS[this.version - 7];
    this.drawNumber(info, 18, DARK, LIGHT, VERSION_INFO_COORDS_BL);
    this.drawNumber(info, 18, DARK, LIGHT, VERSION_INFO_COORDS_TR);
  }

  drawAllFunctionalPatterns() {
    this.drawFinderPatternAt(3, 3);
    this.drawFinderPatternAt(-4, 3);
    this.drawFinderPatternAt(3, -4);
    this.drawAlignmentPatterns();
    this.drawFormatInfoPatternsWithNumber(0);                // reserved
    this.drawTimingPatterns();
    this.drawVersionInfoPatterns();
  }

  // canvas.rs::DataModuleIter + draw_codewords (no half codeword on Normal versions).
  drawData(data, ec) {
    const w = this.width, timingColumn = 6;
    let x = w - 1, y = w - 1;
    const next = () => {
      const adjusted = x <= timingColumn ? x + 1 : x;
      if (adjusted <= 0) return null;
      const res = [x, y];
      const columnType = (w - adjusted) % 4;
      if (columnType === 2 && y > 0) { y -= 1; x += 1; }
      else if (columnType === 0 && y < w - 1) { y += 1; x += 1; }
      else if ((columnType === 0 || columnType === 2) && x === timingColumn + 1) x -= 2;
      else x -= 1;
      return res;
    };
    const drawCodewords = (codewords) => {
      for (const b of codewords) {
        for (let j = 7; j >= 0; j--) {
          const color = (b >> j) & 1;
          let placed = false;
          for (let c = next(); c; c = next()) {
            const i = this.index(c[0], c[1]);
            if (this.modules[i] === EMPTY) { this.modules[i] = UNMASKED | color; placed = true; break; }
          }
          if (!placed) return false;
        }
      }
      return true;
    };
    drawCodewords(data);
    drawCodewords(ec);
  }

  applyMask(pattern) {
    const fn = MASK_FUNCTIONS[pattern], w = this.width, m = this.modules;
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < w; y++) {
        const i = y * w + x, cur = m[i], invert = fn(x, y) ? 1 : 0;
        if (cur === EMPTY) m[i] = MASKED | invert;
        else if (cur & UNMASKED) m[i] = MASKED | ((cur & 1) ^ invert);
      }
    }
    this.drawFormatInfoPatternsWithNumber(FORMAT_INFOS_QR_M[pattern]);
  }

  // Penalty scores — u16 arithmetic with release-build wrapping, as upstream ships.
  // Line i of the matrix: module (j, i) when horizontal, (i, j) when vertical.
  adjacentPenaltyScore(isHorizontal) {
    const w = this.width, m = this.modules;
    const step = isHorizontal ? 1 : w;
    let total = 0;
    for (let i = 0; i < w; i++) {
      const start = isHorizontal ? i * w : i;
      let last = EMPTY, len = 1;
      for (let j = 0; j <= w; j++) {
        const cur = j === w ? EMPTY : m[start + j * step];      // chained Module::Empty terminator
        if (cur === last) len++;
        else {
          last = cur;
          if (len >= 5) total = (total + len - 2) & 0xffff;
          len = 1;
        }
      }
    }
    return total;
  }

  blockPenaltyScore() {
    const w = this.width, m = this.modules;
    let total = 0;
    for (let i = 0; i < w - 1; i++) {
      for (let j = 0; j < w - 1; j++) {
        const at = j * w + i, t = m[at];
        if (t === m[at + 1] && t === m[at + w] && t === m[at + w + 1]) total = (total + 3) & 0xffff;
      }
    }
    return total;
  }

  finderPenaltyScore(isHorizontal) {
    const w = this.width, m = this.modules;
    const step = isHorizontal ? 1 : w;
    const line = new Uint8Array(w);
    let total = 0;
    for (let i = 0; i < w; i++) {
      const start = isHorizontal ? i * w : i;
      for (let k = 0; k < w; k++) line[k] = moduleColor(m[start + k * step]);
      const dark = (k) => k >= 0 && k < w && line[k] !== LIGHT;
      for (let j = 0; j < w - 6; j++) {
        let match = true;
        for (let k = 0; k < 7; k++) if (line[j + k] !== FINDER_PENALTY_PATTERN[k]) { match = false; break; }
        if (!match) continue;
        let before = false, after = false;
        for (let k = j - 4; k < j; k++) if (dark(k)) { before = true; break; }
        for (let k = j + 7; k < j + 11; k++) if (dark(k)) { after = true; break; }
        if (!before || !after) total = (total + 40) & 0xffff;
      }
    }
    return (total - 360) & 0xffff;
  }

  balancePenaltyScore() {
    const m = this.modules;
    let dark = 0;
    for (let i = 0; i < m.length; i++) if (m[i] !== EMPTY && (m[i] & 1)) dark++;
    const ratio = Math.floor((dark * 200) / m.length);
    return ratio >= 100 ? ratio - 100 : 100 - ratio;
  }

  totalPenaltyScore() {
    return (this.adjacentPenaltyScore(true) + this.adjacentPenaltyScore(false) + this.blockPenaltyScore()
      + this.finderPenaltyScore(true) + this.finderPenaltyScore(false) + this.balancePenaltyScore()) & 0xffff;
  }

  // canvas.rs::apply_best_mask — Iterator::min_by_key keeps the first minimum.
  applyBestMask() {
    let best = null, bestScore = Infinity;
    for (let pattern = 0; pattern < 8; pattern++) {
      const c = new Canvas(this.version, this.modules.slice());
      c.applyMask(pattern);
      const score = c.totalPenaltyScore();
      if (score < bestScore) { best = c; bestScore = score; }
    }
    return best;
  }
}

/**
 * The encoded symbol — qrcode::QrCode. `colors[y * width + x]` is 1 for dark.
 * `QrCode.new(data)` mirrors `QrCode::new` (EC level M, smallest Normal version).
 */
export class QrCode {
  constructor(version, colors) {
    this.version = version;
    this.width = version * 4 + 17;
    this.colors = colors;
  }

  static new(data) {
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Uint8Array.from(data);
    const bits = encodeAuto(bytes);
    const version = bits.version;
    const [encoded, ec] = constructCodewords(Uint8Array.from(bits.data), version);
    const canvas = new Canvas(version);
    canvas.drawAllFunctionalPatterns();
    canvas.drawData(encoded, ec);
    const best = canvas.applyBestMask();
    return new QrCode(version, best.modules.map(moduleColor));
  }

  isDark(x, y) { return this.colors[y * this.width + x] === DARK; }
}

// ===========================================================================
// upstream cli/src/qr.rs
// ===========================================================================

const PNG_SCALE = 8;
const PNG_QUIET_ZONE = 4;
const UNICODE_QUIET_ZONE = 4;                                // QrCode::render quiet zone for Normal versions
const DENSE1X2_CODEPAGE = [' ', '\u2584', '\u2580', '\u2588'];

/**
 * Render `text` as an inverted `Dense1x2` Unicode QR block (quiet zone on).
 * `text` is encoded as its UTF-8 bytes (a Uint8Array is taken verbatim).
 * Throws QrError on encode failure. upstream: qr.rs::render_address_qr_unicode
 */
export function renderAddressQrUnicode(text) {
  return renderDense1x2Inverted(QrCode.new(text));
}

/**
 * Render `text` as an 8-bit grayscale PNG (8 px per module, 4-module quiet zone,
 * stored-deflate zlib). Throws QrError on encode failure.
 * upstream: qr.rs::render_address_qr_png
 */
export function renderAddressQrPng(text) {
  return renderGrayscalePng(QrCode.new(text));
}

/** `code.render::<Dense1x2>().dark_color(Light).light_color(Dark).quiet_zone(true).build()`. */
export function renderDense1x2Inverted(code) {
  // render::<Dense1x2>().dark_color(Light).light_color(Dark): canvas starts at
  // Dark.value() = 1 (light modules + quiet zone); dark modules draw Light.value() = 0.
  const w = code.width, qz = UNICODE_QUIET_ZONE, size = w + 2 * qz;
  const px = new Uint8Array(size * size).fill(1);
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) if (code.isDark(x, y)) px[(y + qz) * size + x + qz] = 0;
  const rows = [];
  for (let y = 0; y < size; y += 2) {
    let row = '';
    for (let x = 0; x < size; x++) {
      const top = px[y * size + x];
      row += DENSE1X2_CODEPAGE[y + 1 < size ? top * 2 + px[(y + 1) * size + x] : top * 2];
    }
    rows.push(row);
  }
  return rows.join('\n');
}

/** Pixel body of render_address_qr_png for an encoded symbol. */
export function renderGrayscalePng(code) {
  const modules = code.width;
  const size = (modules + PNG_QUIET_ZONE * 2) * PNG_SCALE;
  const stride = size + 1;
  const raw = Buffer.alloc(stride * size, 255);
  for (let y = 0; y < size; y++) {
    const row = y * stride;
    const my = Math.floor(y / PNG_SCALE);
    if (y % PNG_SCALE !== 0) { raw.copyWithin(row, row - stride, row); continue; }   // same module row
    raw[row] = 0;                                            // PNG filter: None
    if (my < PNG_QUIET_ZONE || my >= PNG_QUIET_ZONE + modules) continue;
    for (let mx = PNG_QUIET_ZONE; mx < PNG_QUIET_ZONE + modules; mx++) {
      if (code.isDark(mx - PNG_QUIET_ZONE, my - PNG_QUIET_ZONE)) raw.fill(0, row + 1 + mx * PNG_SCALE, row + 1 + (mx + 1) * PNG_SCALE);
    }
  }
  return encodeGrayscalePng(size, size, raw);
}

/** upstream: qr.rs::encode_grayscale_png */
export function encodeGrayscalePng(width, height, rawRows) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width >>> 0, 0);
  ihdr.writeUInt32BE(height >>> 0, 4);
  ihdr.set([8, 0, 0, 0, 0], 8);                              // 8-bit grayscale
  const out = [Buffer.from('\x89PNG\r\n\x1a\n', 'latin1')];
  pushPngChunk(out, 'IHDR', ihdr);
  pushPngChunk(out, 'IDAT', zlibStore(rawRows));
  pushPngChunk(out, 'IEND', Buffer.alloc(0));
  return Buffer.concat(out);
}

/** zlib stream of stored (uncompressed) deflate blocks. upstream: qr.rs::zlib_store */
export function zlibStore(data) {
  const MAX = 0xffff;
  const blocks = Math.ceil(data.length / MAX);
  const out = Buffer.alloc(2 + blocks * 5 + data.length + 4);
  out[0] = 0x78; out[1] = 0x01;                              // zlib header: no compression/fastest
  let o = 2;
  const finalIndex = Math.floor(Math.max(data.length - 1, 0) / MAX);
  for (let i = 0; i < blocks; i++) {
    const chunk = data.subarray(i * MAX, Math.min((i + 1) * MAX, data.length));
    out[o++] = i === finalIndex ? 0x01 : 0x00;
    out.writeUInt16LE(chunk.length, o); o += 2;
    out.writeUInt16LE(~chunk.length & 0xffff, o); o += 2;
    out.set(chunk, o); o += chunk.length;
  }
  out.writeUInt32BE(adler32(data), o);
  return out;
}

/** upstream: qr.rs::push_png_chunk (chunk list, concatenated by the caller) */
export function pushPngChunk(out, kind, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(kind, 4, 'latin1');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(data, crc32(head.subarray(4))), 0);   // crc32(kind ‖ data)
  out.push(head, data, tail);
}

/** upstream: qr.rs::adler32 */
export function adler32(data) {
  // Same residues as upstream's per-byte `% MOD`, reduced every 5552 bytes (zlib NMAX,
  // the largest run that cannot overflow 2^53 here either).
  const MOD = 65521, NMAX = 5552;
  let a = 1, b = 0;
  for (let i = 0; i < data.length;) {
    const end = Math.min(i + NMAX, data.length);
    for (; i < end; i++) { a += data[i]; b += a; }
    a %= MOD; b %= MOD;
  }
  return ((b << 16) | a) >>> 0;
}

// Upstream's bitwise reflected CRC-32 (poly 0xEDB88320, init/xorout 0xFFFFFFFF) is the
// standard IEEE CRC-32: node:zlib's native crc32 (Node >= 20.15 / 22.2) when present,
// else the equivalent table form.
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  return c >>> 0;
});
const nativeCrc32 = typeof zlib.crc32 === 'function' ? zlib.crc32 : null;
/** CRC-32 of `data`; `prev` continues a running CRC (crc32(b, crc32(a)) = crc32(a ‖ b)). upstream: qr.rs::crc32 */
export function crc32(data, prev = 0) {
  return nativeCrc32 ? nativeCrc32(data, prev) >>> 0 : crc32Table(data, prev);
}
/** Table-only CRC-32 (the fallback path, also exercised by the tests). */
export function crc32Table(data, prev = 0) {
  let crc = ~prev;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (~crc) >>> 0;
}

// ---------------------------------------------------------------------------
// Common QR output (QrOutput, display mode, PNG directory, markdown / notify).
// ---------------------------------------------------------------------------

/** PNG filename stem for on-disk QR images (`<stem>-<pid>-<ts>.png`). */
export const QR_PNG_FILENAME_PREFIX = 'onchainos-funding-qr';
/** qr.rs::QrDisplayMode::as_str values. */
export const QrDisplayMode = Object.freeze({ TerminalUnicode: 'terminal-unicode', ImageNotify: 'image-notify' });

/**
 * QrOutput struct (camelCase, declaration order; None fields skipped).
 * upstream: qr.rs::QrOutput
 */
export function qrOutput({ requestedFormat, resolvedFormat, displayMode, terminalQr, imagePath, mimeType, markdownImage, notifyCommandArgs }) {
  return struct({
    requestedFormat,
    resolvedFormat: resolvedFormat ?? undefined,
    displayMode,
    terminalQr: terminalQr ?? undefined,
    imagePath: imagePath ?? undefined,
    mimeType: mimeType ?? undefined,
    markdownImage: markdownImage ?? undefined,
    notifyCommandArgs: notifyCommandArgs ?? undefined,
  });
}

/**
 * Common QR output for `address`; display mode from the runtime (Codex session
 * metadata, else TTY). Never throws: encode/write failures degrade to
 * `{requestedFormat, displayMode}`. upstream: qr.rs::build_qr_output
 */
export function buildQrOutput(address, imageDir = null) {
  return buildQrOutputWithMode(address, imageDir, detectDisplayMode());
}

/** upstream: qr.rs::display_mode */
export function displayMode() {
  return detectDisplayMode();
}

/** Testable seam with an explicit display mode. upstream: qr.rs::build_qr_output_with_mode */
export function buildQrOutputWithMode(address, imageDir, mode) {
  const out = { requestedFormat: 'auto', displayMode: mode };
  if (mode === QrDisplayMode.ImageNotify) {
    let path = null;
    try { path = writeQrPng(address, imageDir); } catch {}
    if (path !== null) {
      out.resolvedFormat = 'png';
      out.markdownImage = markdownImageForPath(path);
      out.notifyCommandArgs = notifyCommandArgsForPath(path);
      out.imagePath = path;
      out.mimeType = 'image/png';
    }
  } else {
    try {
      out.terminalQr = renderAddressQrUnicode(address);
      out.resolvedFormat = 'unicode';
    } catch {}
  }
  return qrOutput(out);
}

// SystemTime::now().duration_since(UNIX_EPOCH).as_nanos() as a decimal string
// (Windows FILETIME resolution is 100 ns, as Rust reports there).
function unixNanos() {
  const ms = performance.timeOrigin + performance.now();
  let nanos = BigInt(Math.floor(ms)) * 1_000_000n + BigInt(Math.floor((ms % 1) * 1e6));
  if (process.platform === 'win32') nanos -= nanos % 100n;
  return nanos.toString();
}

/**
 * Write the PNG for `address` into the first writable candidate directory and
 * return its path: `imageDir` > $ONCHAINOS_FUNDING_IMAGE_DIR > <home>/tmp/funding-qr >
 * <cwd>/.onchainos/tmp/funding-qr > OS temp dir. upstream: qr.rs::write_qr_png
 */
export function writeQrPng(address, imageDir = null) {
  let png;
  try { png = renderAddressQrPng(address); } catch (e) { throw new Error(`Failed to encode QR for ${address}: ${e.message}`); }
  const filename = `${QR_PNG_FILENAME_PREFIX}-${process.pid}-${unixNanos()}.png`;

  // Candidates in priority order (thunks: env::temp_dir() is side-effect free upstream,
  // but on macOS without $TMPDIR lite has to ask getconf, so only when it is reached).
  const candidates = [];
  if (imageDir !== null && imageDir !== undefined) candidates.push(() => String(imageDir));
  if (process.env.ONCHAINOS_FUNDING_IMAGE_DIR !== undefined) {
    const dir = process.env.ONCHAINOS_FUNDING_IMAGE_DIR;
    candidates.push(() => dir);
  }
  const stateDir = home();
  candidates.push(() => rustJoin(stateDir, 'tmp', 'funding-qr'));
  let cwd = null;
  try { cwd = process.cwd(); } catch {}
  if (cwd !== null) candidates.push(() => rustJoin(cwd, '.onchainos', 'tmp', 'funding-qr'));
  candidates.push(rustTempDir);

  let lastError = null;
  for (const candidate of candidates) {
    const dir = candidate();
    try { ensureDir0700(dir); } catch (err) { lastError = [rustJoin(dir, filename), err]; continue; }
    const path = rustJoin(dir, filename);
    try { writeFileSync(fsPath(path), png); return path; } catch (err) { lastError = [path, err]; }
  }
  if (!lastError) throw new Error('no PNG directory candidates');
  throw new Error(`failed to write QR PNG ${lastError[0]}: ${lastError[1].message}`);
}

/** Markdown image reference for `path`, cwd-relative when possible. upstream: qr.rs::markdown_image_for_path */
export function markdownImageForPath(path) {
  let cwd;
  try { cwd = process.cwd(); } catch {}
  return markdownImageForPathIn(path, cwd);
}

/**
 * markdown_image_for_path with `std::env::current_dir()` supplied (undefined = unavailable);
 * `std` selects the path flavour (default: this host's, as upstream is compiled for it).
 */
export function markdownImageForPathIn(path, cwd, std = RUST_PATH) {
  let target;
  if (std.isAbsolute(path)) {
    const rel = cwd === undefined ? null : std.stripPrefix(path, cwd);
    target = rel === null ? path : std.join('.', rel);
  } else {
    target = std.join('.', path);
  }
  return `![QR Code](<${target.replaceAll('>', '%3E')}>)`;
}

/** `onchainos agent user-notify` argv for the PNG at `path`. upstream: qr.rs::notify_command_args_for_path */
export function notifyCommandArgsForPath(path) {
  return ['onchainos', 'agent', 'user-notify', '--content', '<localized content>', '--image-path', path];
}

/** upstream: qr.rs::detect_display_mode */
export function detectDisplayMode() {
  return displayModeFromCodexSession() ?? displayModeFromTty();
}

/** stdout or stderr is a terminal → terminal-unicode. upstream: qr.rs::display_mode_from_tty */
export function displayModeFromTty() {
  return isatty(1) || isatty(2) ? QrDisplayMode.TerminalUnicode : QrDisplayMode.ImageNotify;
}

/** upstream: qr.rs::display_mode_from_codex_session */
export function displayModeFromCodexSession() {
  const raw = process.env.CODEX_THREAD_ID;
  if (raw === undefined) return null;
  const threadId = rustTrim(raw);
  if (!threadId) return null;
  const paths = [];
  for (const root of codexSessionRoots()) paths.push(...findCodexSessionFiles(root, threadId));
  return displayModeFromCodexSessionFiles(paths);
}

/** First session file whose first line yields a mode. upstream: qr.rs::display_mode_from_codex_session_files */
export function displayModeFromCodexSessionFiles(paths) {
  for (const path of paths) {
    const line = readFirstLine(path);
    if (line === null) continue;
    const mode = displayModeFromCodexSessionLine(line);
    if (mode !== null) return mode;
  }
  return null;
}

/** upstream: qr.rs::codex_session_roots */
export function codexSessionRoots() {
  const roots = [];
  const codexHome = process.env.CODEX_HOME;
  if (codexHome) roots.push(rustJoin(codexHome, 'sessions'));
  const h = dirsHomeDir();                                    // dirs::home_dir(), not os.homedir()
  if (h !== null) roots.push(rustJoin(h, '.codex', 'sessions'));
  return roots;
}

/**
 * DFS (stack, ≤ 5000 directories, OS read order) for `*.jsonl` / `*.json` files whose
 * name contains `threadId`. upstream: qr.rs::find_codex_session_files
 */
export function findCodexSessionFiles(root, threadId) {
  const matches = [];
  const stack = [root];
  let visited = 0;
  while (stack.length) {
    const dir = stack.pop();
    visited += 1;
    if (visited > 5000) break;
    let handle;
    try { handle = opendirSync(fsDirPath(dir)); } catch { continue; }
    try {
      for (;;) {
        let entry;
        try { entry = handle.readSync(); } catch { break; }
        if (entry === null) break;
        const path = rustJoin(dir, entry.name);
        if (rustIsDir(path)) { stack.push(path); continue; }
        const name = entry.name;
        if ((name.endsWith('.jsonl') || name.endsWith('.json')) && name.includes(threadId)) matches.push(path);
      }
    } finally {
      try { handle.closeSync(); } catch {}
    }
  }
  return matches;
}

/** First line including its `\n`; null when unreadable or not UTF-8. upstream: qr.rs::read_first_line */
export function readFirstLine(path) {
  let fd;
  try { fd = openSync(fsPath(path), 'r'); } catch { return null; }
  try {
    const chunks = [];
    const buf = Buffer.alloc(8192);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      const nl = buf.subarray(0, n).indexOf(0x0a);
      if (nl >= 0) { chunks.push(Buffer.from(buf.subarray(0, nl + 1))); break; }
      chunks.push(Buffer.from(buf.subarray(0, n)));
    }
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
  } catch {
    return null;
  } finally {
    try { closeSync(fd); } catch {}
  }
}

/** upstream: qr.rs::display_mode_from_codex_session_line */
export function displayModeFromCodexSessionLine(line) {
  let value;
  try { value = serdeParse(line); } catch { return null; }   // serde_json::from_str::<Value>
  let meta = value;
  if (isJsonObject(value)) {
    if (Object.hasOwn(value, 'session_meta')) meta = value.session_meta;
    else if (Object.hasOwn(value, 'payload')) meta = value.payload;
  }
  return displayModeFromCodexMeta(findJsonString(meta, 'originator'), findJsonString(meta, 'source'));
}

/** upstream: qr.rs::display_mode_from_codex_meta */
export function displayModeFromCodexMeta(originator, source) {
  const o = originator == null ? null : normalizeCodexMetaValue(originator);
  const s = source == null ? null : normalizeCodexMetaValue(source);
  if (o === 'codex-tui' || o === 'codex_exec') return QrDisplayMode.TerminalUnicode;
  if (o === 'codex desktop') return QrDisplayMode.ImageNotify;
  if (s === 'cli' || s === 'exec') return QrDisplayMode.TerminalUnicode;
  if (s === 'vscode' || s === 'appserver') return QrDisplayMode.ImageNotify;
  return null;
}

/** `str::trim` + `to_ascii_lowercase`. upstream: qr.rs::normalize_codex_meta_value */
export function normalizeCodexMetaValue(value) {
  return rustTrim(value).replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/**
 * Depth-first search for a string under `key`; objects iterate in serde_json
 * `Map` (BTreeMap) key order. upstream: qr.rs::find_json_string
 */
export function findJsonString(value, key) {
  if (Array.isArray(value)) {
    for (const v of value) { const r = findJsonString(v, key); if (r !== null) return r; }
    return null;
  }
  if (isJsonObject(value)) {
    if (Object.hasOwn(value, key) && typeof value[key] === 'string') return value[key];
    for (const k of Object.keys(value).sort(byUtf8)) { const r = findJsonString(value[k], key); if (r !== null) return r; }
  }
  return null;
}

const isJsonObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const byUtf8 = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

// serde_json::from_str::<Value> acceptance on top of JSON.parse: nesting limit
// (128 → error), lone surrogate escapes and f64-overflowing numbers are errors.


// ---------------------------------------------------------------------------
// Rust std semantics the output strings and file locations depend on:
// str::trim, std::path (a port of library/std/src/path.rs `Components`, used by
// PathBuf::push / Path::parent / Path::strip_prefix / Path::is_absolute, both
// flavours), Win32 path normalisation (GetFullPathNameW), and the fs calls upstream
// makes (create_dir_all, metadata, read_dir, File::open/create) addressed the way
// Win32 addresses them, plus env::temp_dir and dirs::home_dir.
// ---------------------------------------------------------------------------

const WIN = process.platform === 'win32';
const RUST_WS = '\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const RUST_TRIM = new RegExp(`^[${RUST_WS}]+|[${RUST_WS}]+$`, 'g');
/** `str::trim` (Unicode White_Space; unlike String.prototype.trim it keeps U+FEFF and strips U+0085). */
export const rustTrim = (s) => s.replace(RUST_TRIM, '');

// std::path::State, in declaration (PartialOrd) order.
const S_PREFIX = 0, S_START_DIR = 1, S_BODY = 2, S_DONE = 3;

/**
 * std::path for one flavour (`win` true: Windows rules — `\` and `/` separators, prefixes;
 * false: Unix — `/` only). Returns { parsePrefix, components, iter, hasRoot, isAbsolute,
 * stripPrefix, parent, push, join }; components are `{t:'prefix'|'root'|'cur'|'parent'|'normal', …}`.
 * Pinned to Rust std by test/oracle-qr (Windows build + wasm32 build for the unix module).
 */
export function rustPathFor(win) {
  const MAIN_SEP = win ? '\\' : '/';
  const isSepByte = win ? (c) => c === '/' || c === '\\' : (c) => c === '/';          // path::is_sep_byte
  const isVerbatimSep = win ? (c) => c === '\\' : (c) => c === '/';                   // path::is_verbatim_sep
  const nextComponent = (p, verbatim) => {                                            // windows_prefix::parse_next_component
    const sep = verbatim ? isVerbatimSep : isSepByte;
    for (let k = 0; k < p.length; k++) if (sep(p[k])) return [p.slice(0, k), p.slice(k + 1)];
    return [p, ''];
  };
  const parseDrive = (p) => (p.length >= 2 && /^[A-Za-z]$/.test(p[0]) && p[1] === ':' ? p[0].toUpperCase() : null);
  const parseDriveExact = (p) => (p.length <= 2 || isSepByte(p[2]) ? parseDrive(p) : null);
  const mk = (kind, len, a = '', b = '') => ({ kind, len, a, b, verbatim: kind.startsWith('Verbatim'), isDrive: kind === 'Disk' });

  /** windows_prefix::parse_prefix → { kind, len, a, b, verbatim, isDrive } | null. */
  function parsePrefix(s) {
    if (!win) return null;
    const head = s.slice(0, 8).replaceAll('/', '\\');                                 // PrefixParser<8>
    if (head.startsWith('\\\\')) {
      if (head.startsWith('?\\', 2) && !s.slice(0, 4).includes('/')) {
        if (head.startsWith('UNC\\', 4)) {
          const [server, rest] = nextComponent(s.slice(8), true);
          const [share] = nextComponent(rest, true);
          return mk('VerbatimUNC', 8 + server.length + (share.length ? 1 + share.length : 0), server, share);
        }
        const rest = s.slice(4);
        const drive = parseDriveExact(rest);
        if (drive) return mk('VerbatimDisk', 6, drive);
        const [prefix] = nextComponent(rest, true);
        return mk('Verbatim', 4 + prefix.length, prefix);
      }
      if (head.startsWith('.\\', 2)) {
        const [prefix] = nextComponent(s.slice(4), false);
        return mk('DeviceNS', 4 + prefix.length, prefix);
      }
      const [server, rest] = nextComponent(s.slice(2), false);
      const [share] = nextComponent(rest, false);
      return server && share ? mk('UNC', 2 + server.length + 1 + share.length, server, share) : null;
    }
    const drive = parseDrive(s);
    return drive ? mk('Disk', 2, drive) : null;
  }

  /** std::path::Components over s[lo, hi). */
  class Components {
    constructor(s) {
      this.s = s;
      this.lo = 0;
      this.hi = s.length;
      this.prefix = parsePrefix(s);
      const plen = this.prefix ? this.prefix.len : 0;
      this.physRoot = s.length > plen && isSepByte(s[plen]);                          // has_physical_root: non-verbatim test
      this.front = S_PREFIX;
      this.back = S_BODY;
    }
    clone() { return Object.assign(Object.create(Components.prototype), this); }
    prefixLen() { return this.prefix ? this.prefix.len : 0; }
    prefixVerbatim() { return !!(this.prefix && this.prefix.verbatim); }
    prefixRemaining() { return this.front === S_PREFIX ? this.prefixLen() : 0; }
    lenBeforeBody() {
      const early = this.front <= S_START_DIR;
      return this.prefixRemaining() + (early && this.physRoot ? 1 : 0) + (early && this.includeCurDir() ? 1 : 0);
    }
    finished() { return this.front === S_DONE || this.back === S_DONE || this.front > this.back; }
    isSep(c) { return this.prefixVerbatim() ? isVerbatimSep(c) : isSepByte(c); }
    hasRoot() { return this.physRoot || (this.prefix !== null && !this.prefix.isDrive); }
    includeCurDir() {
      if (this.hasRoot()) return false;
      const i = this.lo + this.prefixRemaining();
      if (i >= this.hi || this.s[i] !== '.') return false;
      return i + 1 === this.hi || this.isSep(this.s[i + 1]);
    }
    single(comp) {                                                                    // parse_single_component
      if (comp === '.') return this.prefixVerbatim() ? { t: 'cur' } : null;
      if (comp === '..') return { t: 'parent' };
      return comp === '' ? null : { t: 'normal', v: comp };
    }
    parseNext() {
      let i = this.lo;
      while (i < this.hi && !this.isSep(this.s[i])) i++;
      return [i - this.lo + (i < this.hi ? 1 : 0), this.single(this.s.slice(this.lo, i))];
    }
    parseNextBack() {
      const start = this.lo + this.lenBeforeBody();
      let i = this.hi;
      while (i > start && !this.isSep(this.s[i - 1])) i--;
      return [this.hi - i + (i > start ? 1 : 0), this.single(this.s.slice(i, this.hi))];
    }
    trimLeft() {
      while (this.lo < this.hi) {
        const [size, comp] = this.parseNext();
        if (comp) return;
        this.lo += size;
      }
    }
    trimRight() {
      while (this.hi - this.lo > this.lenBeforeBody()) {
        const [size, comp] = this.parseNextBack();
        if (comp) return;
        this.hi -= size;
      }
    }
    asPath() {
      const c = this.clone();
      if (c.front === S_BODY) c.trimLeft();
      if (c.back === S_BODY) c.trimRight();
      return c.s.slice(c.lo, c.hi);
    }
    next() {
      while (!this.finished()) {
        if (this.front === S_BODY) {
          if (this.lo < this.hi) {
            const [size, comp] = this.parseNext();
            this.lo += size;
            if (comp) return comp;
          } else this.front = S_DONE;
        } else if (this.front === S_START_DIR) {
          this.front = S_BODY;
          if (this.physRoot) { this.lo += 1; return { t: 'root' }; }
          if (this.prefix) { if (!this.prefix.isDrive && !this.prefix.verbatim) return { t: 'root' }; }
          else if (this.includeCurDir()) { this.lo += 1; return { t: 'cur' }; }
        } else {
          this.front = S_START_DIR;
          const n = this.prefixLen();
          if (n > 0) {
            const raw = this.s.slice(this.lo, this.lo + n);
            this.lo += n;
            return { t: 'prefix', p: this.prefix, raw };
          }
        }
      }
      return null;
    }
    nextBack() {
      while (!this.finished()) {
        if (this.back === S_BODY) {
          if (this.hi - this.lo > this.lenBeforeBody()) {
            const [size, comp] = this.parseNextBack();
            this.hi -= size;
            if (comp) return comp;
          } else this.back = S_START_DIR;
        } else if (this.back === S_START_DIR) {
          this.back = S_PREFIX;
          if (this.physRoot) { this.hi -= 1; return { t: 'root' }; }
          if (this.prefix) { if (!this.prefix.isDrive && !this.prefix.verbatim) return { t: 'root' }; }
          else if (this.includeCurDir()) { this.hi -= 1; return { t: 'cur' }; }
        } else {
          this.back = S_DONE;
          if (this.prefixLen() > 0) return { t: 'prefix', p: this.prefix, raw: this.s.slice(this.lo, this.hi) };
          return null;
        }
      }
      return null;
    }
  }

  const same = (x, y) => x.t === y.t && (x.t === 'prefix'
    ? x.p.kind === y.p.kind && x.p.a === y.p.a && x.p.b === y.p.b                     // PrefixComponent: parsed only
    : x.t !== 'normal' || x.v === y.v);
  const text = (c) => (c.t === 'prefix' ? c.raw : c.t === 'root' ? MAIN_SEP : c.t === 'cur' ? '.' : c.t === 'parent' ? '..' : c.v);
  const components = (s) => {
    const it = new Components(s), out = [];
    for (let c = it.next(); c; c = it.next()) out.push(c);
    return out;
  };
  const hasRoot = (s) => new Components(s).hasRoot();
  const isAbsolute = (s) => (win ? hasRoot(s) && parsePrefix(s) !== null : hasRoot(s));

  /** Path::strip_prefix (iter_after + Components::as_path) → string | null. */
  function stripPrefix(path, base) {
    let it = new Components(path);
    const pre = new Components(base);
    for (;;) {
      const nextIt = it.clone();
      const x = nextIt.next(), y = pre.next();
      if (x && y) { if (!same(x, y)) return null; }
      else if (y) return null;
      else return it.asPath();
      it = nextIt;
    }
  }

  /** Path::parent → string | null. */
  function parent(s) {
    const it = new Components(s);
    const last = it.nextBack();
    return last && (last.t === 'normal' || last.t === 'cur' || last.t === 'parent') ? it.asPath() : null;
  }

  /** PathBuf::push (the result string). */
  function push(buf, path) {
    let needSep = buf.length > 0 && !isSepByte(buf[buf.length - 1]);
    const comps = new Components(buf);
    if (comps.prefixLen() > 0 && comps.prefixLen() === buf.length && comps.prefix.isDrive) needSep = false;
    if (isAbsolute(path) || parsePrefix(path) !== null) return path;
    if (comps.prefixVerbatim() && path.length) {                                      // verbatim: . and .. resolved
      const out = components(buf);
      for (const c of components(path)) {
        if (c.t === 'root') { out.length = Math.min(out.length, 1); out.push(c); }
        else if (c.t === 'parent') { if (out.length && out[out.length - 1].t === 'normal') out.pop(); }
        else if (c.t !== 'cur') out.push(c);
      }
      let res = '', sep = false;
      for (const c of out) {
        if (sep && c.t !== 'root') res += MAIN_SEP;
        res += text(c);
        sep = c.t === 'root' ? false : c.t === 'prefix' ? !c.p.isDrive && c.p.len > 0 : true;
      }
      return res;
    }
    if (hasRoot(path)) return buf.slice(0, comps.prefixRemaining()) + path;          // `\x`: keep only the prefix
    return buf + (needSep ? MAIN_SEP : '') + path;
  }
  const join = (base, ...parts) => parts.reduce(push, base);
  const iter = (s) => new Components(s);                                              // Path::components (next / nextBack / asPath)

  return { parsePrefix, components, iter, hasRoot, isAbsolute, stripPrefix, parent, push, join };
}

const RUST_PATH = rustPathFor(WIN);
/** `PathBuf::from(base).join(part)…` (no normalisation; OS main separator). */
export const rustJoin = (base, ...parts) => RUST_PATH.join(base, ...parts);
/** `Path::is_absolute`. */
export const rustIsAbsolute = (s) => RUST_PATH.isAbsolute(s);
/** `Path::strip_prefix(base)` → remaining path string, or null. */
export const rustStripPrefix = (path, base) => RUST_PATH.stripPrefix(path, base);
/** `Path::parent` → string or null. */
export const rustParent = (s) => RUST_PATH.parent(s);

/**
 * Win32 GetFullPathNameW (RtlGetFullPathName_U): make `path` absolute against `cwd`
 * (the process current directory), `/` → `\`, collapse separators, drop `.`/`..`
 * segments, drop a single trailing `.` of inner segments and trailing dots/spaces of
 * the last one. `driveCwd(letter)` gives the per-drive directory (`=X:` variable) for
 * `X:rel` on another drive. Returns null where the API fails (empty / all-space names).
 */
export function win32FullPath(path, cwd, driveCwd = () => undefined) {
  if (/^ *$/.test(path)) return null;
  const sep = (c) => c === '\\' || c === '/';
  const skipUnc = (s) => {                                                            // end of \\server\share (RtlpSkipUNCPrefix)
    let i = 2;
    while (i < s.length && !sep(s[i])) i++;
    if (i < s.length) i++;
    while (i < s.length && !sep(s[i])) i++;
    return i;
  };
  const base = cwd.endsWith('\\') ? cwd : `${cwd}\\`;                                 // the PEB keeps a trailing '\'
  const baseMark = base[1] === ':' ? 3 : skipUnc(base);
  let buf, mark;
  if (sep(path[0]) && sep(path[1])) {
    if ((path[2] === '.' || path[2] === '?') && sep(path[3])) { buf = path; mark = 4; } // \\.\x, \\?\x
    else if ((path[2] === '.' || path[2] === '?') && path.length === 3) return `\\\\${path[2]}\\`;
    else { buf = path; mark = skipUnc(path); }                                        // \\server\share
  } else if (path.length >= 2 && path[1] === ':') {
    if (sep(path[2])) { buf = path; mark = 3; }                                       // X:\x
    else if (base[1] === ':' && base[0].toUpperCase() === path[0].toUpperCase()) {    // X:rel on the current drive
      buf = path.length === 2 ? cwd : base + path.slice(2);
      mark = baseMark;
    } else {
      const d = path[0].toUpperCase();
      const dir = driveCwd(d);
      buf = (dir !== undefined ? `${dir}\\` : `${d}:\\`) + path.slice(2);
      mark = 3;
    }
  } else if (sep(path[0])) {                                                          // \x: root of the current drive
    const root = base[1] === ':' ? base.slice(0, 3) : base.slice(0, baseMark);
    buf = root + path;
    mark = root.length;
  } else { buf = base + path; mark = baseMark; }
  return collapseWin32(buf, mark);
}

// `mark` = end of the root (`X:\`, `\\.\`, `\\server\share`). A final `.`/`..` may eat
// the separator at `mark`; a `..\` pop never goes below the separator after the root.
function collapseWin32(input, mark) {
  const a = input.replaceAll('/', '\\').split('');
  let w = Math.max(1, mark);                                                          // collapse duplicate separators
  for (let r = w; r < a.length; r++) if (a[r] !== '\\' || a[w - 1] !== '\\') a[w++] = a[r];
  a.length = w;
  const floor = a[mark] === '\\' ? mark + 1 : mark;
  let p = mark;
  while (p < a.length) {
    if (a[p] === '.') {
      const c1 = a[p + 1];
      if (c1 === '\\') { a.splice(p, 2); continue; }                                   // .\ segment
      if (c1 === undefined) { if (p > mark) p--; a.length = p; continue; }            // final .
      if (c1 === '.') {
        const c2 = a[p + 2];
        if (c2 === '\\') {                                                            // ..\ segment
          let q = p;
          if (q > floor) { q--; while (q > floor && a[q - 1] !== '\\') q--; }
          a.splice(q, p + 3 - q);
          p = q;
          continue;
        }
        if (c2 === undefined) {                                                       // final ..
          if (p > mark) { p--; while (p > mark && a[p - 1] !== '\\') p--; if (p > mark) p--; }
          a.length = p;
          continue;
        }
      }
    }
    while (p < a.length && a[p] !== '\\') p++;
    if (p < a.length) {
      if (p > mark && a[p - 1] === '.' && a[p - 2] !== '.') a.splice(p - 1, 1);       // "x." segment → "x"
      else p++;
    }
  }
  while (p > 0 && (a[p - 1] === ' ' || a[p - 1] === '.')) p--;                        // trailing dots / spaces
  a.length = p;
  return a.join('');
}

const invalidName = (p) => Object.assign(new Error(`The filename, directory name, or volume label syntax is incorrect: ${p}`), { code: 'EINVALIDNAME' });

/**
 * The Node path addressing the file upstream's fs call reaches for `p`. Unix: `p`.
 * Windows: std hands `\\?\` / `\??\` paths to the NT layer verbatim (an empty, `.`,
 * `..` or `/`-containing component is an invalid name) and every other path through
 * Win32 normalisation; Node's fs would instead path.resolve() every path (keeping
 * trailing dots/spaces, resolving `.`/`..` inside verbatim paths), so hand it the
 * normalised `\\?\` form.
 */
export function fsPath(p) {
  if (!WIN || p.includes('\0')) return p;
  if (p.startsWith('\\\\?\\') || p.startsWith('\\??\\')) {
    const parts = p.slice(4).split('\\');
    // An empty name is rejected before any lookup; `.`, `..` and names containing `/` only
    // when NTFS reaches them — a missing directory before them reports "path not found".
    for (let k = 1; k < parts.length - 1; k++) if (parts[k] === '') throw invalidName(p);
    const firstDir = parts[0].toUpperCase() === 'UNC' ? 3 : 1;
    for (let k = 1; k < parts.length; k++) {
      const c = parts[k];
      if (c !== '.' && c !== '..' && !c.includes('/')) continue;
      for (let j = firstDir; j < k; j++) {
        let isDir = false;
        try { isDir = statSync(`\\\\?\\${parts.slice(0, j + 1).join('\\')}`).isDirectory(); } catch {}
        if (!isDir) throw Object.assign(new Error(`The system cannot find the path specified: ${p}`), { code: 'ENOENT' });
      }
      throw invalidName(p);
    }
    return `\\\\?\\${p.slice(4)}`;
  }
  let cwd;
  try { cwd = process.cwd(); } catch { return p; }
  const full = win32FullPath(p, cwd);
  if (full === null) throw invalidName(p);
  if (/^[A-Za-z]:\\/.test(full)) return `\\\\?\\${full}`;
  if (full.startsWith('\\\\') && !full.startsWith('\\\\.\\') && !full.startsWith('\\\\?\\')) return `\\\\?\\UNC\\${full.slice(2)}`;
  return full;
}
/** read_dir(p) enumerates `p\*`: the directory as Win32 sees it inside that pattern. */
const fsDirPath = (p) => (WIN ? fsPath(rustJoin(p, '*')).replace(/\*$/, '') : p);

const rustExists = (p) => { try { statSync(fsPath(p)); return true; } catch { return false; } };   // Path::exists
const rustIsDir = (p) => { try { return statSync(fsPath(p)).isDirectory(); } catch { return false; } };

// DirBuilder::mkdir → null, or the error (ENOENT ≈ io::ErrorKind::NotFound, EEXIST ≈ AlreadyExists).
const tryMkdir = (p) => { try { mkdirSync(fsPath(p)); return null; } catch (e) { return e; } };
const noParent = (p) => RUST_PATH.components(p).length === 0 || rustParent(p) === null;   // p == "" || p.parent() == None

/**
 * std::fs::create_dir_all as shipped by the toolchain upstream 4.6.3 was built with
 * (rustc 1.95.0, 59807616e): mkdir up the ancestors until one succeeds or already
 * exists as a directory (other errors abort), then create the missing ones top-down.
 */
function rustCreateDirAll(p) {
  if (noParent(p)) return;
  const ancestors = [];
  for (let a = p; a !== null; a = rustParent(a)) ancestors.push(a);                 // Path::ancestors
  let uncreated = 0;
  for (const a of ancestors) {
    if (noParent(a)) break;
    const err = tryMkdir(a);
    if (err === null) break;
    if (err.code === 'ENOENT') { uncreated += 1; continue; }
    if (err.code === 'EEXIST' && rustIsDir(a)) break;
    throw err;
  }
  for (let k = uncreated - 1; k >= 0; k--) {
    const err = tryMkdir(ancestors[k]);
    if (err !== null && (err.code !== 'EEXIST' || !rustIsDir(ancestors[k]))) throw err;
  }
}

// home.rs::ensure_dir_0700 — create when missing (create_dir_all("") is Ok), then on
// Unix chmod 0700 when the mode differs; any failure is an error.
function ensureDir0700(dir) {
  if (!rustExists(dir)) rustCreateDirAll(dir);
  if (!WIN) {
    const mode = statSync(dir).mode & 0o777;
    if (mode !== 0o700) chmodSync(dir, 0o700);
  }
}

/**
 * `std::env::temp_dir()`. Unix: $TMPDIR, else /tmp (macOS: confstr DARWIN_USER_TEMP_DIR).
 * Windows: GetTempPath2W — the first of TMP, TEMP, USERPROFILE that is set (even if
 * empty), normalised like GetFullPathNameW, with a trailing `\`; a value longer than
 * MAX_PATH moves on to the next one; the Windows directory last. A set but blank value
 * makes the API return a one-character junk path (observed "\0"), reproduced as "\0".
 */
export function rustTempDir() {
  const env = process.env;
  if (!WIN) {
    if (env.TMPDIR !== undefined) return env.TMPDIR;
    if (process.platform === 'darwin') return darwinUserTempDir() ?? '/tmp';
    return process.platform === 'android' ? '/data/local/tmp' : '/tmp';
  }
  let cwd = 'C:\\';
  try { cwd = process.cwd(); } catch {}
  for (const name of ['TMP', 'TEMP', 'USERPROFILE']) {
    const value = env[name];
    if (value === undefined) continue;
    const full = win32FullPath(value, cwd);
    if (full === null) return '\0';
    const dir = full.endsWith('\\') ? full : `${full}\\`;
    if (dir.length <= 261) return dir;                                                // MAX_PATH + 1
  }
  const windows = env.SystemRoot ?? env.windir ?? 'C:\\Windows';
  return windows.endsWith('\\') ? windows : `${windows}\\`;
}

let darwinTemp;
function darwinUserTempDir() {
  if (darwinTemp === undefined) {
    try { darwinTemp = execFileSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).replace(/\n$/, '') || null; }
    catch { darwinTemp = null; }
  }
  return darwinTemp;
}

/**
 * `dirs::home_dir()` (dirs 6): Windows — the profile Known Folder (the token's profile
 * directory; %USERPROFILE% is not consulted); Unix — $HOME when non-empty, else the
 * passwd entry's home directory (when non-empty).
 */
export function dirsHomeDir() {
  if (!WIN) {
    const h = process.env.HOME;
    if (h) return h;
  }
  try { return userInfo().homedir || null; } catch { return null; }
}
