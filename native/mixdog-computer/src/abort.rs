//! The release a stopped session runs from a fresh process: let go of any
//! key or button left down, then, when the stopped target still has the
//! foreground, put the pointer back and return focus where it was.

use crate::observer::Observer;
use crate::platform::{self, parse_window_id};

pub fn run() -> i32 {
    let released = platform::release_owned_input();
    let target = parse_window_id(&std::env::var("MIXDOG_ABORT_TARGET").unwrap_or_default());
    let restore = parse_window_id(&std::env::var("MIXDOG_ABORT_RESTORE").unwrap_or_default());
    let number = |name: &str| std::env::var(name).ok().and_then(|value| value.trim().parse::<i32>().ok()).unwrap_or(0);
    let (x, y) = (number("MIXDOG_ABORT_CURSOR_X"), number("MIXDOG_ABORT_CURSOR_Y"));
    let mut restored = Ok(());
    if target != 0 {
        let observer = Observer::new();
        let desktop = platform::create(observer.shared.clone(), crate::config::input_marker());
        if desktop.foreground() == target {
            restored = desktop.move_pointer(x, y);
            if restore != 0 && restore != target && desktop.is_window(restore) {
                desktop.focus(restore);
            }
        }
    }
    match (released, restored) {
        (Ok(()), Ok(())) => 0,
        (Err(error), _) | (_, Err(error)) => {
            eprintln!("mixdog-computer abort cleanup: {error}");
            1
        }
    }
}
