//! The install hint line of the voice toggle: its text, percent and 500 ms throttle.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;

use super::setup::{ProgressHint, throttled_hint};
use crate::model_install::Progress;

#[derive(Default)]
struct Hints(Mutex<Vec<(String, Option<u8>)>>);

#[async_trait]
impl ProgressHint for Hints {
    fn show(&self, text: String, percent: Option<u8>) {
        self.0.lock().unwrap().push((text, percent));
    }
    async fn clear(&self) {}
}

fn progress(label: &str, downloaded: u64, total: u64) -> Progress {
    Progress { label: label.to_owned(), downloaded, total }
}

#[tokio::test(start_paused = true)]
async fn the_first_progress_shows_at_once_and_later_ones_at_most_every_half_second() {
    let hints = Arc::new(Hints::default());
    let sink = throttled_hint(hints.clone());
    sink(progress("model", 50, 100));
    tokio::time::advance(Duration::from_millis(499)).await;
    sink(progress("model", 60, 100));
    assert_eq!(hints.0.lock().unwrap().len(), 1, "inside the interval nothing is shown");
    tokio::time::advance(Duration::from_millis(1)).await;
    sink(progress("model", 70, 100));
    let shown = hints.0.lock().unwrap().clone();
    assert_eq!(shown, vec![("⬇ Voice model ▓▓▓░░░ 50%".to_owned(), Some(50)), ("⬇ Voice model ▓▓▓▓░░ 70%".to_owned(), Some(70))]);
}

#[tokio::test(start_paused = true)]
async fn each_download_is_named_and_an_unknown_size_shows_no_percent() {
    let hints = Arc::new(Hints::default());
    for (label, name) in [("ffmpeg", "ffmpeg"), ("extra", "extra data"), ("runtime", "whisper runtime"), ("whatever", "whisper runtime")] {
        let sink = throttled_hint(hints.clone());
        sink(progress(label, 0, 0));
        let shown = hints.0.lock().unwrap().pop().unwrap();
        assert_eq!(shown, (format!("⬇ Voice {name} …"), None), "{label}");
    }
}

#[tokio::test(start_paused = true)]
async fn a_download_past_its_announced_size_is_shown_as_complete() {
    let hints = Arc::new(Hints::default());
    throttled_hint(hints.clone())(progress("model", 300, 100));
    assert_eq!(hints.0.lock().unwrap()[0], ("⬇ Voice model ▓▓▓▓▓▓ 100%".to_owned(), Some(100)));
}
