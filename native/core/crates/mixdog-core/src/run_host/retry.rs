//! Retry jitter and the retry wait. The delay itself is decided by the one retry policy; the
//! wait is a plain sleep that the loop races against the run's token.

use std::time::Duration;

use async_trait::async_trait;
use mixdog_agent::env::JitterSource;
use mixdog_agent::env::RetryWait;
use rand::Rng;

/// `Math.random()`: a draw in `[0, 1)` from the thread's generator.
#[derive(Default)]
pub struct RandomJitter;

impl JitterSource for RandomJitter {
    fn draw(&self) -> f64 {
        rand::rng().random::<f64>()
    }
}

/// The host's delay: tokio's timer wheel.
#[derive(Default)]
pub struct TimerWait;

#[async_trait]
impl RetryWait for TimerWait {
    async fn wait(&self, delay: Duration) {
        tokio::time::sleep(delay).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn draws_stay_in_the_unit_interval() {
        let jitter = RandomJitter;
        assert!((0..1000).map(|_| jitter.draw()).all(|d| (0.0..=1.0).contains(&d)));
    }

    #[tokio::test(start_paused = true)]
    async fn the_wait_lasts_the_given_delay() {
        let start = tokio::time::Instant::now();
        TimerWait.wait(Duration::from_millis(250)).await;
        assert_eq!(start.elapsed(), Duration::from_millis(250));
    }
}
