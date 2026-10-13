/** Decodes `src` into an image element; rejects with `failure` when it cannot be decoded. */
export function loadImage(src: string, failure = 'image could not be decoded'): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(failure));
    image.src = src;
  });
}
