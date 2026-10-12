/**
 * Pixels on GNOME Wayland, taken by Mixdog's own shell extension. Electron's
 * desktopCapturer would go through the ScreenCast portal there and ask the user
 * to "Share Screen" on every capture; this never prompts, so a background
 * capture cannot interrupt the user.
 */
import { nativeImage, screen, type NativeImage } from 'electron';

import { gnomeShellScreenshot, type GnomeShellSource, type GnomeShotTarget } from '../host/gnome-helper';

function targetFor(source: GnomeShellSource): GnomeShotTarget {
  if (source.kind === 'window') return { kind: 'window', id: source.handle };
  if (!source.displayId) return { kind: 'stage' };
  const display = screen.getAllDisplays().find((candidate) => String(candidate.id) === source.displayId);
  if (!display) throw new Error('capture_source_unavailable: exact screen source is unavailable');
  return { kind: 'area', ...display.bounds };
}

/** The source's pixels, scaled to `size` when the shell's own size differs. */
export async function captureGnomeShellSource(
  source: GnomeShellSource,
  size: { width: number; height: number },
  shoot: (target: GnomeShotTarget) => Promise<Buffer> = gnomeShellScreenshot
): Promise<NativeImage> {
  let png: Buffer;
  try {
    png = await shoot(targetFor(source));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (reason.startsWith('capture_source_unavailable')) throw error;
    throw new Error(
      `capture_source_unavailable: the Mixdog GNOME helper could not take the screenshot (${reason}); if it was just updated, sign out and in once`
    );
  }
  const image = nativeImage.createFromBuffer(png);
  if (image.isEmpty()) throw new Error('capture_source_unavailable: the Mixdog GNOME helper returned an empty image');
  const current = image.getSize();
  return current.width === size.width && current.height === size.height
    ? image
    : image.resize({ width: size.width, height: size.height, quality: 'best' });
}
