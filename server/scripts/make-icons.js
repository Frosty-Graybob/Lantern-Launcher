// Regenerates the app's icons: build/icon.ico (the installer and the .exe),
// app/assets/icon.png (the window) and app/assets/tray.png (the system tray).
// Only needed if you want to change the artwork. It needs the `sharp` image
// library, which isn't a dependency of the app:   npm i --no-save sharp && node scripts/make-icons.js
const fs = require("fs");
const path = require("path");

let sharp;
try {
  sharp = require("sharp");
} catch {
  console.error("This needs the 'sharp' package:  npm i --no-save sharp");
  process.exit(1);
}

const root = path.join(__dirname, "..");
const svg = `<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5b8cff"/><stop offset="1" stop-color="#8b6dff"/></linearGradient></defs>
  <rect x="16" y="16" width="480" height="480" rx="112" fill="url(#g)"/>
  <rect x="104" y="124" width="304" height="124" rx="30" fill="#ffffff"/>
  <rect x="104" y="264" width="304" height="124" rx="30" fill="#ffffff" fill-opacity="0.9"/>
  <circle cx="162" cy="186" r="16" fill="#6a7cff"/>
  <circle cx="162" cy="326" r="16" fill="#6a7cff"/>
  <rect x="214" y="176" width="140" height="20" rx="10" fill="#6a7cff" fill-opacity="0.4"/>
  <rect x="214" y="316" width="140" height="20" rx="10" fill="#6a7cff" fill-opacity="0.4"/>
</svg>`;

const png = (size) => sharp(Buffer.from(svg)).resize(size, size).png().toBuffer();

// An .ico is a small header plus one image per size; modern Windows accepts PNG data inside it.
function packIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, data }) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // width (0 means 256)
    e.writeUInt8(size >= 256 ? 0 : size, 1); // height
    e.writeUInt8(0, 2); // palette size
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

(async () => {
  fs.mkdirSync(path.join(root, "build"), { recursive: true });
  fs.mkdirSync(path.join(root, "app", "assets"), { recursive: true });
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = [];
  for (const size of sizes) images.push({ size, data: await png(size) });
  fs.writeFileSync(path.join(root, "build", "icon.ico"), packIco(images));
  fs.writeFileSync(path.join(root, "app", "assets", "icon.png"), await png(512));
  fs.writeFileSync(path.join(root, "app", "assets", "tray.png"), await png(32));
  console.log("icons written");
})();
