package io.mixdog.app;

import android.content.Context;
import android.content.SharedPreferences;
import java.util.HashSet;
import java.util.Set;

/** The paired relay origins the bundled pairing screen last reported (persisted). */
final class MixdogOrigins {
  private static final String PREFS = "mixdog_origins";
  private static final String SAVED = "saved";

  private MixdogOrigins() {}

  private static SharedPreferences prefs(Context context) {
    return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
  }

  static Set<String> saved(Context context) {
    return OriginPolicy.sanitize(prefs(context).getStringSet(SAVED, new HashSet<>()));
  }

  static void save(Context context, Set<String> origins) {
    prefs(context).edit().putStringSet(SAVED, new HashSet<>(origins)).apply();
  }

  static boolean isAllowed(Context context, String url) {
    return OriginPolicy.isAllowed(url, saved(context));
  }
}
