use std::time::Duration;

use mixdog_rt::time::{Instant, sleep};

pub async fn eventually(what: &str, mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while !condition() {
        assert!(Instant::now() < deadline, "timed out waiting for: {what}");
        sleep(Duration::from_millis(10)).await;
    }
}
