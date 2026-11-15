//! What the relay serves from disk: the renderer release registry and the per-device choice of release, the `/readyz`
//! report over the current renderer and every retained release, and the rule that names a content-hashed asset.

pub mod hashed;
pub mod readiness;
pub mod releases;
