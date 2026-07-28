import { deflateSync, inflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type PngColorType = 0 | 2 | 4 | 6;

const COLOR_CHANNELS: ReadonlyMap<PngColorType, number> = new Map([
  [0, 1],
  [2, 3],
  [4, 2],
  [6, 4],
] as const);

type PngMetadata = {
  width: number;
  height: number;
  colorType: PngColorType;
  interlace: 0 | 1;
  transparency?: Buffer;
};

type PngChunk = {
  type: string;
  data: Buffer;
};

export class PNG {
  width: number;
  height: number;
  data: Buffer;

  static sync = {
    read: readPng,
    write: writePng,
  };

  constructor(options: { width: number; height: number; data?: Buffer }) {
    this.width = validateDimension(options.width, 'width');
    this.height = validateDimension(options.height, 'height');
    const byteLength = this.width * this.height * 4;
    this.data = options.data ? Buffer.from(options.data) : Buffer.alloc(byteLength);
    if (this.data.length !== byteLength) {
      throw new Error(`PNG data length must be ${byteLength} bytes`);
    }
  }
}

function readPng(buffer: Buffer): PNG {
  const { metadata, idatChunks } = collectPngChunks(buffer);
  if (!metadata) throw new Error('PNG is missing IHDR');
  if (idatChunks.length === 0) throw new Error('PNG is missing IDAT');
  if (metadata.interlace === 1) throw new Error('Interlaced PNG not supported');
  const inflated = inflatePngData(idatChunks, metadata);
  return new PNG({
    width: metadata.width,
    height: metadata.height,
    data: decodePixels(unfilterPng(inflated, metadata), metadata),
  });
}

function collectPngChunks(buffer: Buffer): { metadata?: PngMetadata; idatChunks: Buffer[] } {
  let metadata: PngMetadata | undefined;
  const idatChunks: Buffer[] = [];

  for (const chunk of iteratePngChunks(buffer)) {
    if (chunk.type === 'IHDR') metadata = parseIhdr(chunk.data);
    else if (chunk.type === 'IDAT') idatChunks.push(Buffer.from(chunk.data));
    else if (chunk.type === 'tRNS') {
      if (!metadata) throw new Error('PNG tRNS appeared before IHDR');
      metadata.transparency = Buffer.from(chunk.data);
    }
    if (chunk.type === 'IEND') break;
  }

  return { metadata, idatChunks };
}

function* iteratePngChunks(buffer: Buffer): Generator<PngChunk> {
  if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error('Invalid PNG signature');
  }

  let offset = PNG_SIGNATURE.length;
  while (offset < buffer.length) {
    if (offset + 12 > buffer.length) throw new Error('Truncated PNG chunk');
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) throw new Error(`Truncated PNG ${type} chunk`);
    const data = buffer.subarray(dataStart, dataEnd);
    const expectedCrc = buffer.readUInt32BE(dataEnd);
    const actualCrc = crc32(buffer.subarray(offset + 4, dataEnd));
    if (actualCrc !== expectedCrc) throw new Error(`Invalid PNG ${type} chunk CRC`);
    offset = dataEnd + 4;
    yield { type, data };
  }
}

function inflatePngData(idatChunks: Buffer[], metadata: PngMetadata): Buffer {
  const expectedLength = inflatedByteLength(metadata);
  try {
    const inflated = inflateSync(Buffer.concat(idatChunks), { maxOutputLength: expectedLength });
    if (inflated.length !== expectedLength) throw new Error('PNG pixel data is truncated');
    return inflated;
  } catch (error) {
    if (isZlibOutputLimitError(error)) {
      throw new Error(`PNG pixel data exceeds expected length ${expectedLength}`);
    }
    throw error;
  }
}

function writePng(png: PNG): Buffer {
  const scanlineLength = png.width * 4;
  const raw = Buffer.alloc((scanlineLength + 1) * png.height);
  for (let y = 0; y < png.height; y += 1) {
    const rawOffset = y * (scanlineLength + 1);
    raw[rawOffset] = 0;
    png.data.copy(raw, rawOffset + 1, y * scanlineLength, (y + 1) * scanlineLength);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(png.width, 0);
  ihdr.writeUInt32BE(png.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    PNG_SIGNATURE,
    encodeChunk('IHDR', ihdr),
    encodeChunk('IDAT', deflateSync(raw)),
    encodeChunk('IEND', Buffer.alloc(0)),
  ]);
}

function parseIhdr(data: Buffer): PngMetadata {
  if (data.length !== 13) throw new Error('Invalid PNG IHDR length');
  const width = data.readUInt32BE(0);
  const height = data.readUInt32BE(4);
  const bitDepth = data[8]!;
  const colorType = data[9]!;
  const compression = data[10]!;
  const filter = data[11]!;
  const interlace = data[12]!;
  if (colorType === 3) throw new Error('Indexed/palette PNG not supported');
  if (!isPngColorType(colorType)) throw new Error(`Unsupported PNG color type ${colorType}`);
  if (bitDepth !== 8) throw new Error(`PNG bit depth ${bitDepth} not supported`);
  if (compression !== 0) throw new Error(`Unsupported PNG compression method ${compression}`);
  if (filter !== 0) throw new Error(`Unsupported PNG filter method ${filter}`);
  if (interlace !== 0 && interlace !== 1)
    throw new Error(`Unsupported PNG interlace method ${interlace}`);
  return {
    width: validateDimension(width, 'width'),
    height: validateDimension(height, 'height'),
    colorType,
    interlace,
  };
}

