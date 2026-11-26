package io.mixdog.app;

import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.BridgeActivity;
import java.util.Collections;
import org.json.JSONObject;

public class MainActivity extends BridgeActivity {
  // One back press closes exactly one web layer: while that layer's
  // history.back() traversal is still in flight, history.state still shows
  // the popped sentinel, so a quick second press is swallowed instead of
  // traversing past the last sentinel. The timer only unsticks a lost echo.
  // The bundled host picker keeps one entry of its own whose `mixdogBack` is
  // false while it has nothing to cancel ('disarmed'): that press drops the
  // entry and does the normal Back at once, so it is never spent on the entry.
  // The web app's own sentinels are numbers from 1, never false.
  // The service worker's offline frame (sw-shell.js) has nothing to close and
  // no native cover over it ('offline'): Back leaves it for the PC list.
  private static final String BACK_SCRIPT =
      "(function(){var"
          + " w=window;if(w.document.documentElement.hasAttribute('data-mixdog-offline'))return"
          + " 'offline';if(w.__mixdogBackBusy)return 'web';var"
          + " s=history.state,armed=!!(s&&s.mixdogBack),disarmed=!!s&&s.mixdogBack===false;"
          + "if(armed||disarmed){w.__mixdogBackBusy=true;var"
          + " done=function(){w.__mixdogBackBusy=false};"
          + "w.addEventListener('popstate',done,{once:true});setTimeout(done,1000)}if(armed){history.back();return"
          + " 'web'}if(disarmed)return 'disarmed';return"
          + " location.origin==='https://localhost'?'local':'none'})()";

  private static final String THEME_HOST_NAME = "MixdogNativeTheme";

  private MixdogNativeHost nativeHost;
  private MixdogReconnect reconnect;
  private Integer explicitWebViewSurfaceColor;
  private Integer explicitWebViewBandColor;

