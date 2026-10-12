package io.mixdog.app;

import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import java.io.ByteArrayInputStream;
import java.util.HashMap;

/**
 * Top-level navigation is limited to the bundled pairing screen and the saved
 * relay origins; any other http(s) link opens in the system browser. (There is
 * no wildcard `allowNavigation`: see OriginPolicy.)
 */
public class MixdogWebViewClient extends BridgeWebViewClient {
  public MixdogWebViewClient(Bridge bridge) {
    super(bridge);
  }

  private boolean block(WebView view, Uri uri) {
    Context context = view.getContext();
    if (MixdogOrigins.isAllowed(context, uri.toString())) return false;
    String scheme = uri.getScheme();
    if ("https".equalsIgnoreCase(scheme) || "http".equalsIgnoreCase(scheme)) {
      try {
        context.startActivity(new Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
      } catch (Exception ignored) {
        // No browser installed: the navigation is still refused.
      }
    }
    return true;
  }

  @Override
  public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
    // Frames inside an allowed page are not top-level navigation; they get no bridge (see MixdogNativeHost).
    if (!request.isForMainFrame()) return false;
    return block(view, request.getUrl());
  }

  @Override
  public boolean shouldOverrideUrlLoading(WebView view, String url) {
    return block(view, Uri.parse(url));
  }

  // shouldOverrideUrlLoading is not called for POST navigations (nor reliably
  // for every redirect hop), so main-frame requests are also refused here.
  @Override
  public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
    if (request.isForMainFrame()
        && !NavigationPolicy.allowMainFrame(
            request.getUrl().toString(), MixdogOrigins.saved(view.getContext()))) {
      return new WebResourceResponse(
          "text/plain", "utf-8", 403, "Blocked", new HashMap<String, String>(), new ByteArrayInputStream(new byte[0]));
    }
    return super.shouldInterceptRequest(view, request);
  }

  // Last line: whatever URL the page actually started on after redirects.
  @Override
  public void onPageStarted(WebView view, String url, Bitmap favicon) {
    if (url != null && !"about:blank".equals(url) && !NavigationPolicy.allowMainFrame(url, MixdogOrigins.saved(view.getContext()))) {
      view.stopLoading();
      return;
    }
    super.onPageStarted(view, url, favicon);
  }
}
