//! `Ensure-PowerPointChartWindow`: a chart is made in a document window, and a deck opened in the background has none.

use crate::com::Error;
use crate::com::Result;
use crate::com::Value as Com;
use crate::office::Env;
use crate::ppt::long_cast;

use super::attempt;
use super::count;
use super::i4;

/// Where a background window is moved to before it is hidden, and how often it is hidden again while it stays visible.
const HIDDEN_POSITION: i32 = -32000;
const HIDE_ATTEMPTS: u32 = 20;
const HIDE_PAUSE_MS: u32 = 25;

/// `try { [long]$value.Member } catch { 0 }`.
fn handle_of(owner: &Com, member: &str) -> i64 {
    owner.member(member).and_then(|handle| long_cast(&handle)).unwrap_or(0)
}

/// `Ensure-PowerPointChartWindow`: where the deck has no window, a new minimised one when UI activation is allowed. Otherwise
/// the application and a new window are moved to -32000 and minimised, the window is hidden by its handle and checked 20 x 25 ms,
/// and a window that cannot be established as hidden is closed before the chart is made.
pub(crate) fn ensure_chart_window(env: &Env<'_>, presentation: &Com, allow_ui_activation: bool) -> Result<()> {
    if count(&presentation.member("Windows")?)? > 0 {
        return Ok(());
    }
    if allow_ui_activation {
        let window = presentation.call_member("NewWindow", &[])?;
        attempt(|| window.set_member("WindowState", i4(2)));
        return Ok(());
    }
    let app = presentation.member("Application")?;
    attempt(|| {
        app.set_member("Left", i4(HIDDEN_POSITION))?;
        app.set_member("Top", i4(HIDDEN_POSITION))?;
        app.set_member("WindowState", i4(2))
    });
    let window = presentation.call_member("NewWindow", &[])?;
    attempt(|| {
        window.set_member("Left", i4(HIDDEN_POSITION))?;
        window.set_member("Top", i4(HIDDEN_POSITION))?;
        window.set_member("WindowState", i4(2))
    });
    // PowerPoint has no window handle to give until the new window exists on its side ("member not found" before that): the
    // script host reached this line later than a compiled one does, so the read is repeated for as long as the hiding below is.
    let read = || {
        let mut handle = handle_of(&window, "HWND");
        if handle == 0 {
            handle = handle_of(&app, "HWND");
        }
        if handle == 0 {
            handle = handle_of(&app, "Hwnd");
        }
        handle
    };
    let mut handle = read();
    let mut waits = 0;
    while handle == 0 && waits < HIDE_ATTEMPTS {
        env.platform.sleep(HIDE_PAUSE_MS);
        handle = read();
        waits += 1;
    }
    if handle == 0 {
        attempt(|| window.call_member("Close", &[]).map(|_| ()));
        return Err(Error::host("Background PowerPoint chart creation could not establish a verifiably hidden document window."));
    }
    env.platform.hide_window(handle);
    let mut attempts = 0;
    while attempts < HIDE_ATTEMPTS && env.platform.window_visible(handle) {
        env.platform.sleep(HIDE_PAUSE_MS);
        env.platform.hide_window(handle);
        attempts += 1;
    }
    if env.platform.window_visible(handle) {
        attempt(|| window.call_member("Close", &[]).map(|_| ()));
        return Err(Error::host("Background PowerPoint chart window remained visible and was closed before chart creation."));
    }
    Ok(())
}
