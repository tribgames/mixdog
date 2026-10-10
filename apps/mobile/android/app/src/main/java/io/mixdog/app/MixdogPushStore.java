package io.mixdog.app;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** FCM token, permission-asked flag and the notification actions waiting for the web app. */
final class MixdogPushStore {
  private static final String PREFS = "mixdog_native_push";
  private static final String TOKEN = "fcm_token";
  private static final String ASKED = "permission_asked";
  private static final String PENDING = "pending_actions";
  private static final int MAX_PENDING = 8;

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

  static synchronized void addAction(Context context, String action, String sessionId, String approvalId) {
    try {
      JSONArray queue = new JSONArray(prefs(context).getString(PENDING, "[]"));
      JSONObject entry = new JSONObject().put("action", action).put("sessionId", sessionId);
      if (approvalId != null && !approvalId.isEmpty()) entry.put("approvalId", approvalId);
      queue.put(entry);
      JSONArray kept = new JSONArray();
      for (int i = Math.max(0, queue.length() - MAX_PENDING); i < queue.length(); i++) kept.put(queue.get(i));
      prefs(context).edit().putString(PENDING, kept.toString()).apply();
    } catch (JSONException ignored) {
      // A malformed queue is dropped on the next write.
      prefs(context).edit().remove(PENDING).apply();
    }
  }

  /** Oldest parked action, removed; null when none. */
  static synchronized JSONObject takeAction(Context context) {
    try {
      JSONArray queue = new JSONArray(prefs(context).getString(PENDING, "[]"));
      if (queue.length() == 0) return null;
      JSONObject first = queue.getJSONObject(0);
      JSONArray rest = new JSONArray();
      for (int i = 1; i < queue.length(); i++) rest.put(queue.get(i));
      prefs(context).edit().putString(PENDING, rest.toString()).apply();
      return first;
    } catch (JSONException e) {
      prefs(context).edit().remove(PENDING).apply();
      return null;
    }
  }
}
