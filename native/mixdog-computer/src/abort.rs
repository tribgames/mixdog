//! The release a stopped session runs from a fresh process: let go of any
//! key or button left down, undo the no-activate holds the host recorded,
//! then, when the stopped target still has the foreground, put the pointer
//! back and return focus where it was.

use crate::observer::Observer;
use crate::platform::{self, parse_window_id};

/// The marker the stopped host used (MixdogAbortCleanup.RunInput): without it
/// the receipt cannot be found, and a random one would release nothing real.
fn marker_check() -> Result<(), String> {
    if cfg!(windows) && crate::config::host_input_marker().is_none() {
        return Err("input_marker_unavailable".into());
    }
    Ok(())
}

/// The point the pointer returns to; none unless the host gave both
/// coordinates, so an absent variable never moves it to (0,0).
fn cursor_point(x: Option<&str>, y: Option<&str>) -> Option<(i32, i32)> {
    let parse = |value: Option<&str>| value?.trim().parse::<i32>().ok();
    Some((parse(x)?, parse(y)?))
}

pub fn run() -> i32 {
    let marker = marker_check();
    let released = match marker {
        Ok(()) => platform::release_owned_input(),
        Err(ref error) => Err(error.clone()),
    };
    // Independent of the release and of the target (MixdogAbortCleanup.Run,
    // backend/program.ts:109-115).
    let recovered = platform::recover_inactive_ledger();
    let target = parse_window_id(&std::env::var("MIXDOG_ABORT_TARGET").unwrap_or_default());
    let restore = parse_window_id(&std::env::var("MIXDOG_ABORT_RESTORE").unwrap_or_default());
    let cursor = cursor_point(
        std::env::var("MIXDOG_ABORT_CURSOR_X").ok().as_deref(),
        std::env::var("MIXDOG_ABORT_CURSOR_Y").ok().as_deref(),
    );
    let mut restored = Ok(());
    if target != 0 && marker.is_ok() {
        let observer = Observer::new();
        let desktop = platform::create(observer.shared.clone(), crate::config::input_marker());
        if desktop.foreground() == target {
            if let Some((x, y)) = cursor {
                restored = desktop.move_pointer(x, y);
            }
            if restore != 0 && restore != target && desktop.is_window(restore) {
                desktop.focus(restore);
            }
        }
    }
    let mut code = 0;
    for error in [released, recovered, restored].into_iter().filter_map(Result::err) {
        eprintln!("mixdog-computer abort cleanup: {error}");
        code = 1;
    }
    code
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_pointer_moves_only_to_a_given_point() {
        assert_eq!(cursor_point(Some("10"), Some(" -4 ")), Some((10, -4)));
        assert_eq!(cursor_point(None, None), None);
        assert_eq!(cursor_point(Some("10"), None), None);
        assert_eq!(cursor_point(Some("x"), Some("1")), None);
    }
}
