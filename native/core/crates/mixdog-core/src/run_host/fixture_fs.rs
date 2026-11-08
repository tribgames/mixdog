//! File fixtures for the tests of this module, through the lane-proofed file functions the code
//! under test uses ([`mixdog_statefile`], [`mixdog_core_base::support`]). The test backend runs a
//! lane job inline at submit, so the job's result is ready when `submit` returns.

use std::io;
use std::path::Path;

use futures::FutureExt;
use mixdog_rt::{CancellationToken, DurabilityIo, InLane, LaneToken};

// `unconstrained`: inside a tokio test the handle's oneshot would otherwise answer Pending once the task's coop budget is spent.
fn on_lane<R: Send + 'static>(job: impl FnOnce(&InLane<DurabilityIo>) -> R + Send + 'static) -> R {
    tokio::task::unconstrained(mixdog_rt::testing::tokens().durability_io.submit(&CancellationToken::new(), job).unwrap())
        .now_or_never()
        .expect("the test backend runs the job inline")
        .unwrap()
}

/// `std::fs::write`, parent directories made as needed.
pub(crate) fn write(path: impl AsRef<Path>, body: impl AsRef<[u8]>) {
    let (path, body) = (path.as_ref().to_owned(), body.as_ref().to_vec());
    on_lane(move |lane| mixdog_statefile::write_file(lane, &path, &body, &mixdog_statefile::Opts::default())).unwrap();
}

/// [`write`] without the file flush: a fixture rewritten per case of a replay needs no durability, and the flush
/// is the dominant cost of such a loop.
pub(crate) fn write_unsynced(path: impl AsRef<Path>, body: impl AsRef<[u8]>) {
    let (path, body) = (path.as_ref().to_owned(), body.as_ref().to_vec());
    let opts = mixdog_statefile::Opts { fsync: false, ..mixdog_statefile::Opts::default() };
    on_lane(move |lane| mixdog_statefile::write_file(lane, &path, &body, &opts)).unwrap();
}

/// `std::fs::read_to_string`.
pub(crate) fn read_to_string(path: impl AsRef<Path>) -> io::Result<String> {
    let bytes = mixdog_statefile::read_content(path.as_ref())?.ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))?;
    String::from_utf8(bytes).map_err(io::Error::other)
}

/// `Path::exists`, except that an error other than `NotFound` propagates.
pub(crate) fn exists(path: impl AsRef<Path>) -> io::Result<bool> {
    let path = path.as_ref().to_owned();
    match on_lane(move |lane| mixdog_statefile::metadata(lane, &path)) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

/// `std::fs::create_dir_all`.
pub(crate) fn create_dir_all(path: impl AsRef<Path>) {
    let path = path.as_ref().to_owned();
    on_lane(move |lane| mixdog_statefile::create_private_dir_all(lane, &path)).unwrap();
}

/// `std::fs::remove_file(path).unwrap()`: a missing file panics.
pub(crate) fn remove_file(path: impl AsRef<Path>) {
    let path = path.as_ref().to_owned();
    on_lane(move |lane| mixdog_statefile::remove_file(lane, &path)).unwrap();
}
