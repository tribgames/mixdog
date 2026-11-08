mod compact_reencode;
mod composer_resize;
// Built only with `--features test-support`, as the former `[[test]] g8` was (`required-features`).
#[cfg(feature = "test-support")]
mod g8;
mod pool;
