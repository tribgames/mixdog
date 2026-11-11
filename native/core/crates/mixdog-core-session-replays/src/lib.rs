//! Test-only package: the replays of Node's recordings against `mixdog-core-session` live in `tests/<area>/`, one
//! test target per area. Helpers that two or more areas share belong in this library (compiled once, linked by each
//! target); a helper of one area stays in that area's folder; the session rig stays in the library
//! (`mixdog_core_session::session::testing`, feature `test-support`).
