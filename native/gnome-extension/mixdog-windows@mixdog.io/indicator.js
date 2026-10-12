// The "Computer in use" pill, drawn by the shell itself. Unlike a client
// window it can never take keyboard focus or pointer input, which on Wayland
// is the only way to keep a status overlay from stealing focus from the very
// window an agent is typing into. Original work.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Without a refresh the pill disappears by itself, so an app that died while
// it was showing cannot leave it on screen.
const EXPIRY_SECONDS = 15;
const TOP_GAP = 8;
const ACCENT = '#58a6ff';
const PAUSED = '#6e6e73';
const ATTENTION = '#ff9f0a';

function color(value, fallback) {
    return /^#[0-9a-fA-F]{6}$/.test(value ?? '') ? value : fallback;
}

export class Indicator {
    show(spec) {
        const mark = spec.attention ? ATTENTION : spec.paused ? PAUSED : color(spec.accent, ACCENT);
        if (!this._box)
            this._build();
        this._dot.set_style(`width: 14px; height: 14px; border-radius: 7px; background-color: ${mark}; margin-right: 12px;`);
        this._title.text = String(spec.title ?? '');
        this._hint.text = String(spec.hint ?? '');
        this._hint.visible = this._hint.text !== '';
        const edge = spec.attention ? ATTENTION : '#ffffff2b';
        this._box.set_style(`background-color: #060608; border-radius: 25px; border: 1px solid ${edge}; padding: 0 20px 0 16px; height: 48px;`);
        this._place();
        this._rearm();
    }

    hide() {
        this._disarm();
        if (!this._box)
            return;
        Main.layoutManager.removeChrome(this._box);
        this._box.destroy();
        this._box = this._dot = this._title = this._hint = null;
    }

    _build() {
        // Not reactive and not focusable, and chrome that does not touch the
        // input region: clicks and keys go straight to the window below.
        this._box = new St.BoxLayout({reactive: false, can_focus: false, track_hover: false, opacity: 0});
        this._dot = new St.Widget({y_align: Clutter.ActorAlign.CENTER});
        this._title = new St.Label({y_align: Clutter.ActorAlign.CENTER, style: 'color: #f5f5f7; font-size: 15px; font-weight: 500;'});
        this._hint = new St.Label({y_align: Clutter.ActorAlign.CENTER, style: 'color: #9a9aa0; font-size: 11px; margin-left: 14px;'});
        this._box.add_child(this._dot);
        this._box.add_child(this._title);
        this._box.add_child(this._hint);
        Main.layoutManager.addChrome(this._box, {affectsInputRegion: false, affectsStruts: false, trackFullscreen: false});
        this._box.ease({opacity: 255, duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    _place() {
        const monitor = Main.layoutManager.primaryMonitor;
        const [, width] = this._box.get_preferred_width(-1);
        this._box.set_position(
            Math.round(monitor.x + (monitor.width - width) / 2),
            monitor.y + (Main.panel?.height ?? 32) + TOP_GAP);
    }

    _rearm() {
        this._disarm();
        this._expiry = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, EXPIRY_SECONDS, () => {
            this._expiry = 0;
            this.hide();
            return GLib.SOURCE_REMOVE;
        });
    }

    _disarm() {
        if (this._expiry)
            GLib.source_remove(this._expiry);
        this._expiry = 0;
    }
}
