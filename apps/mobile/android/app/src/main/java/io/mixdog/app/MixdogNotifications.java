package io.mixdog.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

/** Local notifications built from a decrypted push payload. */
final class MixdogNotifications {
  static final String CHANNEL_ID = "mixdog_sessions";
  static final String EXTRA_ACTION = "mx_action";
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
      Context context, int notificationId, String action, String sessionId, String approvalId, int salt) {
    Intent intent =
        new Intent(context, MainActivity.class)
            .setAction("io.mixdog.app.NOTIFICATION_" + action + "_" + notificationId)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra(EXTRA_ACTION, action)
            .putExtra(EXTRA_SESSION, sessionId)
            .putExtra(EXTRA_NOTIFICATION_ID, notificationId);
    if (approvalId != null && !approvalId.isEmpty()) intent.putExtra(EXTRA_APPROVAL, approvalId);
    return PendingIntent.getActivity(
        context, notificationId * 3 + salt, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
  }

  static void show(
      Context context, String title, String body, String sessionId, String reason, String approvalId) {
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
            .setContentIntent(open(context, id, "open", sessionId, null, 0));
    if (REASON_APPROVAL.equals(reason) && approvalId != null && !approvalId.isEmpty()) {
      builder.addAction(0, "Allow", open(context, id, "allow", sessionId, approvalId, 1));
      builder.addAction(0, "Deny", open(context, id, "deny", sessionId, approvalId, 2));
    }
    try {
      NotificationManagerCompat.from(context).notify(id, builder.build());
    } catch (SecurityException ignored) {
      // POST_NOTIFICATIONS not granted.
    }
  }
}
