//! The browser pages of the loopback sign-in callback (success / failure). The callback server
//! does not know the app language, so the page is bilingual (Korean first).

const LOGO_SVG: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="44 44 168 168" aria-hidden="true">
  <defs>
    <linearGradient id="titanium-a" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff"/><stop offset="50%" stop-color="#94a3b8"/><stop offset="100%" stop-color="#ffffff"/>
    </linearGradient>
    <linearGradient id="titanium-b" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#cbd5e1"/><stop offset="50%" stop-color="#475569"/><stop offset="100%" stop-color="#cbd5e1"/>
    </linearGradient>
    <linearGradient id="titanium-c" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#94a3b8"/><stop offset="50%" stop-color="#334155"/><stop offset="100%" stop-color="#94a3b8"/>
    </linearGradient>
  </defs>
  <g fill="none" stroke-width="22" stroke-linecap="round">
    <path d="M116.2 61A68 68 0 0 1 191.9 104.7" stroke="url(#titanium-a)"/>
    <path d="M116.2 61A68 68 0 0 1 191.9 104.7" transform="rotate(120 128 128)" stroke="url(#titanium-b)"/>
    <path d="M116.2 61A68 68 0 0 1 191.9 104.7" transform="rotate(240 128 128)" stroke="url(#titanium-c)"/>
  </g>
  <polygon points="128,112 133,123 144,128 133,133 128,144 123,133 112,128 123,123" fill="#cbd5e1"/>
  <circle cx="128" cy="128" r="3.5" fill="#07080b"/>
  <circle cx="128" cy="128" r="1.5" fill="#ffffff"/>
</svg>"##;

const STYLE: &str = r#"    :root { --bg: #f6f7f9; --fg: #0f172a; --muted: #475569; --card: #ffffff; --line: #d9dee6; --ok: #15803d; --bad: #b91c1c; --link: #1d4ed8; }
    @media (prefers-color-scheme: dark) {
      :root { --bg: #07080b; --fg: #f8fafc; --muted: #94a3b8; --card: #0f1116; --line: #232733; --ok: #4ade80; --bad: #f87171; --link: #93c5fd; }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: var(--bg);
      color: var(--fg);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans KR", Roboto, Arial, sans-serif;
      text-align: center;
    }
    main {
      width: 100%;
      max-width: 520px;
      padding: 40px 32px 32px;
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 16px;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .logo { width: 72px; height: 72px; margin-bottom: 20px; }
    .logo svg { width: 100%; height: 100%; display: block; }
    h1, h2 { margin: 0 0 6px; line-height: 1.2; font-weight: 650; }
    h2 { font-size: 16px; color: var(--muted); font-weight: 600; }
    p { margin: 0; line-height: 1.7; color: var(--muted); font-size: 15px; }
    section.secondary { margin-top: 18px; }
    .reason {
      margin-top: 20px;
      width: 100%;
      padding: 12px 14px;
      border: 1px solid var(--line);
      border-radius: 10px;
      text-align: left;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 13px;
      color: var(--fg);
      white-space: pre-wrap;
      word-break: break-word;
    }
    .reason span { display: block; margin-bottom: 4px; color: var(--muted); font-family: inherit; font-size: 12px; }"#;

pub const CONTENT_TYPE: &str = "text/html; charset=utf-8";

fn escape_html(value: &str) -> String {
    value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#39;")
}

fn render(success: bool, body_ko: &str, body_en: &str, reason: Option<&str>) -> String {
    let (title_ko, title_en) = if success { ("로그인 완료", "Sign-in complete") } else { ("로그인 실패", "Sign-in failed") };
    let sections = [("ko", title_ko, body_ko), ("en", title_en, body_en)]
        .iter()
        .enumerate()
        .map(|(index, (lang, title, body))| {
            let tag = if index == 0 { "h1" } else { "h2" };
            let class = if index == 0 { "primary" } else { "secondary" };
            format!(
                "<section lang=\"{lang}\" class=\"{class}\">\n      <{tag}>{}</{tag}>\n      <p>{}</p>\n    </section>",
                escape_html(title),
                escape_html(body)
            )
        })
        .collect::<Vec<_>>()
        .join("\n    ");
    let reason_block = reason
        .map(|r| format!("<div class=\"reason\"><span>사유 / Reason</span>{}</div>", escape_html(r)))
        .unwrap_or_default();
    let document_title = escape_html(&format!("{title_ko} / {title_en} · Mixdog"));
    let heading = if success { "var(--ok)" } else { "var(--bad)" };
    format!(
        "<!doctype html>\n<html lang=\"ko\">\n<head>\n  <meta charset=\"utf-8\" />\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />\n  <meta name=\"color-scheme\" content=\"dark light\" />\n  <title>{document_title}</title>\n  <style>\n{STYLE}\n    h1 {{ font-size: 28px; color: {heading}; }}\n  </style>\n</head>\n<body>\n  <main>\n    <div class=\"logo\">{LOGO_SVG}</div>\n    {sections}\n    {reason_block}\n  </main>\n</body>\n</html>"
    )
}

pub fn success_html(server: &str) -> String {
    render(
        true,
        &format!("{server} 로그인이 완료되었습니다. 이 탭을 닫고 Mixdog로 돌아가 주세요."),
        &format!("You are signed in to {server}. You can close this tab and return to Mixdog."),
        None,
    )
}

pub fn error_html(reason: &str) -> String {
    render(false, "Mixdog로 돌아가 다시 시도해 주세요.", "Return to Mixdog and try again.", Some(reason))
}

/// The failure page reason by error: fixed bilingual texts, never server error text or tokens.
pub fn failure_reason(server: &str, scope_not_granted: bool) -> String {
    if scope_not_granted {
        return format!(
            "{server} 접근 권한이 허용되지 않았습니다. Mixdog로 돌아가 다시 연결하고, 권한 확인란을 체크해 주세요. (Google은 확인란이 처음에 해제되어 있습니다.)\nAccess to {server} was not granted. Return to Mixdog and connect again with the access box checked (Google starts it unchecked)."
        );
    }
    format!("{server} 로그인을 완료하지 못했습니다.\nSign-in to {server} could not be completed.")
}
