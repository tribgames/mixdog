package io.mixdog.app;

import android.app.NotificationManager;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  // One back press closes exactly one web layer: while that layer's
  // history.back() traversal is still in flight, history.state still shows
  // the popped sentinel, so a quick second press is swallowed instead of
  // traversing past the last sentinel. The timer only unsticks a lost echo.
  // The bundled host picker keeps one entry of its own whose `mixdogBack` is
  // false while it has nothing to cancel ('disarmed'): that press drops the
  // entry and does the normal Back at once, so it is never spent on the entry.
  // The web app's own sentinels are numbers from 1, never false.
  private static final String BACK_SCRIPT =
      "(function(){var w=window;if(w.__mixdogBackBusy)return 'web';"
          + "var s=history.state,armed=!!(s&&s.mixdogBack),disarmed=!!s&&s.mixdogBack===false;"
          + "if(armed||disarmed){w.__mixdogBackBusy=true;"
          + "var done=function(){w.__mixdogBackBusy=false};"
          + "w.addEventListener('popstate',done,{once:true});setTimeout(done,1000)}"
          + "if(armed){history.back();return 'web'}"
          + "if(disarmed)return 'disarmed';"
          + "return location.origin==='https://localhost'?'local':'none'})()";

  private MixdogNativeHost nativeHost;

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
                WebView webView = getBridge() == null ? null : getBridge().getWebView();
                if (webView == null) {
                  moveTaskToBack(true);
                  return;
                }
                webView.evaluateJavascript(BACK_SCRIPT, (result) -> {
                  if ("\"web\"".equals(result)) return;
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
    // The native bridge is a WebMessageListener limited to the bundled pairing
    // screen and saved relay origins (see MixdogNativeHost); it must exist
    // before the first page loads.
    nativeHost = new MixdogNativeHost(this);
    nativeHost.register(findViewById(com.getcapacitor.android.R.id.webview));
    super.load();
    // Top-level navigation: bundled screen + saved relay origins only.
    getBridge().setWebViewClient(new MixdogWebViewClient(getBridge()));
    // Downloads the page did not route through the fileSave bridge (UNBUILT).
    getBridge().getWebView().setDownloadListener(new MixdogDownloads(this));
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM) fitWebViewToInsets(getBridge().getWebView());
  }

  /**
   * Android 15+ enforces edge-to-edge for targetSdk 35, and there
   * adjustResize no longer shrinks the window: the soft keyboard only arrives
   * as IME insets. Capacitor's own edge-to-edge margins cover the system bars
   * but not the keyboard, so the WebView kept its full height and the
   * composer stayed under the keyboard. The WebView is fitted here instead,
   * keyboard included, which resizes the page itself (window, visualViewport
   * and dvh all shrink) exactly like adjustResize does on older releases.
   * Insets are consumed so the page never applies them a second time.
   */
  private static void fitWebViewToInsets(View webView) {
    ViewCompat.setOnApplyWindowInsetsListener(webView, (view, windowInsets) -> {
      Insets bars = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
      Insets ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime());
      int[] margins = WebViewInsets.margins(bars.left, bars.top, bars.right, bars.bottom, ime.bottom);
      ViewGroup.MarginLayoutParams params = (ViewGroup.MarginLayoutParams) view.getLayoutParams();
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

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    parkNotificationIntent(intent);
    MixdogNativeHost.notifyWeb();
  }

  @Override
  public void onResume() {
    super.onResume();
    if (nativeHost != null) nativeHost.onResume();
  }

  @Override
  public void onPause() {
    if (nativeHost != null) nativeHost.onPause();
    super.onPause();
  }

  @Override
  public void onDestroy() {
    if (nativeHost != null) nativeHost.onDestroy();
    super.onDestroy();
  }

  @Override
  public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults);
    if (requestCode == MixdogNativeHost.PERMISSION_REQUEST && nativeHost != null) nativeHost.onPermissionResult();
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
