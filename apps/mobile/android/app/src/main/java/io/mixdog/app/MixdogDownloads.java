package io.mixdog.app;

import android.app.DownloadManager;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.URLUtil;
import android.widget.Toast;

/**
 * WebView download fallback (UNBUILT / UNVERIFIED: written on a PC that cannot
 * build the Android app). A download the page did not route through the
 * `fileSave*` bridge (shared/native-file-save.ts) used to be dropped because
 * the WebView had no DownloadListener. An http(s) download from an allowed
 * relay origin is handed to the system DownloadManager, which writes it into
 * Downloads/Mixdog (API 29+; app-specific Downloads below, which needs no
 * storage permission) and posts a "download complete" notification. blob: and
 * data: URLs cannot be fetched natively and the page CSP blocks fetching them,
 * so the web side (renderer/native-download-hook.ts) hands those Blobs to the
 * bridge itself; reaching here with one means that hook did not run.
 */
final class MixdogDownloads implements DownloadListener {
  private final Context context;

  MixdogDownloads(Context context) {
    this.context = context;
  }

  @Override
  public void onDownloadStart(String url, String userAgent, String contentDisposition, String mimeType, long contentLength) {
    Uri uri = Uri.parse(url);
    String scheme = uri.getScheme();
    boolean http = "https".equalsIgnoreCase(scheme) || "http".equalsIgnoreCase(scheme);
    if (!http || !MixdogOrigins.isAllowed(context, url)) {
      Toast.makeText(context, context.getString(R.string.download_cannot_save), Toast.LENGTH_LONG).show();
      return;
    }
    String name = FileSaveSessions.sanitizeName(URLUtil.guessFileName(url, contentDisposition, mimeType));
    try {
      DownloadManager.Request request =
          new DownloadManager.Request(uri)
              .setTitle(name)
              .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
      if (mimeType != null && !mimeType.isEmpty()) request.setMimeType(mimeType);
      if (userAgent != null) request.addRequestHeader("User-Agent", userAgent);
      String cookie = CookieManager.getInstance().getCookie(url);
      if (cookie != null) request.addRequestHeader("Cookie", cookie);
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "Mixdog/" + name);
      } else {
        request.setDestinationInExternalFilesDir(context, Environment.DIRECTORY_DOWNLOADS, name);
      }
      context.getSystemService(DownloadManager.class).enqueue(request);
      Toast.makeText(context, context.getString(R.string.download_started, name), Toast.LENGTH_SHORT).show();
    } catch (RuntimeException e) {
      Toast.makeText(context, context.getString(R.string.download_failed), Toast.LENGTH_LONG).show();
    }
  }
}
