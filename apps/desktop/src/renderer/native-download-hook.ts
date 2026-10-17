// Inside the phone apps the WebView drops `<a download>` clicks on blob: and
// data: URLs (Android has no DownloadListener for them, iOS cancels them), and
// the page CSP (connect-src) blocks fetch() of a blob: URL. So the Blob is
// remembered when its URL is minted, and a click on such a link is routed to
// the native fileSave bridge (saveBlobOnDevice) with that Blob.
import { blobFromUrl, saveBlobOnDevice } from './file-download-transfer';

/** Starts routing `<a download>` clicks on `doc`; returns the uninstall. */
export function installNativeDownloadHook(doc: Document): () => void {
  const view = doc.defaultView;
  if (!view) return () => {};
  const urls = view.URL;
  const create = urls.createObjectURL.bind(urls);
  const revoke = urls.revokeObjectURL.bind(urls);
  const blobs = new Map<string, Blob>();
  urls.createObjectURL = (object: Blob | MediaSource) => {
    const url = create(object);
    if (object instanceof Blob) blobs.set(url, object);
    return url;
  };
  urls.revokeObjectURL = (url: string) => {
    blobs.delete(url);
    revoke(url);
  };
  const onClick = (event: Event) => {
    const target = event.target;
    const link = target instanceof view.Element ? target.closest<HTMLAnchorElement>('a[download]') : null;
    if (!link || event.defaultPrevented || !/^(?:blob|data):/iu.test(link.href)) return;
    const href = link.href;
    const name = link.getAttribute('download') || 'download';
    // Read now: the page may revoke the URL right after the click.
    const known = blobs.get(href);
    event.preventDefault();
    void (known ? Promise.resolve(known) : blobFromUrl(href))
      .then((blob) => saveBlobOnDevice(blob, name))
      .catch((error: unknown) => console.error('Native download failed', error));
  };
  doc.addEventListener('click', onClick, true);
  return () => {
    doc.removeEventListener('click', onClick, true);
    urls.createObjectURL = create;
    urls.revokeObjectURL = revoke;
  };
}
