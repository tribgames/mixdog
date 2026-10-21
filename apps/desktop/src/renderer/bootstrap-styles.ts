// First-screen renderer styles. bootstrap.tsx remains the readiness owner,
// while the installed web app starts this module early to overlap its CSS and
// font transfer with the remote transport and language catalog.
// The font faces and @property registrations load beside it from
// font-faces-styles.ts (imported first by bootstrap.tsx), as their own sheet.
import './ui/tokens.css';
import './styles.css';
import './desktop.css';
import './pane-layout.css';
import './pane-side-dock-bottom.css';
import './mobile-web-runtime.css';
