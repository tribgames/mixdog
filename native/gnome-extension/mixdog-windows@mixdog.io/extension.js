// Mixdog Windows: window list and window control for Mixdog Computer Use.
// Exports io.mixdog.Windows at /io/mixdog/Windows on the shell's own session
// bus connection (so it is reachable as org.gnome.Shell). Original work.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Indicator} from './indicator.js';
import {writeScreenshot} from './screenshot.js';

const OBJECT_PATH = '/io/mixdog/Windows';
const VERSION = 3;
// The emergency stop chord: Electron cannot register global shortcuts on Wayland.
const STOP_ACCELERATOR = '<Control><Alt>Escape';
const CYCLE_PANELS = 'cycle-panels';

const INTERFACE_XML = `
<node>
  <interface name="io.mixdog.Windows">
    <property name="Version" type="u" access="read"/>
    <method name="List"><arg type="s" direction="out" name="windows"/></method>
    <method name="Activate"><arg type="t" direction="in" name="id"/></method>
    <method name="MoveResize">
      <arg type="t" direction="in" name="id"/>
      <arg type="i" direction="in" name="x"/>
      <arg type="i" direction="in" name="y"/>
      <arg type="u" direction="in" name="width"/>
      <arg type="u" direction="in" name="height"/>
    </method>
    <method name="Minimize"><arg type="t" direction="in" name="id"/></method>
    <method name="Unminimize"><arg type="t" direction="in" name="id"/></method>
    <method name="Maximize"><arg type="t" direction="in" name="id"/></method>
    <method name="Unmaximize"><arg type="t" direction="in" name="id"/></method>
    <method name="Close"><arg type="t" direction="in" name="id"/></method>
    <method name="Screenshot">
      <arg type="s" direction="in" name="kind"/>
      <arg type="t" direction="in" name="id"/>
      <arg type="i" direction="in" name="x"/>
      <arg type="i" direction="in" name="y"/>
      <arg type="u" direction="in" name="width"/>
      <arg type="u" direction="in" name="height"/>
      <arg type="s" direction="in" name="path"/>
      <arg type="s" direction="out" name="written"/>
    </method>
    <method name="SetIndicator"><arg type="s" direction="in" name="spec"/></method>
    <signal name="StopRequested"/>
  </interface>
</node>`;

const LISTED_TYPES = new Set([Meta.WindowType.NORMAL, Meta.WindowType.DIALOG, Meta.WindowType.MODAL_DIALOG]);

function allWindows() {
    return global.get_window_actors().map(actor => actor.meta_window).filter(window => window && LISTED_TYPES.has(window.get_window_type()));
}

function findWindow(id) {
    const window = allWindows().find(candidate => candidate.get_id() === id);
    if (!window)
        throw new Error(`no window with id ${id}`);
    return window;
}

function isMaximized(window) {
    if (typeof window.is_maximized === 'function')
        return window.is_maximized();
    return window.get_maximized() === Meta.MaximizeFlags.BOTH;
}

function describe(window) {
    const rect = window.get_frame_rect();
    return {
        id: window.get_id(),
        title: window.get_title() ?? '',
        app: window.get_wm_class() ?? '',
        pid: window.get_pid(),
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        focus: window.has_focus(),
        minimized: window.minimized,
        maximized: isMaximized(window),
        workspace: window.is_on_all_workspaces() ? -1 : (window.get_workspace()?.index() ?? -1),
    };
}

class Windows {
    constructor() {
        this._indicator = new Indicator();
    }

    destroy() {
        this._indicator.hide();
    }

    // spec: {visible, title, hint, accent, paused, attention}. The pill hides
    // itself unless the app keeps refreshing it.
    SetIndicator(json) {
        const spec = JSON.parse(json);
        if (spec.visible)
            this._indicator.show(spec);
        else
            this._indicator.hide();
    }

    get Version() {
        return VERSION;
    }

    List() {
        return JSON.stringify(allWindows().map(describe));
    }

    Activate(id) {
        Main.activateWindow(findWindow(id));
    }

    MoveResize(id, x, y, width, height) {
        const window = findWindow(id);
        if (window.minimized)
            window.unminimize();
        if (isMaximized(window))
            window.unmaximize(Meta.MaximizeFlags.BOTH);
        window.move_resize_frame(true, x, y, width, height);
    }

    Minimize(id) {
        findWindow(id).minimize();
    }

    Unminimize(id) {
        findWindow(id).unminimize();
    }

    Maximize(id) {
        findWindow(id).maximize(Meta.MaximizeFlags.BOTH);
    }

    Unmaximize(id) {
        findWindow(id).unmaximize(Meta.MaximizeFlags.BOTH);
    }

    Close(id) {
        findWindow(id).delete(global.get_current_time());
    }

    // kind: "stage" (everything), "area" (x, y, width, height) or "window" (id).
    async ScreenshotAsync([kind, id, x, y, width, height, path], invocation) {
        try {
            if (kind !== 'stage' && kind !== 'area' && kind !== 'window')
                throw new Error(`unknown screenshot kind ${kind}`);
            const window = kind === 'window' ? findWindow(id) : null;
            await writeScreenshot({kind, x, y, width, height, window}, path);
            invocation.return_value(new GLib.Variant('(s)', [path]));
        } catch (error) {
            invocation.return_dbus_error('io.mixdog.Windows.Error', String(error?.message ?? error));
        }
    }
}

export default class MixdogWindows extends Extension {
    enable() {
        this._windows = new Windows();
        this._exported = Gio.DBusExportedObject.wrapJSObject(INTERFACE_XML, this._windows);
        this._exported.export(Gio.DBus.session, OBJECT_PATH);
        this._grabStopAccelerator();
    }

    disable() {
        this._releaseStopAccelerator();
        this._exported?.unexport();
        this._exported = null;
        this._windows?.destroy();
        this._windows = null;
    }

    // Ctrl+Alt+Esc is handled in the compositor, so it works whichever window
    // has focus; the app listens for StopRequested and stops the running task.
    // GNOME binds that chord to "cycle-panels" (a legacy action the shell does
    // not use), which makes a plain grab fail, so its handler is taken over.
    _grabStopAccelerator() {
        const stop = () => this._exported?.emit_signal('StopRequested', null);
        this._accelerator = global.display.grab_accelerator(STOP_ACCELERATOR, Meta.KeyBindingFlags.NONE);
        if (this._accelerator !== Meta.KeyBindingFlags.NONE) {
            Main.wm.allowKeybinding(Meta.external_binding_name_for_action(this._accelerator), Shell.ActionMode.ALL);
            this._acceleratorSignal = global.display.connect('accelerator-activated', (_display, action) => {
                if (action === this._accelerator)
                    stop();
            });
            return;
        }
        const bound = new Gio.Settings({schema_id: 'org.gnome.desktop.wm.keybindings'}).get_strv(CYCLE_PANELS);
        if (bound.includes(STOP_ACCELERATOR)) {
            Main.wm.setCustomKeybindingHandler(CYCLE_PANELS, Shell.ActionMode.ALL, stop);
            this._tookCyclePanels = true;
        }
    }

    _releaseStopAccelerator() {
        if (this._acceleratorSignal)
            global.display.disconnect(this._acceleratorSignal);
        if (this._accelerator)
            global.display.ungrab_accelerator(this._accelerator);
        if (this._tookCyclePanels)
            Main.wm.setCustomKeybindingHandler(CYCLE_PANELS, Shell.ActionMode.ALL, () => {});
        this._acceleratorSignal = 0;
        this._accelerator = 0;
        this._tookCyclePanels = false;
    }
}