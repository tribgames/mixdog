package io.mixdog.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import java.util.UUID;

/** Local notifications built from a decrypted push payload. */
final class MixdogNotifications {
  static final String CHANNEL_ID = "mixdog_sessions";
  static final String EXTRA_ACTION = "mx_action";
  static final String EXTRA_ACTION_ID = "mx_action_id";
  static final String EXTRA_HOST = "mx_host";
  static final String EXTRA_SESSION = "mx_session";
  static final String EXTRA_APPROVAL = "mx_approval";
  static final String EXTRA_NOTIFICATION_ID = "mx_notification_id";
  static final String REASON_APPROVAL = "approval-pending";

  private MixdogNotifications() {}

  static void ensureChannel(Context context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
    NotificationManager manager = context.getSystemService(NotificationManager.class);
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return;
    manager.createNotificationChannel(
        new NotificationChannel(CHANNEL_ID, "Sessions", NotificationManager.IMPORTANCE_HIGH));
  }

  private static PendingIntent open(
      Context context,
      int notificationId,
      String action,
      String sessionId,
      String approvalId,
      String hostId,
      int salt) {
    Intent intent =
        new Intent(context, MainActivity.class)
            .setAction("io.mixdog.app.NOTIFICATION_" + action + "_" + notificationId)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra(EXTRA_ACTION, action)
            .putExtra(EXTRA_ACTION_ID, UUID.randomUUID().toString())
            .putExtra(EXTRA_SESSION, sessionId)
            .putExtra(EXTRA_NOTIFICATION_ID, notificationId);
    if (hostId != null && !hostId.isEmpty()) intent.putExtra(EXTRA_HOST, hostId);
    if (approvalId != null && !approvalId.isEmpty()) intent.putExtra(EXTRA_APPROVAL, approvalId);
    return PendingIntent.getActivity(
        context, notificationId * 3 + salt, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
  }

  /**
   * An approval offers Deny, and Allow only when the PC said its card allows that approval once
   * with a bare Enter (`allowOnce`, desktop shared/approval-enter-rule.ts). Any other approval (a
   * payment, a permanent delete...) opens the app on it to be decided there; the PC also refuses an
   * Allow for it.
   */
  static void show(
      Context context,
      String title,
      String body,
      String sessionId,
      String reason,
      String approvalId,
      boolean allowOnce,
      String hostId) {
    ensureChannel(context);
    // One notification per session: a newer one replaces the older.
    int id = sessionId.hashCode() & 0x3fffffff;
    NotificationCompat.Builder builder =
        new NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_mixdog)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(open(context, id, "open", sessionId, null, hostId, 0));
    if (REASON_APPROVAL.equals(reason) && approvalId != null && !approvalId.isEmpty()) {
      // The card's order and words: 거절 · 한 번만 허용, in the web app's language.
      builder.addAction(
          0, MixdogPushStore.denyLabel(context), open(context, id, "deny", sessionId, approvalId, hostId, 2));
      if (allowOnce) {
        builder.addAction(
            0,
            MixdogPushStore.allowOnceLabel(context),
            open(context, id, "allow", sessionId, approvalId, hostId, 1));
      }
    }
    try {
      NotificationManagerCompat.from(context).notify(id, builder.build());
    } catch (SecurityException ignored) {
      // POST_NOTIFICATIONS not granted.
    }
  }
}