  @Override
  public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    MixdogNotifications.ensureChannel(this);
    parkNotificationIntent(getIntent());
    // Added after Capacitor's own handler, so it runs first. Back closes the
    // web app's topmost layer (its history sentinel); the bundled host picker
    // steps back through its own history; otherwise the app goes to the
    // background instead of finishing (and dropping the live connection).
    getOnBackPressedDispatcher()
        .addCallback(
            this,
            new OnBackPressedCallback(true) {
              @Override
              public void handleOnBackPressed() {
                // The offline cover hides the page: Back leaves the failed PC for the pairing
                // screen.
                if (reconnect != null && reconnect.onBack()) return;
                WebView webView = getBridge() == null ? null : getBridge().getWebView();
                if (webView == null) {
                  moveTaskToBack(true);
                  return;
                }
                webView.evaluateJavascript(
                    BACK_SCRIPT,
                    result -> {
                      if ("\"web\"".equals(result)) return;
                      if ("\"offline\"".equals(result)) {
                        reconnect.chooseAnotherPc();
                        return;
                      }
                      if ("\"disarmed\"".equals(result)) {
                        // Past the picker's entry and its load entry in one step
                        // (back to the PC page that opened the picker), else drop
                        // the entry and leave like a plain picker would.
                        if (webView.canGoBackOrForward(-2)) webView.goBackOrForward(-2);
                        else {
                          if (webView.canGoBack()) webView.goBack();
                          moveTaskToBack(true);
                        }
                        return;
                      }
                      if ("\"local\"".equals(result) && webView.canGoBack()) webView.goBack();
                      else moveTaskToBack(true);
                    });
              }
            });
  }

  @Override
  protected void load() {
    // Match the active light/dark workspace sheet before the first load so
    // background return, surface reclaim and IME resizes never flash a mismatched backing.
    WebView webView = findViewById(com.getcapacitor.android.R.id.webview);
    applyWebViewThemeColors(this, webView);
    registerThemeHost(webView);
    // The native bridge is a WebMessageListener limited to the bundled pairing
    // screen and saved relay origins (see MixdogNativeHost); it must exist
    // before the first page loads.
    nativeHost = new MixdogNativeHost(this);
    nativeHost.register(webView);
    super.load();
    // Top-level navigation: bundled screen + saved relay origins only. A relay
    // page that fails to load is brought back by MixdogReconnect.
    reconnect = new MixdogReconnect(this);
    getBridge().setWebViewClient(new MixdogWebViewClient(this, getBridge(), reconnect));
    // Downloads the page did not route through the fileSave bridge (UNBUILT).
    getBridge().getWebView().setDownloadListener(new MixdogDownloads(this));
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM)
      fitWebViewToInsets(getBridge().getWebView());
  }

  /**
   * Android 15+ enforces edge-to-edge for targetSdk 35, and there adjustResize no longer shrinks
   * the window: the soft keyboard only arrives as IME insets. Capacitor's own edge-to-edge margins
   * cover the system bars but not the keyboard, so the WebView kept its full height and the
   * composer stayed under the keyboard. The WebView is fitted here instead, keyboard included,
   * which resizes the page itself (window, visualViewport and dvh all shrink) exactly like
   * adjustResize does on older releases. Insets are consumed so the page never applies them a
   * second time.
   */
  private static void fitWebViewToInsets(View webView) {
    ViewCompat.setOnApplyWindowInsetsListener(
        webView,
        (view, windowInsets) -> {
          Insets bars =
              windowInsets.getInsets(
                  WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
          Insets ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime());
          int[] margins =
              WebViewInsets.margins(bars.left, bars.top, bars.right, bars.bottom, ime.bottom);
          ViewGroup.MarginLayoutParams params =
              (ViewGroup.MarginLayoutParams) view.getLayoutParams();
          if (params.leftMargin != margins[0]
              || params.topMargin != margins[1]
              || params.rightMargin != margins[2]
              || params.bottomMargin != margins[3]) {
            params.setMargins(margins[0], margins[1], margins[2], margins[3]);
            view.setLayoutParams(params);
          }
          return WindowInsetsCompat.CONSUMED;
        });
    ViewCompat.requestApplyInsets(webView);
  }

  private void registerThemeHost(WebView webView) {
    if (webView == null || !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER))
      return;
    WebViewCompat.addWebMessageListener(
        webView,
        THEME_HOST_NAME,
        Collections.singleton("*"),
        (view, message, sourceOrigin, isMainFrame, replyProxy) -> {
          String origin = OriginPolicy.originOf(sourceOrigin.toString());
          if (!isMainFrame || !OriginPolicy.isAllowed(origin, MixdogOrigins.saved(this))) return;
          handleThemeBackingMessage(message.getData());
        });
  }

  private void handleThemeBackingMessage(String raw) {
    if (raw == null || raw.isEmpty()) return;
    try {
      JSONObject payload = new JSONObject(raw);
      boolean followSystem = payload.optBoolean("followSystem", false);
      Integer surface = parseHexColor(payload.optString("surface", ""));
      Integer band = parseHexColor(payload.optString("band", ""));
      runOnUiThread(() -> {
        if (followSystem) {
          explicitWebViewSurfaceColor = null;
          explicitWebViewBandColor = null;
        } else {
          if (surface == null || band == null) return;
          explicitWebViewSurfaceColor = surface;
          explicitWebViewBandColor = band;
        }
        WebView webView = getBridge() == null ? null : getBridge().getWebView();
        applyWebViewThemeColors(this, webView);
      });
    } catch (Exception ignored) {
      // Malformed theme message: keep current backing colors.
    }
  }

  private static Integer parseHexColor(String value) {
    if (value == null || value.length() != 7 || value.charAt(0) != '#') return null;
    for (int i = 1; i < 7; i++) {
      char ch = value.charAt(i);
      boolean hex =
          (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F');
      if (!hex) return null;
    }
    return Color.parseColor(value);
  }

  void applyPickerThemeBacking() {
    runOnUiThread(() -> {
      int pickerBg = ContextCompat.getColor(this, R.color.mixdogBand);
      explicitWebViewSurfaceColor = pickerBg;
      explicitWebViewBandColor = pickerBg;
      WebView webView = getBridge() == null ? null : getBridge().getWebView();
      applyWebViewThemeColors(this, webView);
    });
  }

  void openHostPicker() {
    runOnUiThread(() -> {
      applyPickerThemeBacking();
      if (getBridge() == null || getBridge().getWebView() == null) return;
      getBridge().getWebView().loadUrl(getBridge().getLocalUrl() + "/?manage=1");
    });
  }

  private void applyWebViewThemeColors(Context context, WebView webView) {
    if (webView == null) return;
    int surface =
        explicitWebViewSurfaceColor != null
            ? explicitWebViewSurfaceColor
            : ContextCompat.getColor(context, R.color.mixdogWebViewSurface);
    int band =
        explicitWebViewBandColor != null
            ? explicitWebViewBandColor
            : ContextCompat.getColor(context, R.color.mixdogWebViewBand);
    webView.setBackgroundColor(surface);
    if (webView.getParent() instanceof View) {
      ((View) webView.getParent()).setBackgroundColor(band);
    }
    applySystemBarAppearance(band);
  }

  private void applySystemBarAppearance(int bandColor) {
    if (getWindow() == null) return;
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.VANILLA_ICE_CREAM) {
      getWindow().setStatusBarColor(bandColor);
      getWindow().setNavigationBarColor(bandColor);
    }
    WindowInsetsControllerCompat controller =
        WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
    if (controller != null) {
      boolean light = isLightColor(bandColor);
      controller.setAppearanceLightStatusBars(light);
      controller.setAppearanceLightNavigationBars(light);
    }
  }

  private static boolean isLightColor(int color) {
    double luminance =
        (0.2126 * Color.red(color) + 0.7152 * Color.green(color) + 0.0722 * Color.blue(color))
            / 255.0;
    return luminance >= 0.5;
  }

  @Override
  public void onConfigurationChanged(Configuration newConfig) {
    super.onConfigurationChanged(newConfig);
    WebView webView = getBridge() == null ? null : getBridge().getWebView();
    applyWebViewThemeColors(createConfigurationContext(newConfig), webView);
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    parkNotificationIntent(intent);
    MixdogNativeHost.notifyWeb();
  }

  void notifyNetworkChanged() {
    if (nativeHost != null) nativeHost.onNetworkChanged();
  }

  @Override
  public void onResume() {
    super.onResume();
    if (nativeHost != null) nativeHost.onResume();
    if (reconnect != null) reconnect.onResume();
  }

  @Override
  public void onPause() {
    if (reconnect != null) reconnect.onPause();
    if (nativeHost != null) {
      PowerManager pm = getSystemService(PowerManager.class);
      if (pm != null && !pm.isInteractive()) nativeHost.onBackground();
      nativeHost.onPause();
    }
    super.onPause();
  }

  @Override
  public void onStop() {
    if (!isChangingConfigurations() && nativeHost != null) nativeHost.onBackground();
    super.onStop();
  }

  @Override
  public void onDestroy() {
    if (nativeHost != null) nativeHost.onDestroy();
    super.onDestroy();
  }

  @Override
  public void onRequestPermissionsResult(
      int requestCode, String[] permissions, int[] grantResults) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults);
    if (requestCode == MixdogNativeHost.PERMISSION_REQUEST && nativeHost != null)
      nativeHost.onPermissionResult();
  }

  /** A notification tap / Allow / Deny: park it for the web app and clear the notification. */
  private void parkNotificationIntent(Intent intent) {
    if (intent == null) return;
    String action = intent.getStringExtra(MixdogNotifications.EXTRA_ACTION);
    String sessionId = intent.getStringExtra(MixdogNotifications.EXTRA_SESSION);
    if (action == null || sessionId == null || sessionId.isEmpty()) return;
    MixdogPushStore.addAction(
        this,
        intent.getStringExtra(MixdogNotifications.EXTRA_ACTION_ID),
        action,
        sessionId,
        intent.getStringExtra(MixdogNotifications.EXTRA_APPROVAL),
        intent.getStringExtra(MixdogNotifications.EXTRA_HOST));
    int notificationId = intent.getIntExtra(MixdogNotifications.EXTRA_NOTIFICATION_ID, 0);
    if (notificationId != 0) getSystemService(NotificationManager.class).cancel(notificationId);
    // Consumed: a rotation or recreate must not replay it.
    intent.removeExtra(MixdogNotifications.EXTRA_ACTION);
  }
}
