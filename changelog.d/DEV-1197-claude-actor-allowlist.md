---
section: Security
---
`@claude` runs now require the commenter to be listed in the `CLAUDE_ALLOWED_ACTORS` repository or organization variable; when it is empty or unset no run starts. Bot senders and logins ending in `[bot]` are skipped, write permissions are granted only to the Claude job, and the turn cap is set explicitly (Wilkes-Liberty/vault#852).
