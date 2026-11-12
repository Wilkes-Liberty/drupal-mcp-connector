# Browser sign-in for a local connector

Run `drupal-mcp-login` as your MCP client's stdio command. It opens your default
browser, receives one authorization code on IPv4 loopback, verifies the access
token, and starts the connector in the same process. Standard output is reserved
for MCP. Sign in again by restarting the process after the access token expires.

Replace the site's other authentication blocks with `pkce`:

```json
{
  "defaultSite": "content",
  "sites": {
    "content": {
      "baseUrl": "https://cms.example",
      "requireSecureAuth": true,
      "pkce": {
        "issuer": "https://identity.example/realms/demo",
        "resource": "https://cms.example/mcp",
        "audience": "cms-agent",
        "clientId": "content-cli",
        "scopes": ["mcp_read"],
        "redirectUri": "http://127.0.0.1:8765/callback"
      }
    }
  }
}
```

Register that exact redirect on a public authorization-code client with S256.
The browser must run on the same workstation as the connector, and the selected
port must be free. The issuer must publish HTTPS OIDC discovery and JWKS on its
own origin and issue an asymmetric signed JWT. The token must have the exact
single `audience` identifier (or `resource` when `audience` is omitted), the configured client as `azp`, a nonempty issuer-owned
`sub` and `tenant`, a current expiry and every configured scope. The CMS must
validate the issuer and resource and explicitly bind the principal and designate
the client for the governed channel. A successful browser sign-in does not create
those bindings or grant content permissions. Keep the existing CMS audience when
adding a CLI client; the OAuth resource URI and JWT audience need not be the
same string. Audience aliases and additional token audiences are refused.

This launcher supports local stdio sessions. It does not store credentials,
retain refresh tokens or switch to another credential after failure or expiry.
Configure a separate site for another authentication mode. The direct
`drupal-mcp-connector` command does not initiate browser sign-in; a PKCE site
without a session refuses authenticated requests.
