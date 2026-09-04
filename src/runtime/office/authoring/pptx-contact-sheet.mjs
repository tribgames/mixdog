// One labeled grid of every rendered slide, written beside the deck after an
// author call. The per-page renders are for inspecting a slide; the sheet is
// for reading the deck as a sequence — density rhythm, repeated compositions,
// where the titles sit, which slides change the background — in one look.
// (The practice comes from the thumbnail grids reference skills use to read a
// template deck before choosing layouts.)
import { writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';

function pageImages(images = []) {
  const pages = [];
  for (const image of images) {
    if (Array.isArray(image?.pageImages) && image.pageImages.length) pages.push(...image.pageImages);
    else if (image?.data && Number(image.page) > 0) pages.push(image);
  }
  return pages.filter((page) => page?.data).sort((a, b) => Number(a.page) - Number(b.page));
}

export async function writeContactSheet(images, output, { width = 1600 } = {}) {
  const pages = pageImages(images);
  if (pages.length < 2) return null;
  const columns = pages.length <= 4 ? 2 : pages.length <= 9 ? 3 : 4;
  const gap = 14;
  const label = 22;
  const cellW = Math.floor((width - gap * (columns + 1)) / columns);
  const loaded = [];
  for (const page of pages) {
    const image = await loadImage(Buffer.from(page.data, 'base64'));
    loaded.push({ page: Number(page.page), image, height: Math.round(image.height * cellW / image.width) });
  }
  const cellH = Math.max(...loaded.map((entry) => entry.height));
  const rows = Math.ceil(loaded.length / columns);
  const sheet = createCanvas(width, gap + rows * (label + cellH + gap));
  const ctx = sheet.getContext('2d');
  ctx.fillStyle = 'rgb(236,238,242)';
  ctx.fillRect(0, 0, sheet.width, sheet.height);
  ctx.font = '15px sans-serif';
  ctx.textBaseline = 'middle';
  loaded.forEach((entry, index) => {
    const x = gap + (index % columns) * (cellW + gap);
    const y = gap + Math.floor(index / columns) * (label + cellH + gap);
    ctx.fillStyle = 'rgb(60,64,72)';
    ctx.fillText(String(entry.page), x, y + label / 2);
    ctx.drawImage(entry.image, x, y + label, cellW, entry.height);
    ctx.strokeStyle = 'rgb(190,194,202)';
    ctx.strokeRect(x + 0.5, y + label + 0.5, cellW - 1, entry.height - 1);
  });
  const data = sheet.toBuffer('image/png');
  const stem = basename(output, extname(output));
  const path = join(dirname(output), `${stem}.mixdog-contact.png`);
  await writeFile(path, data);
  return { path, width: sheet.width, height: sheet.height, pages: loaded.map((entry) => entry.page), mimeType: 'image/png', data: data.toString('base64') };
}
