# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.x     | ✅ Active development |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Send a report to **security@wilkesliberty.com** with:

- A description of the vulnerability
- Steps to reproduce
- Potential impact
- Any suggested mitigations

You will receive a response within **48 hours** acknowledging receipt. We aim to release a patch within **7 days** for critical issues.

## Security Architecture

This connector implements defense-in-depth:

1. **Drupal-level permissions** — The API credential's Drupal role is the first gate. Grant only the minimum permissions needed.
2. **Connector security layer** — `src/lib/security.js` enforces read-only mode, entity allowlists, field redaction, and destructive operation gates *before* any HTTP request is made.
3. **No credential storage** — Credentials live in `config/config.json` (gitignored) or environment variables. They are never logged or returned in tool responses.
4. **Field redaction** — Sensitive fields (`pass`, `mail`, custom PII fields) are stripped from all responses when configured.

## Credential Best Practices

- Use **Bearer tokens** (Simple OAuth module), not Basic Auth, in production
- Create a **dedicated Drupal API user** with only the permissions the connector needs
- Set `security.readOnly: true` on production sites unless writes are required
- Set `security.allowDestructive: false` to prevent any delete operations
- Use the **`auditor` preset** for read-only analysis workloads
- Rotate tokens regularly; they can be invalidated without changing passwords
- Never commit `config/config.json` — it is gitignored by default

## Known Limitations

- The Drush SSH bridge requires SSH key access to the server. Never use password-based SSH auth.
- GraphQL mutations should be disabled (`allowGraphqlMutations: false`) unless explicitly needed.
- The connector does not implement rate limiting. Consider a reverse proxy for production remote deployments.
