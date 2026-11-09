import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

const AMBER = [224, 164, 74];
const INK = [32, 29, 23];

const crcTable = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const name = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([length, name, data, crc]);
}

function encodePng(size, pixelAt) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const raw = Buffer.alloc((size * 4 + 1) * size);
  let offset = 0;
  for (let y = 0; y < size; y += 1) {
    raw[offset] = 0;
    offset += 1;
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = pixelAt(x, y);
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = a;
      offset += 4;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function roundedCoverage(x, y, size, radius) {
  const centerX = Math.min(Math.max(x + 0.5, radius), size - radius);
  const centerY = Math.min(Math.max(y + 0.5, radius), size - radius);
  const dx = x + 0.5 - centerX;
  const dy = y + 0.5 - centerY;
  const distance = Math.hypot(dx, dy);
  return Math.min(Math.max(radius - distance + 0.5, 0), 1);
}

function makeIcon(size) {
  const radius = size * 0.22;
  const stroke = Math.max(1, size * 0.065);
  const left = size * 0.25;
  const right = size * 0.75;
  const top = size * 0.28;
  const bottom = size * 0.74;
  const barY = top + size * 0.12;

  return encodePng(size, (x, y) => {
    const coverage = roundedCoverage(x, y, size, radius);
    if (coverage <= 0) return [0, 0, 0, 0];

    const px = x + 0.5;
    const py = y + 0.5;
    const inWindow = px >= left && px <= right && py >= top && py <= bottom;
    const onFrame =
      inWindow &&
      (px <= left + stroke || px >= right - stroke || py <= top + stroke || py >= bottom - stroke);
    const onBar = inWindow && py >= barY && py <= barY + stroke;

    const color = onFrame || onBar ? INK : AMBER;
    return [color[0], color[1], color[2], Math.round(coverage * 255)];
  });
}

mkdirSync("src/icons", { recursive: true });
for (const size of [16, 48, 128]) {
  writeFileSync(`src/icons/icon-${size}.png`, makeIcon(size));
}
console.log("icons written");
