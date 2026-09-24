import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const content = Buffer.concat([Buffer.from(type), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(content));
  return Buffer.concat([length, content, checksum]);
}
function icon(size) {
  const pixels = Buffer.alloc((size * 4 + 1) * size);
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      const horizontal =
        row > size * 0.42 && row < size * 0.58 && column > size * 0.24 && column < size * 0.76;
      const vertical =
        column > size * 0.42 && column < size * 0.58 && row > size * 0.24 && row < size * 0.76;
      const color = horizontal || vertical ? [255, 255, 255] : [8, 127, 114];
      const offset = row * (size * 4 + 1) + column * 4 + 1;
      pixels.set([...color, 255], offset);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
mkdirSync('apps/web/public', { recursive: true });
for (const size of [192, 512]) writeFileSync(`apps/web/public/icon-${size}.png`, icon(size));
