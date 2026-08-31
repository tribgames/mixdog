const IMAGE_FITS = new Set(['stretch', 'contain', 'cover']);

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function coordinate(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function unit(value, fallback = 0.5) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(1, number));
}

export function resolveImageLayout({
  sourceWidth,
  sourceHeight,
  left = 0,
  top = 0,
  width = 100,
  height = 100,
  fit = 'stretch',
  focusX = 0.5,
  focusY = 0.5,
} = {}) {
  const mode = String(fit || 'stretch').trim().toLowerCase();
  if (!IMAGE_FITS.has(mode)) {
    throw new Error('Image fit must be stretch, contain, or cover');
  }
  const frame = {
    left: coordinate(left),
    top: coordinate(top),
    width: positive(width, 100),
    height: positive(height, 100),
  };
  if (mode === 'stretch') return { ...frame, fit: mode, crop: null };

  const source = {
    width: positive(sourceWidth, 0),
    height: positive(sourceHeight, 0),
  };
  if (!source.width || !source.height) {
    throw new Error(`Image fit ${mode} requires a PNG, JPEG, or GIF with readable dimensions`);
  }

  if (mode === 'contain') {
    const scale = Math.min(frame.width / source.width, frame.height / source.height);
    const placedWidth = source.width * scale;
    const placedHeight = source.height * scale;
    return {
      left: frame.left + ((frame.width - placedWidth) / 2),
      top: frame.top + ((frame.height - placedHeight) / 2),
      width: placedWidth,
      height: placedHeight,
      fit: mode,
      crop: null,
    };
  }

  const sourceRatio = source.width / source.height;
  const targetRatio = frame.width / frame.height;
  const crop = { left: 0, top: 0, right: 0, bottom: 0 };
  if (sourceRatio > targetRatio) {
    const visible = targetRatio / sourceRatio;
    const remaining = 1 - visible;
    const start = Math.max(0, Math.min(remaining, unit(focusX) - (visible / 2)));
    crop.left = start;
    crop.right = remaining - start;
  } else if (sourceRatio < targetRatio) {
    const visible = sourceRatio / targetRatio;
    const remaining = 1 - visible;
    const start = Math.max(0, Math.min(remaining, unit(focusY) - (visible / 2)));
    crop.top = start;
    crop.bottom = remaining - start;
  }
  return { ...frame, fit: mode, crop };
}
