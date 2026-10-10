package io.mixdog.app;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.nio.charset.StandardCharsets;
import java.security.PrivateKey;
import org.json.JSONObject;

/**
 * FCM data messages: `mx` is decrypted here (mixdog-native-push-v1) and shown
 * as a local notification. Nothing readable ever crosses FCM.
 */
public class MixdogMessagingService extends FirebaseMessagingService {
  @Override
  public void onNewToken(String token) {
    MixdogPushStore.setToken(this, token);
    MixdogNativeHost.notifyWeb();
  }

  @Override
  public void onMessageReceived(RemoteMessage message) {
    String mx = message.getData().get("mx");
    if (mx == null || mx.isEmpty()) return;
    try {
      JSONObject envelope =
          new JSONObject(new String(NativePushCrypto.base64UrlDecode(mx), StandardCharsets.UTF_8));
      if (envelope.optInt("v") != 1) throw new IllegalArgumentException("version");
      PrivateKey key = MixdogKeys.privateKey(this);
      byte[] plain =
          NativePushCrypto.decrypt(
              key,
              NativePushCrypto.base64UrlDecode(envelope.getString("epk")),
              NativePushCrypto.base64UrlDecode(envelope.getString("iv")),
              NativePushCrypto.base64UrlDecode(envelope.getString("ct")));
      JSONObject content = new JSONObject(new String(plain, StandardCharsets.UTF_8));
      MixdogNotifications.show(
          this,
          content.getString("title"),
          content.getString("body"),
          content.getString("sessionId"),
          content.optString("reason", ""),
          content.optString("approvalId", ""));
    } catch (Exception e) {
      // Undecryptable (stale key after reinstall, tampering): say so without content.
      MixdogNotifications.show(this, "Mixdog", "Open Mixdog to see new activity.", "mixdog-generic", "", "");
    }
  }
}
