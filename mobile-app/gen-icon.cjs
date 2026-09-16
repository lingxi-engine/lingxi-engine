/**
 * 生成灵犀 App 启动图标 PNG（各密度）——纯 Node，零依赖（zlib 手写 PNG 编码器）
 * 用法: node gen-icon.cjs <输出目录>
 */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

function crc32(buf) {
  let c, table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let x = n; for (let k = 0; k < 8; k++) x = x & 1 ? 0xEDB88320 ^ (x >>> 1) : x >>> 1; t[n] = x >>> 0; }
    return t;
  })());
  c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(size, pixels /* Uint8Array size*size*4 RGBA */) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // bit depth 8, color type RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter none
    pixels.subarray(y * size * 4, (y + 1) * size * 4).forEach((b, i) => raw[y * (size * 4 + 1) + 1 + i] = b);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 画一个圆角深色底 + 紫色四角星 + 蓝色小星
function draw(size) {
  const px = new Uint8Array(size * size * 4);
  const bg = [15, 17, 21];
  const pur = [124, 92, 255];
  const blu = [56, 189, 248];
  const cx = size / 2, cy = size / 2;
  const R = size * 0.5;           // 大星外接半径
  const r = size * 0.14;          // 大星内半径
  // 四角星（上下左右四个尖）
  function starDist(x, y, ox, oy, outer, inner) {
    const dx = x - ox, dy = y - oy;
    const ang = Math.atan2(dy, dx);
    const a = ((ang % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
    const t = a / (Math.PI / 2);
    const rr = outer * (1 - t) + inner * t; // 简化：尖在 0/90/180/270 度
    return Math.hypot(dx, dy) <= rr;
  }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4;
    let c = bg;
    if (starDist(x, y, cx, cy * 1.02, R * 0.72, r)) c = pur;
    else if (starDist(x, y, cx + size * 0.18, cy - size * 0.18, R * 0.22, size * 0.03)) c = blu;
    px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
  }
  return px;
}

const outRoot = process.argv[2];
const sizes = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
for (const [dpi, sz] of Object.entries(sizes)) {
  const dir = path.join(outRoot, 'app', 'src', 'main', 'res', 'mipmap-' + dpi);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ic_launcher.png'), encodePNG(sz, draw(sz)));
  console.log(`OK mipmap-${dpi}/ic_launcher.png ${sz}x${sz}`);
}
console.log('ICON_GEN_DONE');
