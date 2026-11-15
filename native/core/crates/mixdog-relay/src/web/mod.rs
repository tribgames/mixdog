//! What the relay serves from disk: the renderer release registry and the per-device choice of release, the `/readyz`
//! report over the current renderer and every retained release, the rule that names a content-hashed asset, and the static
//! files themselves (target resolution, content negotiation, validators, security headers and cookies). The gate in front of
//! them (`gate`: credentials, the public installability assets, share-target and the health probe), the device routes
//! (`device_route`) and the preview frame (`preview`) answer what a browser or the phone WebView fetches over HTTP.

pub mod device_route;
pub mod files;
pub mod gate;
pub mod hashed;
pub mod headers;
pub mod negotiate;
pub mod preview;
pub mod readiness;
pub mod releases;
