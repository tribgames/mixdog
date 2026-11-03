package io.mixdog.app;

import java.util.HashSet;
import java.util.Set;

/**
 * What the app does when the main-frame load of a relay page fails (Wi-Fi/LTE
 * switch, resume after a long background, relay restart, DNS hiccup): the
 * bundled "connecting" screen stays up and the same URL is reloaded after a
 * bounded backoff, at once when the network returns or the app comes back to
 * the foreground, and on the screen's button once the backoff gave up. Only an
 * allowed relay URL is ever reloaded (NavigationPolicy) and a genuine 4xx or a
 * blocked redirect never schedules anything. Pure JDK (no Android types),
 * pinned by npm run test:java; MixdogReconnect owns the timers and the views.
 */
final class ReconnectState {
  enum Phase {
    /** Nothing failed (or the page came back). */
    IDLE,
    /** Failed; the backoff timer is running. */
    WAITING,
    /** A reload this class asked for is in flight. */
    LOADING,
    /** The backoff ran out (or the reload was refused): only the button retries. */
    GAVE_UP
  }

  static final long FIRST_DELAY_MS = 2_000;
  static final long MAX_DELAY_MS = 30_000;
  /** Automatic reloads per failure episode: 2s, 4s, 8s, 16s, then 30s each (about 2.5 minutes). */
  static final int MAX_RELOADS = 8;

  private Phase phase = Phase.IDLE;
  private String url = "";
  private int reloads;
  // The reload's own onPageStarted was seen: an onPageFinished before it is the
  // failed page's error screen finishing late, not the reload succeeding.
  private boolean started;
  // Origins this episode's own loads run on (the failing URL and its redirect
  // targets): a navigation to any other origin is someone else's, and ends the episode.
  private final Set<String> origins = new HashSet<>();

  /** Wait before the next automatic reload, given how many reloads already ran. */
  static long delayMs(int reloads) {
    return Math.min(MAX_DELAY_MS, FIRST_DELAY_MS << Math.min(Math.max(reloads, 0), 10));
  }

  /**
   * WebViewClient.ERROR_* (main frame) that waiting can fix. net::ERR_FAILED is
   * ERROR_UNKNOWN: it is what a service worker's rejected navigation fetch
   * looks like, so a plain network failure arrives under that code.
   */
  static boolean isTransientError(int errorCode) {
    switch (errorCode) {
      case -1: // ERROR_UNKNOWN
      case -2: // ERROR_HOST_LOOKUP
      case -6: // ERROR_CONNECT
      case -7: // ERROR_IO
      case -8: // ERROR_TIMEOUT
      case -11: // ERROR_FAILED_SSL_HANDSHAKE
      case -15: // ERROR_TOO_MANY_REQUESTS
        return true;
      default:
        return false;
    }
  }

  /** A gateway answering for a restarting relay. Any 4xx (or other 5xx) is the relay's real answer. */
  static boolean isTransientStatus(int status) {
    return status == 502 || status == 503 || status == 504;
  }

  /** A relay page the navigation policy allows; the bundled screen has no network to wait for. */
  static boolean isRecoverableUrl(String url, Set<String> saved) {
    return NavigationPolicy.allowMainFrame(url, saved) && !OriginPolicy.isBundled(OriginPolicy.originOf(url));
  }

  Phase phase() {
    return phase;
  }

  String url() {
    return url;
  }

  boolean active() {
    return phase != Phase.IDLE;
  }

  /**
   * A transient main-frame failure of an allowed relay URL. The reload target
   * is the first URL of the episode. Returns the wait before the next automatic
   * reload, or -1 once the backoff is spent (the button takes over).
   */
  long failed(String failedUrl) {
    if (phase == Phase.IDLE) {
      url = failedUrl;
      reloads = 0;
    }
    origins.add(OriginPolicy.originOf(failedUrl));
    if (reloads >= MAX_RELOADS) {
      phase = Phase.GAVE_UP;
      return -1;
    }
    phase = Phase.WAITING;
    return delayMs(reloads);
  }

  /** The backoff timer fired: the URL to reload, or null if the state moved on. */
  String dueReload() {
    return phase == Phase.WAITING ? startReload() : null;
  }

  /**
   * The network returned, the app is in the foreground, or the user pressed
   * the button: reload now with a fresh backoff. Null when nothing is waiting
   * (a reload already in flight is left alone).
   */
  String retryNow() {
    if (phase != Phase.WAITING && phase != Phase.GAVE_UP) return null;
    reloads = 0;
    return startReload();
  }

  private String startReload() {
    phase = Phase.LOADING;
    reloads++;
    started = false;
    return url;
  }

  /** The reload redirected off the allowed origins and was stopped: not retried by itself. */
  void blocked(String blockedUrl) {
    if (phase != Phase.LOADING || OriginPolicy.originOf(blockedUrl) == null) return;
    phase = Phase.GAVE_UP;
    reloads = MAX_RELOADS;
  }

  /** A URL with no origin (about:blank, null) is not a navigation anyone chose. */
  private boolean foreign(String navigatedUrl) {
    String origin = OriginPolicy.originOf(navigatedUrl);
    return origin != null && !origins.contains(origin);
  }

  /**
   * A main-frame load began (allowed URL). While the reload is in flight, a
   * start on the episode's own origin is that reload. Anything else — another
   * origin, or any page starting while nothing of ours is loading — is a
   * navigation somewhere else (the pairing screen, say) and ends the episode.
   * True when the episode ended: the timer, the network watch and the screen go.
   */
  boolean pageStarted(String startedUrl) {
    if (phase == Phase.IDLE || OriginPolicy.originOf(startedUrl) == null) return false;
    if (phase == Phase.LOADING && !foreign(startedUrl)) {
      started = true;
      return false;
    }
    clear();
    return true;
  }

  /**
   * A load finished. True when the episode ended: the reload succeeded, or the
   * page that finished is on another origin (a navigation that was not ours).
   */
  boolean pageFinished(String finishedUrl) {
    // A finish with no origin (null, about:blank, the error document) says nothing about the load.
    if (phase == Phase.IDLE || OriginPolicy.originOf(finishedUrl) == null) return false;
    if (!foreign(finishedUrl) && (phase != Phase.LOADING || !started)) return false;
    clear();
    return true;
  }

  /** Forget the episode (the page is back, the URL is no longer allowed, or the user chose elsewhere). */
  void clear() {
    phase = Phase.IDLE;
    url = "";
    reloads = 0;
    started = false;
    origins.clear();
  }
}
