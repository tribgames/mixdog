//! `web_search`, `web_fetch`, `local_fetch`, `image_fetch` (WP-TOOLS-WEB).

mod cache;
mod cdp;
mod error;
mod extract;
mod format;
mod hosted_search;
mod http;
mod pipeline;
mod render;
mod search;
mod ssrf;
mod tools;

#[cfg(test)]
mod render_tests;
#[cfg(test)]
mod tests;

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
