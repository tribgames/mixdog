package io.mixdog.app;

import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.os.Handler;
import android.os.Looper;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.TextView;

/**
 * Brings a relay page back after a transient main-frame failure instead of
 * leaving the WebView on the browser's error page: a bundled, localized
 * "connecting" screen covers the WebView and the same URL is reloaded when the
 * backoff timer fires, a validated network appears, the app returns to the
 * foreground, or the screen's button is pressed. The decisions are
 * ReconnectState's; this class owns the timer, the network callback and the
 * views. Everything runs on the UI thread except the network callback, which
 * only posts to it.
 */
final class MixdogReconnect {
  private final MainActivity activity;
  private final ReconnectState state = new ReconnectState();
  private final Handler handler = new Handler(Looper.getMainLooper());
  // Timers and network triggers only act while the app is on screen; coming
  // back to it reloads at once (onResume).
  private boolean foreground;
  private final Runnable timer = () -> reload(state.dueReload());
  private final Runnable networkRetry = () -> {
    if (foreground) reload(state.retryNow());
  };
  private ConnectivityManager manager;
  private ConnectivityManager.NetworkCallback network;
  private View screen;
  private View spinner;
  private View button;
  private TextView title;
  private TextView sub;

  MixdogReconnect(MainActivity activity) {
    this.activity = activity;
  }

  /** A main-frame load failed with a WebViewClient.ERROR_* code. */
  void onLoadError(String url, int errorCode) {
    if (ReconnectState.isTransientError(errorCode)) fail(url);
  }

  /** A main-frame load answered with an HTTP error status. */
  void onHttpError(String url, int status) {
    if (ReconnectState.isTransientStatus(status)) fail(url);
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
    reload(state.retryNow());
    sync();
  }

  void onPause() {
    foreground = false;
    handler.removeCallbacks(timer);
    handler.removeCallbacks(networkRetry);
    unwatchNetwork();
  }

  /** Back while the screen is up leaves the failed PC like its button does. True when it did. */
  boolean onBack() {
    if (!state.active()) return false;
    chooseAnotherPc();
    return true;
  }

  /** Give up on the failed PC and open the bundled pairing screen (its saved-PC list). */
  private void chooseAnotherPc() {
    state.clear();
    sync();
    if (activity.getBridge() == null || activity.getBridge().getWebView() == null) return;
    activity.getBridge().getWebView().loadUrl(activity.getBridge().getLocalUrl() + "/?manage=1");
  }

  /** The recovery's timers, network watch and screen follow whether an episode is running. */
  private void sync() {
    if (!state.active()) {
      handler.removeCallbacks(timer);
      handler.removeCallbacks(networkRetry);
      unwatchNetwork();
    } else if (foreground) {
      watchNetwork();
    }
    render();
  }

  private void fail(String url) {
    if (!ReconnectState.isRecoverableUrl(url, MixdogOrigins.saved(activity))) return;
    long delay = state.failed(url);
    handler.removeCallbacks(timer);
    if (delay >= 0 && foreground) handler.postDelayed(timer, delay);
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

  private void watchNetwork() {
    if (network != null) return;
    manager = activity.getSystemService(ConnectivityManager.class);
    if (manager == null) return;
    ConnectivityManager.NetworkCallback callback =
        new ConnectivityManager.NetworkCallback() {
          @Override
          public void onAvailable(Network available) {
            handler.post(networkRetry);
          }
        };
    try {
      manager.registerNetworkCallback(
          new NetworkRequest.Builder()
              .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
              .addCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
              .build(),
          callback);
      network = callback;
    } catch (RuntimeException ignored) {
      // The system's callback limit is reached: the backoff and the foreground reload still work.
    }
  }

  private void unwatchNetwork() {
    if (network == null) return;
    try {
      manager.unregisterNetworkCallback(network);
    } catch (RuntimeException ignored) {
      // Already gone.
    }
    network = null;
    // An onAvailable that already posted must not reload after the watch ended.
    handler.removeCallbacks(networkRetry);
  }

  private void render() {
    boolean active = state.active();
    if (screen == null) {
      if (!active) return;
      screen = LayoutInflater.from(activity).inflate(R.layout.mixdog_reconnect, null);
      activity.addContentView(
          screen, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
      spinner = screen.findViewById(R.id.mixdog_reconnect_spinner);
      title = screen.findViewById(R.id.mixdog_reconnect_title);
      sub = screen.findViewById(R.id.mixdog_reconnect_sub);
      button = screen.findViewById(R.id.mixdog_reconnect_button);
      button.setOnClickListener(view -> reload(state.retryNow()));
      screen.findViewById(R.id.mixdog_reconnect_other).setOnClickListener(view -> chooseAnotherPc());
    }
    boolean gaveUp = state.phase() == ReconnectState.Phase.GAVE_UP;
    spinner.setVisibility(gaveUp ? View.GONE : View.VISIBLE);
    title.setText(gaveUp ? R.string.reconnect_failed : R.string.reconnect_connecting);
    sub.setText(gaveUp ? R.string.reconnect_failed_sub : R.string.reconnect_connecting_sub);
    button.setVisibility(gaveUp ? View.VISIBLE : View.GONE);
    screen.setVisibility(active ? View.VISIBLE : View.GONE);
  }
}
