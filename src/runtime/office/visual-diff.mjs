import { writeFile } from 'node:fs/promises';
import { dirname, extname, basename, join } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';

function imageByPage(images) {
  return new Map((images || []).map((image) => [Number(image.page), image]));
}

export async function compareRenderedPages(beforeImages, afterImages, outputPdf) {
  const before = imageByPage(beforeImages);
  const after = imageByPage(afterImages);
  const pages = [...new Set([...before.keys(), ...after.keys()])].sort((left, right) => left - right);
  const metrics = [];
  const images = [];
  const stem = basename(outputPdf, extname(outputPdf));
  for (const page of pages) {
    const beforeImage = before.get(page);
    const afterImage = after.get(page);
    const left = beforeImage ? await loadImage(Buffer.from(beforeImage.data, 'base64')) : null;
    const right = afterImage ? await loadImage(Buffer.from(afterImage.data, 'base64')) : null;
    const width = Math.max(left?.width || 0, right?.width || 0);
    const height = Math.max(left?.height || 0, right?.height || 0);
    if (!width || !height) continue;
    const beforeCanvas = createCanvas(width, height);
    const afterCanvas = createCanvas(width, height);
    for (const [canvas, image] of [[beforeCanvas, left], [afterCanvas, right]]) {
      const context = canvas.getContext('2d');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, width, height);
      if (image) context.drawImage(image, 0, 0);
    }
    const beforePixels = beforeCanvas.getContext('2d').getImageData(0, 0, width, height).data;
    const afterPixels = afterCanvas.getContext('2d').getImageData(0, 0, width, height).data;
    const diffCanvas = createCanvas(width, height);
    const diffContext = diffCanvas.getContext('2d');
    const diff = diffContext.createImageData(width, height);
    let changed = 0;
    for (let index = 0; index < afterPixels.length; index += 4) {
      const delta = Math.max(
        Math.abs(beforePixels[index] - afterPixels[index]),
        Math.abs(beforePixels[index + 1] - afterPixels[index + 1]),
        Math.abs(beforePixels[index + 2] - afterPixels[index + 2]),
      );
      const pixel = index / 4;
      if (delta >= 24) {
        changed += 1;
        diff.data[index] = 239;
        diff.data[index + 1] = 68;
        diff.data[index + 2] = 68;
        diff.data[index + 3] = 230;
      } else {
        const gray = Math.round((afterPixels[index] + afterPixels[index + 1] + afterPixels[index + 2]) / 3);
        diff.data[index] = gray;
        diff.data[index + 1] = gray;
        diff.data[index + 2] = gray;
        diff.data[index + 3] = 55;
      }
      if (pixel >= width * height) break;
    }
    diffContext.putImageData(diff, 0, 0);
    const data = diffCanvas.toBuffer('image/png');
    const path = join(dirname(outputPdf), `${stem}-visual-diff-page-${page}.png`);
    await writeFile(path, data);
    const total = width * height;
    metrics.push({
      page,
      changedPixels: changed,
      totalPixels: total,
      changedPercent: Number(((changed / total) * 100).toFixed(3)),
    });
    images.push({
      page,
      path,
      width,
      height,
      mimeType: 'image/png',
      data: data.toString('base64'),
      kind: 'visual-diff',
    });
  }
  return {
    available: metrics.length > 0,
    pages: metrics,
    changedPercent: metrics.length
      ? Number((metrics.reduce((sum, item) => sum + item.changedPercent, 0) / metrics.length).toFixed(3))
      : 0,
    images,
  };
}
