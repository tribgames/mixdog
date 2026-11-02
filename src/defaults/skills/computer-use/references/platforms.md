# Platform notes

- macOS: `cmd` is the Command key. Mixdog needs the Accessibility and Screen
  Recording permissions; a permission failure is for the user to grant, and
  `diagnose` confirms the cause.
- Linux Wayland: there is no background pixel input. Pointer and keys need
  write access to `/dev/uinput`. Window control needs a compositor that exposes
  it (sway, Hyprland, or GNOME with Mixdog's own shell extension, which the app
  sets up). Prefer accessibility refs there.
- `foreground_unavailable` (Windows foreground lock, a Wayland compositor
  without window control) means the system refused to activate the target; it
  is not a permission error unless `diagnose` says so.
