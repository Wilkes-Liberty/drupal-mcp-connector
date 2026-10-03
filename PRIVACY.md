# Privacy

The Drupal MCP Connector is a **local process**. Cursor (or another MCP client)
launches it on the operator's machine via stdio. It talks only to the Drupal
site the operator configures.

Credentials live in the operator's client config or environment variables.
They are never logged and never returned in tool responses.

This listing does not send Drupal content or tokens to Wilkes & Liberty.

Security reports: **security@wilkesliberty.com** (not public GitHub issues).
See [SECURITY.md](SECURITY.md).
