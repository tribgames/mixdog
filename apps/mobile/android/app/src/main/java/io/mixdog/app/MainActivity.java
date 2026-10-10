package io.mixdog.app;

import android.app.NotificationManager;
import android.content.Intent;
import android.os.Bundle;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  private MixdogNativeHost nativeHost;

  @Override
  public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    MixdogNotifications.ensureChannel(this);
    parkNotificationIntent(getIntent());
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
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    parkNotificationIntent(intent);
    MixdogNativeHost.notifyWeb();
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
        this, action, sessionId, intent.getStringExtra(MixdogNotifications.EXTRA_APPROVAL));
    int notificationId = intent.getIntExtra(MixdogNotifications.EXTRA_NOTIFICATION_ID, 0);
    if (notificationId != 0) getSystemService(NotificationManager.class).cancel(notificationId);
    // Consumed: a rotation or recreate must not replay it.
    intent.removeExtra(MixdogNotifications.EXTRA_ACTION);
  }

  // Immersive shell (user request): hide the system navigation bar; a swipe
  // from the edge shows it transiently. The status bar stays visible.
  @Override
  public void onWindowFocusChanged(boolean hasFocus) {
    super.onWindowFocusChanged(hasFocus);
    if (!hasFocus) return;
    WindowInsetsControllerCompat controller =
        WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
    controller.setSystemBarsBehavior(
        WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
    controller.hide(WindowInsetsCompat.Type.navigationBars());
  }
}
