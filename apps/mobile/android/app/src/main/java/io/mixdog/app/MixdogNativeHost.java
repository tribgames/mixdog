package io.mixdog.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.net.Uri;
import android.webkit.WebView;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONTokener;
import androidx.core.app.ActivityCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;
import java.lang.ref.WeakReference;
import org.json.JSONObject;

/**
 * `window.MixdogNativeHost` (shared/native-app.ts reads it): an AndroidX
 * WebMessageListener, so it exists only in pages whose origin matches the rules
 * (bundled pairing screen + saved relay origins) and every message is checked
 * again against that allow-list, main frame only. Anything else gets nothing.
 * Messages are JSON `{id, method, args}`; replies `{id, result}`. Slow work
 * (permission prompt, token fetch) finishes later and fires `mixdognativepush`.
 */
public final class MixdogNativeHost implements WebViewCompat.WebMessageListener {
  static final int PERMISSION_REQUEST = 4711;
  static final String NAME = "MixdogNativeHost";
  private static WeakReference<MixdogNativeHost> current = new WeakReference<>(null);

  private final MainActivity activity;

  MixdogNativeHost(MainActivity activity) {
    this.activity = activity;
    current = new WeakReference<>(this);
  }

  /** (Re)register the listener for the current allow-list; takes effect on the next page load. */
  void register(WebView webView) {
    if (webView == null || !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return;
    try {
      WebViewCompat.removeWebMessageListener(webView, NAME);
    } catch (Exception ignored) {
      // Not registered yet.
    }
    Set<String> rules = new HashSet<>(OriginPolicy.BUNDLED);
    rules.remove("capacitor://localhost");
    rules.addAll(MixdogOrigins.saved(activity));
    try {
      WebViewCompat.addWebMessageListener(webView, NAME, rules, this);
    } catch (IllegalArgumentException e) {
      // A saved origin the WebView cannot express as a rule: bundled screen only.
      WebViewCompat.addWebMessageListener(webView, NAME, Collections.singleton("https://localhost"), this);
    }
  }

  @Override
  public void onPostMessage(
      WebView view,
      WebMessageCompat message,
      Uri sourceOrigin,
      boolean isMainFrame,
      JavaScriptReplyProxy replyProxy) {
    String origin = OriginPolicy.originOf(sourceOrigin.toString());
    if (!isMainFrame || !OriginPolicy.isAllowed(origin, MixdogOrigins.saved(activity))) return;
    try {
      JSONObject request = new JSONObject(message.getData());
      JSONObject args = request.optJSONObject("args");
      String result =
          handle(request.getString("method"), args == null ? new JSONObject() : args, OriginPolicy.isBundled(origin));
      replyProxy.postMessage(new JSONObject().put("id", request.getInt("id")).put("result", new JSONTokener(result).nextValue()).toString());
      if ("setAllowedOrigins".equals(request.getString("method"))) view.post(() -> register(view));
    } catch (Exception ignored) {
      // Malformed message: no answer.
    }
  }

  /** Tell the web app the token / permission / parked actions changed. */
  static void notifyWeb() {
    MixdogNativeHost host = current.get();
    if (host != null) host.fireEvent();
  }

  private void fireEvent() {
    WebView webView = activity.getBridge() == null ? null : activity.getBridge().getWebView();
    if (webView == null) return;
    webView.post(
        () ->
            webView.evaluateJavascript(
                "window.dispatchEvent(new Event('mixdognativepush'))", null));
  }

  private String permission() {
    boolean enabled = NotificationManagerCompat.from(activity).areNotificationsEnabled();
    boolean runtimeGranted =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
            || ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
    if (enabled && runtimeGranted) return "granted";
    return MixdogPushStore.permissionAsked(activity) ? "denied" : "prompt";
  }

  private void fetchToken() {
    if (FirebaseApp.getApps(activity).isEmpty()) return; // no google-services.json in this build
    FirebaseMessaging.getInstance()
        .getToken()
        .addOnSuccessListener(
            token -> {
              if (token != null && !token.equals(MixdogPushStore.token(activity))) {
                MixdogPushStore.setToken(activity, token);
              }
              fireEvent();
            });
  }

  private JSONObject state() throws Exception {
    String permission = permission();
    if ("granted".equals(permission) && MixdogPushStore.token(activity).isEmpty()) fetchToken();
    return new JSONObject()
        .put("platform", "fcm")
        .put("token", MixdogPushStore.token(activity))
        .put("publicKey", MixdogKeys.publicKey(activity))
        .put("permission", permission);
  }

  void onPermissionResult() {
    fetchToken();
    fireEvent();
  }

  private String handle(String method, JSONObject args, boolean bundledPage) {
    try {
      switch (method) {
        case "setAllowedOrigins":
          // Only the bundled pairing screen may widen what can load.
          if (!bundledPage) return "false";
          JSONArray origins = args.optJSONArray("origins");
          List<String> list = new ArrayList<>();
          for (int i = 0; origins != null && i < origins.length(); i++) list.add(origins.optString(i));
          MixdogOrigins.save(activity, OriginPolicy.sanitize(list));
          return "true";
        case "getPushState":
          return state().toString();
        case "requestPush":
          if (!"granted".equals(permission())) {
            MixdogPushStore.setPermissionAsked(activity);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
              activity.runOnUiThread(
                  () ->
                      ActivityCompat.requestPermissions(
                          activity,
                          new String[] {Manifest.permission.POST_NOTIFICATIONS},
                          PERMISSION_REQUEST));
            }
          }
          return state().toString();
        case "takePendingAction":
          JSONObject action = MixdogPushStore.takeAction(activity);
          return action == null ? "null" : action.toString();
        case "openHostPicker":
          activity.runOnUiThread(
              () ->
                  activity
                      .getBridge()
                      .getWebView()
                      .loadUrl(activity.getBridge().getLocalUrl() + "/?manage=1"));
          return "true";
        default:
          return "null";
      }
    } catch (Exception e) {
      return "null";
    }
  }
}
