// Test-only: the Linux Computer Use preflight refuses to run without a graphical session, and CI runners are headless. A DISPLAY makes the preflight see an X11 session (no uinput/window-control blockers) so the client tests exercise the bridge, not the preflight (covered by linux-readiness.test.mjs).
process.env.DISPLAY ||= ':99';
// The AT-SPI probe asks the session bus; a CI bus must not turn into a missing-accessibility refusal.
delete process.env.DBUS_SESSION_BUS_ADDRESS;
process.env.XDG_RUNTIME_DIR = '/nonexistent-mixdog-test';
