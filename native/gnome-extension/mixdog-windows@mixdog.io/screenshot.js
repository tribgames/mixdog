// Screenshots taken inside the shell process (Shell.Screenshot), so no desktop
// portal is involved and nothing is ever prompted. Original work.
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';

Gio._promisify(Shell.Screenshot.prototype, 'screenshot', 'screenshot_finish');
Gio._promisify(Shell.Screenshot.prototype, 'screenshot_area', 'screenshot_area_finish');
Gio._promisify(Shell.Screenshot, 'composite_to_stream');

/**
 * Writes a PNG of the whole stage, an area of it, or one window (as the
 * compositor draws it, even when other windows cover it) to `path`.
 * @param {{kind: 'stage'|'area'|'window', x: number, y: number, width: number, height: number, window: object|null}} target
 * @param {string} path
 */
export async function writeScreenshot(target, path) {
    const stream = Gio.File.new_for_path(path).replace(null, false, Gio.FileCreateFlags.PRIVATE, null);
    try {
        if (target.kind === 'window') {
            await windowToStream(target.window, stream);
        } else {
            const screenshot = new Shell.Screenshot();
            if (target.kind === 'area')
                await screenshot.screenshot_area(target.x, target.y, target.width, target.height, stream);
            else
                await screenshot.screenshot(false, stream);
        }
    } finally {
        stream.close(null);
    }
}

async function windowToStream(window, stream) {
    const actor = window.get_compositor_private();
    if (!actor)
        throw new Error('window has no surface');
    const content = actor.paint_to_content(null);
    if (!content)
        throw new Error('window could not be painted');
    const texture = content.get_texture();
    const frame = window.get_frame_rect();
    const buffer = window.get_buffer_rect();
    await Shell.Screenshot.composite_to_stream(
        texture, frame.x - buffer.x, frame.y - buffer.y, frame.width, frame.height, 1,
        null, 0, 0, 1, stream);
}
