//! The frozen on-disk format (`FORMAT.md` beside `Cargo.toml`): frame layout and scan
//! results, record kinds, blob references, checkpoint state, SQLite DDL and the one-time
//! migration's bookkeeping files. Types, constants and DDL only; codecs, readers and
//! writers live in the modules that implement them and are tested against `vectors/`.

pub mod blob;
pub mod bounded;
pub mod checkpoint;
pub mod frame;
pub mod migration;
pub mod record;
pub mod sql;

#[cfg(test)]
mod tests;
