export const DESKTOP_SIDEBAR_MIN_WIDTH = 232;
export const DESKTOP_WORKSPACE_MIN_WIDTH = 360;
export const DESKTOP_UTILITY_DOCK_MIN_WIDTH = 300;

/* Full-responsive shell (user decision): the desktop window narrows through
   the same bands the remote web/APK surfaces use — the dock becomes an
   overlay sheet below the aggregate pane floor (≤940px CSS) and the phone
   composition takes over at ≤760px. The OS floor therefore only guards a
   usable phone-width column instead of summing every pane's floor. */
export const DESKTOP_WINDOW_MIN_WIDTH = 360;
