package io.mixdog.app;

import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;

/**
 * Brings a relay page back after a main-frame failure instead of leaving the WebView on the
 * browser's error page: the app's empty background (no text, no spinner) covers the WebView and the
 * same URL is reloaded when the backoff timer fires, a validated network appears, or the app
 * returns to the foreground; Back leaves for the pairing screen. The decisions are
 * ReconnectState's; this class owns the timer, the network callback and the cover. Everything runs
 * on the UI thread except the network callback, which only posts to it.
 */
final class MixdogReconnect {
  private final MainActivity activity;
  private final ReconnectState state = new ReconnectState();
  private final NetworkSwitchTracker networkTracker = new NetworkSwitchTracker();
  private final Handler handler = new Handler(Looper.getMainLooper());
  // Timers and network triggers only act while the app is on screen; coming
  // back to it reloads at once (onResume).
  private boolean foreground;
  private int networkEpoch;
  private final Runnable timer = () -> reload(state.dueReload());
  private ConnectivityManager manager;
  private ConnectivityManager.NetworkCallback network;
  private View cover;

  MixdogReconnect(MainActivity activity) {
    this.activity = activity;
  }

  /**
   * A main-frame load failed with a WebViewClient.ERROR_* code: whatever it was, its error page is
   * never shown.
   */
  void onLoadError(String url, int errorCode) {
    fail(url, ReconnectState.isTransientError(errorCode));
  }

  /** A main-frame load answered with an HTTP error status. */
  void onHttpError(String url, int status) {
    if (ReconnectState.isTransientStatus(status)) fail(url, true);
  }

  /** A main-frame load began: our own reload, or a navigation that ends the recovery. */
  void onPageStarted(String url) {
    if (state.pageStarted(url)) sync();
  }

  /** A main-frame load was redirected off the allowed origins and stopped. */
  void onBlocked(String url) {
    state.blocked(url);
    sync();
  }

  void onPageFinished(String url) {
    if (state.pageFinished(url)) sync();
  }

  void onResume() {
    foreground = true;
    watchNetwork();
    reload(state.retryNow());
    sync();
  }

  void onPause() {
    foreground = false;
    handler.removeCallbacks(timer);
    unwatchNetwork();
  }

  /** Back while the cover is up leaves the failed PC. True when it did. */
  boolean onBack() {
    if (!state.active()) return false;
    chooseAnotherPc();
    return true;
  }

  /** Give up on the failed PC and open the bundled pairing screen (its saved-PC list). */
  void chooseAnotherPc() {
    state.clear();
    sync();
    activity.openHostPicker();
  }

  /**
   * The recovery's timers and cover follow whether an episode is running; the network watch stays
   * active while foregrounded.
   */
  private void sync() {
    if (!state.active()) {
      handler.removeCallbacks(timer);
    }
    if (foreground) watchNetwork();
    render();
  }

  private void fail(String url, boolean waitable) {
    if (!ReconnectState.isRecoverableUrl(url, MixdogOrigins.saved(activity))) return;
    handler.removeCallbacks(timer);
    if (waitable) {
      long delay = state.failed(url);
      if (delay >= 0 && foreground) handler.postDelayed(timer, delay);
    } else {
      state.failedPermanently(url);
    }
    sync();
  }

  /** Load the URL a state transition handed back (null: nothing was waiting). */
  private void reload(String url) {
    if (url == null) return;
    handler.removeCallbacks(timer);
    WebView webView = activity.getBridge() == null ? null : activity.getBridge().getWebView();
    // The allow-list is checked again: it may have changed since the failure.
    if (webView == null || !ReconnectState.isRecoverableUrl(url, MixdogOrigins.saved(activity))) {
      state.clear();
      sync();
      return;
    }
    render();
    webView.loadUrl(url);
  }

  private static int transportsOf(NetworkCapabilities caps) {
    if (caps == null) return 0;
    int mask = 0;
    if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI))
      mask |= NetworkSwitchTracker.TRANSPORT_WIFI;
    if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR))
      mask |= NetworkSwitchTracker.TRANSPORT_CELLULAR;
    if (caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET))
      mask |= NetworkSwitchTracker.TRANSPORT_ETHERNET;
    if (caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN))
      mask |= NetworkSwitchTracker.TRANSPORT_VPN;
    return mask;
  }

  private static boolean isValidated(NetworkCapabilities caps) {
    return caps != null
        && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
        && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
  }

  private void handleNetworkUpdate(NetworkSwitchTracker.Update update) {
    if (state.active()) {
      if (update.internetValidated) reload(state.retryNow());
    } else if (update.networkSwitched) {
      activity.notifyNetworkChanged();
    }
  }

  private void watchNetwork() {
    if (network != null) return;
    manager = activity.getSystemService(ConnectivityManager.class);
    if (manager == null) return;
    networkTracker.reset();
    final int epoch = ++networkEpoch;
    ConnectivityManager.NetworkCallback callback =
        new ConnectivityManager.NetworkCallback() {
          @Override
          public void onAvailable(Network available) {
            long handle = available.getNetworkHandle();
            NetworkCapabilities caps = manager.getNetworkCapabilities(available);
            int transports = transportsOf(caps);
            boolean validated = isValidated(caps);
            handler.post(() -> {
              if (!foreground || epoch != networkEpoch) return;
              handleNetworkUpdate(networkTracker.onAvailable(handle, transports, validated));
            });
          }

          @Override
          public void onCapabilitiesChanged(Network available, NetworkCapabilities caps) {
            long handle = available.getNetworkHandle();
            int transports = transportsOf(caps);
            boolean validated = isValidated(caps);
            handler.post(() -> {
              if (!foreground || epoch != networkEpoch) return;
              handleNetworkUpdate(
                  networkTracker.onCapabilitiesChanged(handle, transports, validated));
            });
          }

          @Override
          public void onLost(Network lost) {
            long handle = lost.getNetworkHandle();
            handler.post(() -> {
              if (epoch != networkEpoch) return;
              networkTracker.onLost(handle);
            });
          }
        };
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
        manager.registerDefaultNetworkCallback(callback);
      } else {
        manager.registerNetworkCallback(
            new NetworkRequest.Builder()
                .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .build(),
            callback);
      }
      network = callback;
    } catch (RuntimeException ignored) {
      // The system's callback limit is reached: the backoff and the foreground reload still work.
    }
  }

  private void unwatchNetwork() {
    networkEpoch++;
    networkTracker.reset();
    if (network == null) return;
    try {
      manager.unregisterNetworkCallback(network);
    } catch (RuntimeException ignored) {
      // Already gone.
    }
    network = null;
  }

  private void render() {
    boolean active = state.active();
    if (cover == null) {
      if (!active) return;
      cover = LayoutInflater.from(activity).inflate(R.layout.mixdog_reconnect, null);
      activity.addContentView(
          cover,
          new ViewGroup.LayoutParams(
              ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }
    cover.setVisibility(active ? View.VISIBLE : View.GONE);
  }
}
