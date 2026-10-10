package io.mixdog.app;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Which origins may load in the WebView and talk to the native bridge: the
 * bundled pairing screen and the relay origins of paired hosts. Pure JDK; the
 * same rules as apps/mobile/src/origins.ts, pinned by
 * test-vectors/origin-policy.json (npm run test:java).
 */
final class OriginPolicy {
  static final Set<String> BUNDLED =
      new HashSet<>(Arrays.asList("https://localhost", "capacitor://localhost"));
  static final int MAX_ORIGINS = 32;

  private static final Pattern ORIGIN =
      Pattern.compile(
          "^([a-z][a-z0-9+.-]*)://(\\[[0-9a-f:]+\\]|[^/?#:@\\[\\]\\s]+)(?::(\\d+))?(?:[/?#]|$)",
          Pattern.CASE_INSENSITIVE);
  private static final Set<String> LOOPBACK =
      new HashSet<>(Arrays.asList("localhost", "127.0.0.1", "[::1]"));

  private OriginPolicy() {}

  /** scheme://host[:port], lower-case, default port dropped; null if not an http(s)/bundled URL. */
  static String originOf(String url) {
    if (url == null) return null;
    Matcher match = ORIGIN.matcher(url.trim());
    if (!match.find()) return null;
    String scheme = match.group(1).toLowerCase(Locale.ROOT);
    String host = match.group(2).toLowerCase(Locale.ROOT);
    String portText = match.group(3);
    if (scheme.equals("capacitor")) {
      return host.equals("localhost") && portText == null ? "capacitor://localhost" : null;
    }
    if (!scheme.equals("https") && !scheme.equals("http")) return null;
    String port = "";
    if (portText != null) {
      int value;
      try {
        value = Integer.parseInt(portText);
      } catch (NumberFormatException e) {
        return null;
      }
      if (value != (scheme.equals("https") ? 443 : 80)) port = ":" + value;
    }
    return scheme + "://" + host + port;
  }

  static boolean isBundled(String origin) {
    return origin != null && BUNDLED.contains(origin);
  }

  /** https, or http on a loopback host. */
  static boolean isRemoteOrigin(String origin) {
    if (origin == null) return false;
    Matcher match = ORIGIN.matcher(origin);
    if (!match.find()) return false;
    String scheme = match.group(1).toLowerCase(Locale.ROOT);
    if (scheme.equals("https")) return true;
    return scheme.equals("http") && LOOPBACK.contains(match.group(2).toLowerCase(Locale.ROOT));
  }

  static Set<String> sanitize(Collection<?> list) {
    List<String> out = new ArrayList<>();
    if (list != null) {
      for (Object item : list) {
        String origin = originOf(item == null ? null : String.valueOf(item));
        if (isRemoteOrigin(origin) && !BUNDLED.contains(origin) && !out.contains(origin)) out.add(origin);
        if (out.size() >= MAX_ORIGINS) break;
      }
    }
    return new HashSet<>(out);
  }

  static boolean isAllowed(String url, Set<String> saved) {
    String origin = originOf(url);
    return origin != null && (BUNDLED.contains(origin) || saved.contains(origin));
  }
}
