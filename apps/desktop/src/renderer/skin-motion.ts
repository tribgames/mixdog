// A skin's moving layer: a built-in's loop, or the custom video / animated
// GIF. One fixed element behind the shell, exactly where the picture sits
// (33-skin.css .skin-motion: same cover fit and focal point as body::before,
// under the same plates). The picture stays painted underneath as the poster
// and the layer fades in only on its first frame, so nothing flashes or moves.
// Reduced motion shows the poster only; a hidden document (a minimised window
// or a background tab) pauses the video.
export type SkinMotion = {
  /** Identity of the media: an unchanged key keeps the playing element. */
  key: string;
  kind: 'video' | 'image';
  poster: string;
  /** A bundled URL, or the stored Blob (an object URL is made and revoked here). */
  source(): string | Promise<Blob | null>;
};

type Layer = { key: string; element: HTMLVideoElement | HTMLImageElement; video: HTMLVideoElement | null; url: string };

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
let layer: Layer | null = null;
let watchedWindow: Window | null = null;

export function prefersReducedMotion(): boolean {
  return window.matchMedia?.(REDUCED_MOTION).matches === true;
}

/** Autoplay that the browser refuses leaves the poster in place. */
function playWhileVisible(video: HTMLVideoElement): void {
  if (document.hidden) video.pause();
  else void video.play().catch(() => {});
}

function onVisibility(): void {
  if (layer?.video) playWhileVisible(layer.video);
}

function release(current: Layer): void {
  if (current.video) {
    current.video.pause();
    current.video.removeAttribute('src');
  }
  current.element.remove();
  if (current.url) URL.revokeObjectURL(current.url);
}

function createElement(motion: SkinMotion): Layer {
  const video = motion.kind === 'video' ? document.createElement('video') : null;
  const element = video ?? document.createElement('img');
  element.className = 'skin-motion';
  element.setAttribute('aria-hidden', 'true');
  if (video) {
    // The attributes for the markup, the properties for the element already
    // created (a muted attribute set after creation does not mute it).
    for (const name of ['muted', 'loop', 'playsinline', 'autoplay']) video.setAttribute(name, '');
    video.muted = true;
    video.loop = true;
    video.preload = 'auto';
    video.poster = motion.poster;
  } else {
    (element as HTMLImageElement).alt = '';
    (element as HTMLImageElement).decoding = 'async';
  }
  element.addEventListener(
    video ? 'playing' : 'load',
    () => {
      element.dataset.ready = 'true';
    },
    { once: true }
  );
  return { key: motion.key, element, video, url: '' };
}

function attach(current: Layer, src: string): void {
  current.element.src = src;
  if (current.video) playWhileVisible(current.video);
}

/** Show `motion` (null: none) behind the shell; `repaint` runs when the
    reduced-motion preference flips. Idempotent for an unchanged key. */
export function syncSkinMotion(motion: SkinMotion | null, repaint: () => void): void {
  if (watchedWindow !== window) {
    watchedWindow = window;
    document.addEventListener('visibilitychange', onVisibility);
    window.matchMedia?.(REDUCED_MOTION).addEventListener('change', repaint);
  }
  const wanted = motion && !prefersReducedMotion() ? motion : null;
  if (layer && layer.key === wanted?.key && layer.element.isConnected) return;
  if (layer) release(layer);
  layer = null;
  if (!wanted) return;
  const current = createElement(wanted);
  layer = current;
  document.body.append(current.element);
  const source = wanted.source();
  if (typeof source === 'string') {
    attach(current, source);
    return;
  }
  // A stored file that cannot be read leaves the poster.
  source.then(
    (blob) => {
      if (layer !== current || !blob) return;
      current.url = URL.createObjectURL(blob);
      attach(current, current.url);
    },
    () => {}
  );
}
