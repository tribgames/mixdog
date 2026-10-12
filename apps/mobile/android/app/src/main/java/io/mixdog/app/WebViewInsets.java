package io.mixdog.app;

/** WebView margins for an edge-to-edge window (pure JDK, unit-checked). */
final class WebViewInsets {
  private WebViewInsets() {}

  /**
   * {left, top, right, bottom}: the system bars and display cutout on every
   * side; at the bottom the soft keyboard when it is taller. The keyboard
   * covers the navigation bar rather than stacking on it, so the two never add.
   */
  static int[] margins(int left, int top, int right, int bottom, int imeBottom) {
    return new int[] {left, top, right, Math.max(bottom, imeBottom)};
  }
}
