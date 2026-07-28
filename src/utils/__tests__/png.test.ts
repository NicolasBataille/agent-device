import { test } from 'vitest';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { PNG } from '../png.ts';

test('PNG sync reader decodes filtered RGB image data', () => {
  const png = PNG.sync.read(
    encodeTestPng({
      width: 2,
      height: 1,
      bitDepth: 8,
      colorType: 2,
      rawScanlines: Buffer.from([1, 10, 20, 30, 40, 60, 100]),
    }),
  );

  assert.equal(png.width, 2);
  assert.equal(png.height, 1);
  assert.deepEqual(readPngPixel(png, 0, 0), [10, 20, 30, 255]);
  assert.deepEqual(readPngPixel(png, 1, 0), [50, 80, 130, 255]);
});

test('PNG sync reader decodes RGBA alpha', () => {
  const png = PNG.sync.read(
    encodeTestPng({
      width: 1,
      height: 1,
      bitDepth: 8,
      colorType: 6,
      rawScanlines: Buffer.from([0, 10, 20, 30, 40]),
    }),
  );

  assert.deepEqual(readPngPixel(png, 0, 0), [10, 20, 30, 40]);
});

test('PNG sync reader applies grayscale transparency', () => {
  const png = PNG.sync.read(
    encodeTestPng({
      width: 2,
      height: 1,
      bitDepth: 8,
      colorType: 0,
      transparency: Buffer.from([0, 5]),
      rawScanlines: Buffer.from([0, 5, 9]),
    }),
  );

  assert.deepEqual(readPngPixel(png, 0, 0), [5, 5, 5, 0]);
  assert.deepEqual(readPngPixel(png, 1, 0), [9, 9, 9, 255]);
});

test('PNG sync reader applies RGB transparency', () => {
  const png = PNG.sync.read(
    encodeTestPng({
      width: 2,
      height: 1,
      bitDepth: 8,
      colorType: 2,
      transparency: Buffer.from([0, 10, 0, 20, 0, 30]),
      rawScanlines: Buffer.from([0, 10, 20, 30, 1, 2, 3]),
    }),
  );

  assert.deepEqual(readPngPixel(png, 0, 0), [10, 20, 30, 0]);
  assert.deepEqual(readPngPixel(png, 1, 0), [1, 2, 3, 255]);
});

test('PNG sync reader rejects indexed/palette color', () => {
  const bytes = encodeTestPng({
    width: 4,
    height: 1,
    bitDepth: 2,
    colorType: 3,
    palette: Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 20, 30, 40]),
    rawScanlines: Buffer.from([0, 0b00011011]),
  });

  assert.throws(() => PNG.sync.read(bytes), /Indexed\/palette PNG not supported/);
});

test('PNG sync reader rejects bit depths below 8', () => {
  const bytes = encodeTestPng({
    width: 2,
    height: 1,
    bitDepth: 4,
    colorType: 0,
    rawScanlines: Buffer.from([0, 0x25]),
  });

  assert.throws(() => PNG.sync.read(bytes), /PNG bit depth 4 not supported/);
});

test('PNG sync reader rejects interlaced images', () => {
  const bytes = encodeTestPng({
    width: 3,
    height: 3,
    bitDepth: 8,
    colorType: 2,
    interlace: 1,
    rawScanlines: Buffer.from([
      0,
      ...rgb(0, 0),
      0,
      ...rgb(2, 0),
      0,
      ...rgb(0, 2),
      ...rgb(2, 2),
      0,
      ...rgb(1, 0),
      0,
      ...rgb(1, 2),
      0,
      ...rgb(0, 1),
      ...rgb(1, 1),
      ...rgb(2, 1),
    ]),
  });

  assert.throws(() => PNG.sync.read(bytes), /Interlaced PNG not supported/);
});

test('PNG sync reader rejects invalid chunk CRCs', () => {
  const bytes = encodeTestPng({
    width: 1,
    height: 1,
    bitDepth: 8,
    colorType: 2,
    rawScanlines: Buffer.from([0, ...rgb(0, 0)]),
  });
  const lastByte = bytes.length - 1;
  bytes[lastByte] = (bytes[lastByte] ?? 0) ^ 0xff;

  assert.throws(() => PNG.sync.read(bytes), /Invalid PNG .* chunk CRC/);
});

test('PNG sync reader rejects inflated data larger than IHDR scanlines', () => {
  const bytes = encodeTestPng({
    width: 1,
    height: 1,
    bitDepth: 8,
    colorType: 6,
    rawScanlines: Buffer.from([0, 1, 2, 3, 4, 5]),
  });

  assert.throws(() => PNG.sync.read(bytes), /PNG pixel data exceeds expected length 5/);
});

function readPngPixel(png: PNG, x: number, y: number): number[] {
  const offset = (y * png.width + x) * 4;
  return [
    png.data[offset] ?? 0,
    png.data[offset + 1] ?? 0,
    png.data[offset + 2] ?? 0,
    png.data[offset + 3] ?? 0,
  ];
}

function encodeTestPng(params: {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  rawScanlines: Buffer;
  interlace?: 0 | 1;
  palette?: Buffer;
  transparency?: Buffer;
}): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(params.width, 0);
  ihdr.writeUInt32BE(params.height, 4);
  ihdr[8] = params.bitDepth;
  ihdr[9] = params.colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = params.interlace ?? 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    encodeTestChunk('IHDR', ihdr),
    ...(params.palette ? [encodeTestChunk('PLTE', params.palette)] : []),
    ...(params.transparency ? [encodeTestChunk('tRNS', params.transparency)] : []),
    encodeTestChunk('IDAT', deflateSync(params.rawScanlines)),
    encodeTestChunk('IEND', Buffer.alloc(0)),
  ]);
}

function rgb(x: number, y: number): [number, number, number] {
  return [x * 40 + 10, y * 50 + 20, x * 30 + y * 20 + 30];
}

function encodeTestChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(8 + data.length + 4);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return chunk;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
