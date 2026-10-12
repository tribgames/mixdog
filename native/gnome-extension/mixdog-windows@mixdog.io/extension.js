// Mixdog Windows: window list and window control for Mixdog Computer Use.
// Exports io.mixdog.Windows at /io/mixdog/Windows on the shell's own session
// bus connection (so it is reachable as org.gnome.Shell). Original work.
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const OBJECT_PATH = '/io/mixdog/Windows';
const VERSION = 1;

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
}

export default class MixdogWindows extends Extension {
    enable() {
        this._exported = Gio.DBusExportedObject.wrapJSObject(INTERFACE_XML, new Windows());
        this._exported.export(Gio.DBus.session, OBJECT_PATH);
    }

    disable() {
        this._exported?.unexport();
        this._exported = null;
    }
}