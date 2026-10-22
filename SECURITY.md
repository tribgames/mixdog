# Security Policy

## Supported versions

Only the latest release of Mixdog receives security fixes. Update before
reporting, and check whether the problem still occurs.

## Reporting a vulnerability

**Do not report vulnerabilities in public issues, discussions, or pull requests.**

Report privately through
[GitHub private vulnerability reporting](https://github.com/tribgames/mixdog/security/advisories/new).
Include:

- What an attacker can do, and what they need first (local access, a crafted
  file, a malicious website, a signed-in account).
- Steps to reproduce or a proof of concept, against the latest release.
- The affected version and operating system.

Keep the details private until a fix is released. We credit reporters in the
release notes unless you ask us not to.

## Out of scope

- A dependency with a known CVE, without showing that Mixdog actually reaches
  the vulnerable code.
- Actions that need the user to run commands or approve tools they were warned
  about.
- Problems in third-party model providers or MCP servers themselves.
