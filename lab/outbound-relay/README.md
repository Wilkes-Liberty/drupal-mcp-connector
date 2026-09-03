# Lab outbound relay

Isolated laboratory harness. It is **not** a public surface, **not** a hosted
MCP product, and **not** the product edge (#232). It does not start the hosted connector and
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

**The lab northbound `/mcp` does not authenticate the caller.** The lab
credential authenticates the *agent tunnel channel*; the revocation check on a
northbound request reads that channel's credential, not anything the caller
presents. A product edge must authenticate the northbound caller with a real
OAuth resource server — that is the product edge's slice (#232), not this harness.

Caller credential headers (`Authorization`, `Cookie`, `Proxy-Authorization`)
are stripped before a request is framed down the tunnel (#229). The tenant
side receives the bound identity object, never the caller's credentials.

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
readiness is the product edge's concern (#232).