function isPngColorType(value: number): value is PngColorType {
  return COLOR_CHANNELS.has(value as PngColorType);
}

function unfilterPng(inflated: Buffer, metadata: PngMetadata): Buffer {
  const scanlineLength = scanlineByteLength(metadata);
  const result = unfilterScanlines({
    inflated,
    offset: 0,
    scanlineLength,
    height: metadata.height,
    bytesPerPixel: filterBytesPerPixel(metadata),
  });
  return result.raw;
}

function unfilterScanlines(params: {
  inflated: Buffer;
  offset: number;
  scanlineLength: number;
  height: number;
  bytesPerPixel: number;
}): { raw: Buffer; offset: number } {
  const { inflated, offset, scanlineLength, height, bytesPerPixel } = params;
  const expectedLength = (scanlineLength + 1) * height;
  const endOffset = offset + expectedLength;
  if (inflated.length < endOffset) throw new Error('PNG pixel data is truncated');

  const output = Buffer.alloc(scanlineLength * height);
  for (let y = 0; y < height; y += 1) {
    const sourceOffset = offset + y * (scanlineLength + 1);
    const targetOffset = y * scanlineLength;
    const filter = inflated[sourceOffset]!;
    for (let x = 0; x < scanlineLength; x += 1) {
      const value = inflated[sourceOffset + 1 + x]!;
      const left = x >= bytesPerPixel ? output[targetOffset + x - bytesPerPixel]! : 0;
      const up = y > 0 ? output[targetOffset + x - scanlineLength]! : 0;
      const upLeft =
        y > 0 && x >= bytesPerPixel
          ? output[targetOffset + x - scanlineLength - bytesPerPixel]!
          : 0;
      output[targetOffset + x] = unfilterByte(filter, value, left, up, upLeft);
    }
  }
  return { raw: output, offset: endOffset };
}

function unfilterByte(
  filter: number,
  value: number,
  left: number,
  up: number,
  upLeft: number,
): number {
  if (filter === 0) return value;
  if (filter === 1) return (value + left) & 0xff;
  if (filter === 2) return (value + up) & 0xff;
  if (filter === 3) return (value + Math.floor((left + up) / 2)) & 0xff;
  if (filter === 4) return (value + paeth(left, up, upLeft)) & 0xff;
  throw new Error(`Unsupported PNG filter type ${filter}`);
}

function decodePixels(raw: Buffer, metadata: PngMetadata): Buffer {
  const output = Buffer.alloc(metadata.width * metadata.height * 4);
  const scanlineLength = scanlineByteLength(metadata);
  for (let y = 0; y < metadata.height; y += 1) {
    const line = raw.subarray(y * scanlineLength, (y + 1) * scanlineLength);
    for (let x = 0; x < metadata.width; x += 1) {
      const target = (y * metadata.width + x) * 4;
      const [red, green, blue, alpha] = readPixel(line, x, metadata);
      output[target] = red;
      output[target + 1] = green;
      output[target + 2] = blue;
      output[target + 3] = alpha;
    }
  }
  return output;
}

function inflatedByteLength(metadata: PngMetadata): number {
  return (scanlineByteLength(metadata) + 1) * metadata.height;
}

function readPixel(
  line: Buffer,
  x: number,
  metadata: PngMetadata,
): [number, number, number, number] {
  const channels = COLOR_CHANNELS.get(metadata.colorType)!;
  const offset = x * channels;
  const sample = (channel: number): number => line[offset + channel]!;

  if (metadata.colorType === 0) {
    const gray = sample(0);
    const transparent = matchesTransparentGray(sample(0), metadata);
    return [gray, gray, gray, transparent ? 0 : 255];
  }
  if (metadata.colorType === 2) {
    const red = sample(0);
    const green = sample(1);
    const blue = sample(2);
    const transparent = matchesTransparentRgb(sample(0), sample(1), sample(2), metadata);
    return [red, green, blue, transparent ? 0 : 255];
  }
  if (metadata.colorType === 4) {
    const gray = sample(0);
    return [gray, gray, gray, sample(1)];
  }
  return [sample(0), sample(1), sample(2), sample(3)];
}

function scanlineByteLength(metadata: PngMetadata): number {
  return metadata.width * COLOR_CHANNELS.get(metadata.colorType)!;
}

function filterBytesPerPixel(metadata: PngMetadata): number {
  return COLOR_CHANNELS.get(metadata.colorType)!;
}

function matchesTransparentGray(sample: number, metadata: PngMetadata): boolean {
  if (!metadata.transparency || metadata.transparency.length < 2) return false;
  return sample === metadata.transparency.readUInt16BE(0);
}

function matchesTransparentRgb(
  red: number,
  green: number,
  blue: number,
  metadata: PngMetadata,
): boolean {
  if (!metadata.transparency || metadata.transparency.length < 6) return false;
  return (
    red === metadata.transparency.readUInt16BE(0) &&
    green === metadata.transparency.readUInt16BE(2) &&
    blue === metadata.transparency.readUInt16BE(4)
  );
}

function encodeChunk(type: string, data: Buffer): Buffer {
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

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upLeftDistance = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left;
  return upDistance <= upLeftDistance ? up : upLeft;
}

function validateDimension(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`PNG ${label} must be positive`);
  return value;
}

function isZlibOutputLimitError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ERR_BUFFER_TOO_LARGE';
}
