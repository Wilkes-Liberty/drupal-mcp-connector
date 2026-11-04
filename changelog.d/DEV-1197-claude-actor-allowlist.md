---
section: Security
---
`@claude` runs now require the commenter to be listed in the `CLAUDE_ALLOWED_ACTORS` repository or organization variable; when it is empty or unset no run starts. A partial workflow re-run cannot reuse an earlier authorization: the Claude job is scheduled only when the gate's recorded run attempt is still the current one, and it re-checks the allowlist before the action starts. Bot senders and logins ending in `[bot]` are skipped, write permissions are granted only to the Claude job, and the turn cap is set explicitly (Wilkes-Liberty/vault#852).
