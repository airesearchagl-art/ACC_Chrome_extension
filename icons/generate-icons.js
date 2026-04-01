/**
 * アイコン生成スクリプト
 *
 * 使い方:
 *   npm install sharp
 *   node icons/generate-icons.js
 *
 * または、icon.svg を以下のツールで PNG 変換:
 *   - Inkscape: inkscape --export-type=png --export-width=128 icon.svg
 *   - ImageMagick: convert -size 128x128 icon.svg icon128.png
 *   - オンラインツール: https://svgtopng.com/
 */
import sharp from 'sharp';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const svgBuffer = readFileSync(join(__dirname, 'icon.svg'));

const sizes = [16, 48, 128];
await Promise.all(
  sizes.map(size =>
    sharp(svgBuffer)
      .resize(size, size)
      .png()
      .toFile(join(__dirname, `icon${size}.png`))
      .then(() => console.log(`Generated icon${size}.png`))
  )
);
