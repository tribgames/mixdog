package io.mixdog.app;

import android.content.Context;
import android.content.SharedPreferences;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** FCM token, permission-asked flag and the notification actions waiting for the web app. */
final class MixdogPushStore {
  private static final String PREFS = "mixdog_native_push";
  private static final String TOKEN = "fcm_token";
  private static final String ASKED = "permission_asked";
  private static final String PENDING = "pending_actions";
  private static final String LABEL_DENY = "label_deny";
  private static final String LABEL_ALLOW_ONCE = "label_allow_once";
  private static final int LABEL_MAX = 40;

  private MixdogPushStore() {}

  private static SharedPreferences prefs(Context context) {
    return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
  }

  static String token(Context context) {
    return prefs(context).getString(TOKEN, "");
  }

  static void setToken(Context context, String token) {
    prefs(context).edit().putString(TOKEN, token == null ? "" : token).apply();
  }

  static boolean permissionAsked(Context context) {
    return prefs(context).getBoolean(ASKED, false);
  }

  static void setPermissionAsked(Context context) {
    prefs(context).edit().putBoolean(ASKED, true).apply();
  }

  /** The approval actions' words, as the web app's language says them (setNotificationLabels). */
  static String denyLabel(Context context) {
    return prefs(context).getString(LABEL_DENY, "Deny");
  }

  static String allowOnceLabel(Context context) {
    return prefs(context).getString(LABEL_ALLOW_ONCE, "Allow just once");
  }

  /** False (nothing kept) when either label is empty. */
  static boolean setLabels(Context context, String deny, String allowOnce) {
    String denyText = label(deny);
    String allowText = label(allowOnce);
    if (denyText.isEmpty() || allowText.isEmpty()) return false;
    prefs(context).edit().putString(LABEL_DENY, denyText).putString(LABEL_ALLOW_ONCE, allowText).apply();
    return true;
  }

  private static String label(String value) {
    String text = value == null ? "" : value.trim();
    return text.length() > LABEL_MAX ? text.substring(0, LABEL_MAX) : text;
  }

  private static List<Map<String, String>> load(Context context) {
    List<Map<String, String>> queue = new ArrayList<>();
    try {
      JSONArray array = new JSONArray(prefs(context).getString(PENDING, "[]"));
      for (int i = 0; i < array.length(); i++) {
        JSONObject item = array.getJSONObject(i);
        Map<String, String> entry = new HashMap<>();
        for (String key : new String[] {"id", "action", "sessionId", "approvalId", "hostId", "createdAt"}) {
          String value = item.optString(key, "");
          if (!value.isEmpty()) entry.put(key, value);
        }
        // Entries parked by an older build had neither id nor timestamp.
        if (!entry.containsKey("id")) entry.put("id", UUID.randomUUID().toString());
        if (!entry.containsKey("createdAt")) entry.put("createdAt", String.valueOf(System.currentTimeMillis()));
        queue.add(entry);
      }
    } catch (JSONException e) {
      // A malformed queue is dropped.
      prefs(context).edit().remove(PENDING).apply();
      queue.clear();
    }
    return queue;
  }

  private static void save(Context context, List<Map<String, String>> queue) {
    prefs(context).edit().putString(PENDING, json(queue).toString()).apply();
  }

  private static JSONArray json(List<Map<String, String>> entries) {
    JSONArray array = new JSONArray();
    for (Map<String, String> entry : entries) array.put(new JSONObject(entry));
    return array;
  }

  /** actionId makes a re-delivered intent idempotent; hostId binds the action to its originating host. */
  static synchronized void addAction(
      Context context, String actionId, String action, String sessionId, String approvalId, String hostId) {
    Map<String, String> entry = new HashMap<>();
    entry.put("id", actionId == null || actionId.isEmpty() ? UUID.randomUUID().toString() : actionId);
    entry.put("action", action);
    entry.put("sessionId", sessionId);
    if (approvalId != null && !approvalId.isEmpty()) entry.put("approvalId", approvalId);
    if (hostId != null && !hostId.isEmpty()) entry.put("hostId", hostId);
    long now = System.currentTimeMillis();
    entry.put("createdAt", String.valueOf(now));
    save(context, PendingActionQueue.add(load(context), entry, now));
  }

  /** Parked actions this host may act on, left in place until acknowledged. */
  static synchronized JSONArray peekActions(Context context, String hostId) {
    long now = System.currentTimeMillis();
    List<Map<String, String>> queue = PendingActionQueue.prune(load(context), now);
    save(context, queue);
    return json(PendingActionQueue.forHost(queue, hostId, now));
  }

  static synchronized void ackAction(Context context, String id) {
    save(context, PendingActionQueue.ack(load(context), id));
  }

  /** Legacy (pre-ack web clients): oldest parked action, removed; null when none. */
  static synchronized JSONObject takeAction(Context context) {
    List<Map<String, String>> queue = PendingActionQueue.prune(load(context), System.currentTimeMillis());
    if (queue.isEmpty()) return null;
    Map<String, String> first = queue.get(0);
    save(context, PendingActionQueue.ack(queue, first.get("id")));
    return new JSONObject(first);
  }
}
