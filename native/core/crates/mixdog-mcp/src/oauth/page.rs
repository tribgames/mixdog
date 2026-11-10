//! The browser pages of the loopback sign-in callback (success / failure) are the shared ones of
//! every login (`mixdog_core_api::domain::login_page`); this adds the MCP failure reasons.

pub use mixdog_core_api::domain::login_page::CONTENT_TYPE;
pub use mixdog_core_api::domain::login_page::error_html;
pub use mixdog_core_api::domain::login_page::success_html;

/// The failure page reason by error: fixed bilingual texts, never server error text or tokens.
pub fn failure_reason(server: &str, scope_not_granted: bool) -> String {
    if scope_not_granted {
        return format!(
            "{server} 접근 권한이 허용되지 않았습니다. Mixdog로 돌아가 다시 연결하고, 권한 확인란을 체크해 주세요. (Google은 확인란이 처음에 해제되어 있습니다.)\nAccess to {server} was not granted. Return to Mixdog and connect again with the access box checked (Google starts it unchecked)."
        );
    }
    format!("{server} 로그인을 완료하지 못했습니다.\nSign-in to {server} could not be completed.")
}