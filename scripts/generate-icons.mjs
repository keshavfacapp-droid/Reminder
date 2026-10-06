// Regenerates the PWA icons in frontend/public/icons from an inline SVG.
// Usage: node scripts/generate-icons.mjs   (requires `npm install` first; uses sharp)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, 'frontend', 'public', 'icons');
fs.mkdirSync(out, { recursive: true });

// A plain, generic bell — deliberately nothing that hints at messaging.
const bell = (scale) => `
  <g transform="translate(256 256) scale(${scale}) translate(-256 -256)" fill="none" stroke="#e8e6e1" stroke-width="28" stroke-linecap="round" stroke-linejoin="round">
    <path d="M160 330 V230 a96 96 0 0 1 192 0 V330 l28 36 H132 Z"/>
    <path d="M226 404 a32 32 0 0 0 60 0"/>
  </g>`;

const svg = (radius, scale) => `
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="${radius}" fill="#14161a"/>
  ${bell(scale)}
</svg>`;

const targets = [
  ['icon-192.png', 192, svg(112, 1)],
  ['icon-512.png', 512, svg(112, 1)],
  ['maskable-512.png', 512, svg(0, 0.72)],
  ['apple-touch-icon.png', 180, svg(0, 0.9)],
];
for (const [name, size, source] of targets) {
  await sharp(Buffer.from(source)).resize(size, size).png().toFile(path.join(out, name));
  console.log('wrote', name);
}
