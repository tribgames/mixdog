// First-screen renderer styles. bootstrap.tsx remains the readiness owner,
// while the installed web app starts this module early to overlap its CSS and
// font transfer with the remote transport and language catalog.
import "@fontsource-variable/jetbrains-mono";
import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
import "@vscode/codicons/dist/codicon.css";
import "./ui/tokens.css";
import "./styles.css";
import "./desktop.css";
import "./pane-layout.css";
import "./mobile-web-runtime.css";
