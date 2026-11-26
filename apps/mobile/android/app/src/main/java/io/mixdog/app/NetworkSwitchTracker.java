package io.mixdog.app;

/**
 * Pure-JDK tracker for active-network transitions and internet validation while the app is on
 * screen. Ignores the initial callback's network switch, reports {@code networkSwitched} on
 * handle/transport changes or return after loss, and reports {@code internetValidated} when a
 * network gains validated internet access (including on the same network after upstream recovery).
 */
final class NetworkSwitchTracker {
  static final int TRANSPORT_WIFI = 1 << 0;
  static final int TRANSPORT_CELLULAR = 1 << 1;
  static final int TRANSPORT_ETHERNET = 1 << 2;
  static final int TRANSPORT_VPN = 1 << 3;

  static final class Update {
    final boolean networkSwitched;
    final boolean internetValidated;

    Update(boolean networkSwitched, boolean internetValidated) {
      this.networkSwitched = networkSwitched;
      this.internetValidated = internetValidated;
    }
  }

  private boolean initialized;
  private boolean lost;
  private long activeHandle;
  private int activeTransports;
  private boolean activeValidated;

  /** A network became the active default network. */
  Update onAvailable(long handle, int transports, boolean validated) {
    return update(handle, transports, validated, false);
  }

  /** Capabilities updated for the active network. */
  Update onCapabilitiesChanged(long handle, int transports, boolean validated) {
    return update(handle, transports, validated, true);
  }

  private Update update(
      long handle, int transports, boolean validated, boolean capabilitiesAuthoritative) {
    if (!initialized) {
      initialized = true;
      lost = false;
      activeHandle = handle;
      activeTransports = transports;
      activeValidated = validated;
      return new Update(false, validated);
    }
    boolean handleChanged = handle != activeHandle;
    boolean transportChanged =
        !handleChanged
            && !lost
            && transports != 0
            && activeTransports != 0
            && transports != activeTransports;
    boolean switched = lost || handleChanged || transportChanged;
    boolean becameValidated = validated && (switched || !activeValidated);
    boolean replaced = handleChanged || lost;
    lost = false;
    activeHandle = handle;
    if (replaced || transports != 0) activeTransports = transports;
    if (replaced || capabilitiesAuthoritative || validated) activeValidated = validated;
    return new Update(switched, becameValidated);
  }

  /** A network was lost. Marks the tracker so the next available network counts as a switch. */
  void onLost(long handle) {
    if (initialized && handle == activeHandle) {
      lost = true;
      activeValidated = false;
    }
  }

  /** Forget tracked state when leaving the foreground. */
  void reset() {
    initialized = false;
    lost = false;
    activeHandle = 0;
    activeTransports = 0;
    activeValidated = false;
  }
}
