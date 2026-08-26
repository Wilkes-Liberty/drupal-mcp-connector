# Lab outbound relay (DEV-293)

Isolated laboratory harness. It is **not** a public surface, **not** a hosted
MCP product, and **not** DEV-294. It does not start the hosted connector and
does not claim service readiness.

Model B, loopback only: a tenant agent dials **out** to a lab relay. The relay
does not open a connection to the agent. The stub private Drupal never listens.
Tunnel identity is the tenant boundary. `createLocalRelay` (#181) is used for
target resolution only — it is not a network tunnel.

Northbound protocol is the already-shipped MCP **2026-07-28** Streamable-HTTP
path (stateless; no `Mcp-Session-Id`). This harness does not invent a second
northbound protocol.

## Run the proof

From the repository root (after `npm install`):

```bash
npx vitest run tests/lab/outbound-relay.test.js
npm test
```

Lab credentials are issued per test (`lab-` + random bytes), revocable, and
never `MCP_AUTH_TOKEN`. Bind addresses are `127.0.0.1` only. No public hostname
is configured.

## Revocation bound

**Per-request. Grace window: none (`graceMs: 0`).**

Revocation is checked at the start of each northbound `/mcp` request. The next
request after `revoke()` is denied (HTTP 403). An in-flight request that already
passed that check may finish; the following request must not.

See `LAB_REVOCATION_BOUND` in `harness.js`.

## Optional live hop (not executed here)

An operator on a machine that can already reach a **non-production** connector
from this package (the existing Streamable-HTTP `/mcp`, MCP 2026-07-28) can
replace the in-process stub's `handleMcp` with a function that POSTs that same
request to the connector's private URL.

This README does **not** claim that hop ran. Do not point the lab at production
Drupal, a public edge hostname, or a shared production bearer. Hosted-edge
readiness is DEV-294.
