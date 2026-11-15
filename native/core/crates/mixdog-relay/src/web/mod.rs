//! What the relay serves from disk: the renderer release registry and the per-device choice of release, the `/readyz`
//! report over the current renderer and every retained release, the rule that names a content-hashed asset, and the static
//! files themselves (target resolution, content negotiation, validators, security headers and cookies).

pub mod files;
pub mod hashed;
pub mod headers;
pub mod negotiate;
pub mod readiness;
pub mod releases;
