# Sign-in flows

## Log in

Navigate to the sign-in form (or its password step). When the user has exactly
one stored login for that HTTPS site, the host signs in by itself right after
the command that shows the form: it waits for the page's human check
(Turnstile, reCAPTCHA, hCaptcha) to hold its token, fills user + password,
submits, and replies with one line:

- `Saved sign-in: signed in to <site>` — done; verify with the returned page,
  do not fill or submit again.
- `Saved sign-in: the site still needs the user at <site>` — a check that did
  not finish, a code, CAPTCHA, passkey, or an error: hand the sign-in to the
  user, do not retry.

It tries once per site per turn, and the password never appears in any reply.

When the host did not sign in by itself (several stored logins, or automatic
sign-in did not run), call `fill` with `savedAccount:"<email or masked label>"`
(and `submit:true` to sign in). Do not press Enter or click submit after a
`savedAccount` fill that already used `submit:true`. A `savedAccount` miss lists
the site's stored logins as masked labels; the user chooses which to use.

Without a stored login, use the returned refs and `fill.fields` for user +
password, then `click` submit (or `submit:true`) with `expect.url` or
`expect.text`. A CAPTCHA, 2FA prompt (authenticator or SMS code, passkey), or
identity check goes to the user as a `takeover` handoff; never solve or bypass
it. A "check your e-mail" step is the next flow, not a handoff.

## E-mail verification

When a sign-up or sign-in the user asked for stops at "check your e-mail" and a
mailbox connector is connected (Gmail `search_emails` / `read_email`; a bot's
connector setting may ask before the read), finish it:

1. Search the site's domain (`from:<domain> newer_than:1d`) and read the newest
   mail from the site dated after the flow started.
2. Either `navigate` this session's page to its confirmation link, or `fill`
   its code into the page's code field with `sensitive:true` (replies,
   snapshots and the stored transcript then show it redacted).

Use the link exactly as the mail's `links` list gives it, within 30 minutes of
the read: a URL with a token opens only when the runtime read it in a mail this
session, over https, from one sender Gmail authenticated, on that sender's own
domain — never rebuild, trim or retype one. The code goes only into the field:
never echo, quote, send, or forward it. No mail after a short `wait`: resend
from the page at most once. Zero or several matching mails, another sender, or
a link to another site → ask the user. Authenticator, SMS or passkey steps,
CAPTCHAs, identity checks, and password resets the user did not start still go
to the user.

## Linked sign-in

When the site offers "Continue with <provider>" (any identity provider) and this
browser is already signed in there, prefer it to typing a password; a reply's
`Linked sign-in:` line names the provider, and the account when known, that the
site used last time. A provider's account chooser with one account is picked
directly. With several and no known account, the provider's own list of
connected apps (for example Google `myaccount.google.com/connections`, GitHub
`settings/applications`) may show which account the site is linked to;
otherwise ask the user once with the chooser's accounts as options. Never type
a provider password: a provider password or 2FA step, or a first-time consent
screen for an app the user did not name, goes to the user.

## Bot checks

A "Just a moment" / "checking your browser" page usually clears by itself:
`wait` up to about 20 s for its text to go. If it stays, hand the page to the
user instead of reloading.
