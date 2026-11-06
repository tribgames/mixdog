//! `web_search`, `web_fetch`, `local_fetch`, `image_fetch` (WP-TOOLS-WEB).

mod args;
mod cache;
mod cdp;
mod error;
mod extract;
mod format;
mod gai;
mod lanes;
mod hosted_routes;
mod hosted_search;
mod hosted_sender;
mod hosted_usage;
mod http;
mod pipeline;
mod render;
mod search;
mod ssrf;
mod tools;

#[cfg(test)]
mod hosted_native_tests;
#[cfg(test)]
mod render_tests;
#[cfg(test)]
mod tests;

pub use cache::CacheFile;
pub use lanes::WebLanes;
pub use error::FetchError;
pub use error::FetchKind;
pub use extract::Extracted;
pub use extract::extract_document;
pub use hosted_search::HostedSearchCall;
pub use hosted_search::HostedSearchError;
pub use hosted_search::HostedSearchReply;
pub use hosted_search::HostedSearchSender;
pub use hosted_search::HostedWebSearch;
pub use hosted_search::SearchCandidate;
pub use hosted_search::SearchFamily;
pub use hosted_search::SearchRoutes;
pub use hosted_routes::ConfiguredSearchRoutes;
pub use hosted_routes::SearchHost;
pub use hosted_sender::ProviderSearchSender;
pub use hosted_sender::SenderDeps;
pub use hosted_usage::NativeSearchUsageSinks;
pub use hosted_usage::Release;
pub use hosted_usage::UsageSink;
pub use hosted_usage::usage_delta;
pub use pipeline::PageRenderer;
pub use render::BrowserEndpoint;
pub use render::BrowserRenderer;
pub use pipeline::StagePage;
pub use search::NativeSearchRequest;
pub use search::NativeSearchResult;
pub use search::NativeSource;
pub use search::NativeWebSearch;
pub use search::SearchCall;
pub use tools::WebConfig;
pub use tools::WebService;
