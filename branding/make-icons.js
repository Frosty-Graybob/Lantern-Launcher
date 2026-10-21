// Regenerates every icon from the vector artwork in this folder, so they can never drift apart:
//
//   branding/game-launcher-icon-2048.png          the logo, rounded, transparent corners (for branding)
//   branding/game-launcher-icon-square-2048.png   full-bleed square, no transparency (for avatars/stores that add their own mask)
//   client/assets/icon.ico, client/renderer/icon.png            the launcher
//   server/app/assets/icon.ico, server/app/assets/icon.png      the server app
//
// Only needed if you change the artwork (edit the .svg files). It needs the `sharp` image
// library, which isn't a dependency of the apps:   npm i --no-save sharp && node branding/make-icons.js
const fs = require("fs");
const path = require("path");

let sharp;
try {
  sharp = require("sharp");
} catch {
  console.error("This needs the 'sharp' package:  npm i --no-save sharp");
  process.exit(1);
}

const here = __dirname;
const root = path.join(here, "..");
const read = (name) => fs.readFileSync(path.join(here, name), "utf8");
const svgFull = read("icon.svg");
const svgSmall = read("icon-small.svg"); // bolder, with the fine detail left out, so it stays legible at 16-32 px
const svgSquare = read("icon-square.svg");

// Rasterise the vector at exactly the size wanted (rather than shrinking a bigger bitmap), so edges stay crisp.
const render = (svg, size) =>
  sharp(Buffer.from(svg.replace(/width="512" height="512"/, `width="${size}" height="${size}"`)));
const png = (svg, size) => render(svg, size).png({ compressionLevel: 9 }).toBuffer();

// One image of an .ico in the classic layout (a 32-bit bitmap plus a 1-bit transparency mask), which every
// version of Windows and every tool (installers, resource editors) understands.
async function bmpEntry(svg, size) {
  const { data } = await render(svg, size).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); // straight RGBA
  const xor = Buffer.alloc(size * size * 4);
  const maskRow = ((size + 31) >> 5) << 2; // bytes per mask row (padded to 32 bits)
  const and = Buffer.alloc(maskRow * size);
  for (let y = 0; y < size; y++) {
    const dstY = size - 1 - y; // bitmaps are stored bottom-up
    for (let x = 0; x < size; x++) {
      const s = (y * size + x) * 4;
      const d = (dstY * size + x) * 4;
      xor[d] = data[s + 2]; // B
      xor[d + 1] = data[s + 1]; // G
      xor[d + 2] = data[s]; // R
      xor[d + 3] = data[s + 3]; // A
      if (data[s + 3] < 128) and[dstY * maskRow + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // header size
  header.writeInt32LE(size, 4); // width
  header.writeInt32LE(size * 2, 8); // height: the image and its mask, so twice
  header.writeUInt16LE(1, 12); // planes
  header.writeUInt16LE(32, 14); // bits per pixel
  header.writeUInt32LE(0, 16); // no compression
  header.writeUInt32LE(xor.length, 20);
  return Buffer.concat([header, xor, and]);
}

// Small sizes use the bold artwork; from 40 px up there's room for the full detail.
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

async function buildIco() {
  const images = [];
  for (const size of ICO_SIZES) {
    const svg = size <= 32 ? svgSmall : svgFull;
    // 256 px is stored as PNG (what Windows expects there); everything smaller as a classic bitmap.
    images.push({ size, data: size === 256 ? await png(svg, 256) : await bmpEntry(svg, size) });
  }
  const head = Buffer.alloc(6);
  head.writeUInt16LE(1, 2); // type: icon
  head.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, data }) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  return Buffer.concat([head, ...entries, ...images.map((i) => i.data)]);
}

const write = (rel, data) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
};

(async () => {
  const ico = await buildIco();
  write("client/assets/icon.ico", ico);
  write("server/app/assets/icon.ico", ico);
  write("client/renderer/icon.png", await png(svgFull, 128)); // the logo in the launcher's header
  write("server/app/assets/icon.png", await png(svgFull, 256)); // ...and in the server app's
  write("branding/game-launcher-icon-2048.png", await png(svgFull, 2048));
  write("branding/game-launcher-icon-square-2048.png", await png(svgSquare, 2048));
  console.log("icons written");
})();
