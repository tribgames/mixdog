package io.mixdog.app;

import java.util.Set;

/**
 * Whether a top-level (main frame) request may proceed. shouldOverrideUrlLoading
 * is not called for POST navigations, so MixdogWebViewClient applies the same
 * rule to shouldInterceptRequest and onPageStarted (final URL after redirects).
 * Pure JDK; pinned by npm run test:java.
 */
final class NavigationPolicy {
  private NavigationPolicy() {}

  static boolean allowMainFrame(String url, Set<String> saved) {
    return OriginPolicy.isAllowed(url, saved);
  }
}
