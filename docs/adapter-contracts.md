# Adapter Contracts

**Contract version: 1.0**

This document is the published, provider-neutral adapter family for
`drupal-mcp-connector`. It is a different surface from the
[connector ↔ Drupal-governance integration contract](integration-contract.md).
That document is the wire contract with MCP Sentinel. This one is the reusable
evaluator, relay, approval, evidence-sink, and system-of-record seam so a
future second system of record does not rewrite the control plane.

The Drupal adapter is the only system-of-record implementation in this
package. JSON:API and GraphQL remain transport adapters. Model vendors and
agent vendors are not fields on any contract record.

Import the surface from `src/lib/contracts/index.js`.

---

## 1. Version negotiation

```js
import { ADAPTER_CONTRACT_VERSION, negotiateContractVersion } from "../src/lib/contracts/index.js";

negotiateContractVersion();      // "1.0"
negotiateContractVersion("1.2"); // "1.0" — same major is compatible
negotiateContractVersion("2.0"); // throws incompatible_contract_version
```

| Connector | Adapter contract |
|-----------|------------------|
| ≥ 2.x (this change, unreleased) | 1.0 |

The contract is versioned independently of the npm package and of the
integration-contract revision. Backward-compatible additions bump the minor
(`1.0` → `1.1`). A breaking change to typed records, reason codes, or the
narrowing rule bumps the major (`1.0` → `2.0`). A missing request defaults to
`1.0`.

---

## 2. The five seams

```text
propose → evaluate → (approve) → execute → receipt → evidence
```

| Seam | Role | This package |
|------|------|--------------|
| **Policy evaluator** | Returns a typed decision. Does not execute. | Drupal evaluator wrapping `security.js` / principal grants; optional upstream evaluator is composed, never trusted as authority |
| **Tenant relay** | Resolves the authoritative target. Caller hints never become authority. | `createLocalRelay` — vendor tunnels stay outside the contract |
| **Approval interface** | One-use grant bound to a manifest digest and actor | `createMemoryApproval` |
| **Evidence sink** | Required writes fail closed; advisory writes may degrade | `createMemoryEvidenceSink` |
| **System of record** | Maps native operations to action classes, executes, returns a receipt | `createDrupalAdapter` (Drupal only) |

In-process relay / approval / evidence / backend fixtures are contract-role
implementations for conformance. They are **not** a second system-of-record
adapter.

---

## 3. Typed records

Three independently owned records share ids but not authority:

| Record | Carries |
|--------|---------|
| **Identity context** | Issuer, subject, client, tenant, audience, scopes, token id, environment |
| **Decision record** | Decision id; action digest; target; action class; policy digest/revision; evaluator version; `deny` / `allow` / `allow_with_obligations` / `require_approval`; stable reason codes; obligations; optional auth/scope challenge |
| **Execution receipt** | What happened: native actor, revision, declared vs observed effects, `ok` / `denied` / `failed` / `unknown` |

Action classes every adapter must map onto:

| Class | Drupal example |
|-------|----------------|
| `bounded_read` | Fetch one node |
| `exfiltration_read` | List or export |
| `reversible_write` | Create or update a draft |
| `publish_or_destructive` | Publish, delete, `status: true` |
| `control_plane` | Config, role, credential, governance entities |

Assurance classes (`source_enforced`, `boundary_enforced`, `advisory`) are
never presented as equivalent. Publish-class and control-plane writes at
source- or boundary-enforced assurance require durable evidence.

---

## 4. Narrowing rule

`composeDecisions(upstream, local)` is the only legal way to combine an
upstream evaluator with the target-side decision.

- A local or target `deny` always wins.
- An upstream `allow` or `allow_with_obligations` cannot become the result
  when local denied.
- `require_approval` is narrower than `allow`.
- Obligations union only when both sides allow.

The Drupal adapter applies connector security and principal grants first, then
composes any optional upstream evaluator through that function.

---

## 5. Stable reason codes

Contract-level codes (do not invent a parallel set):

| Code | Meaning |
|------|---------|
| `policy_denied` | Connector or principal policy refused the action |
| `target_denied` | Target-side security refused the action |
| `tenant_escape` | Caller hint named a target the principal is not granted |
| `hostile_input` | HTML, path escape, or other hostile modality |
| `vendor_field_rejected` | Model or agent vendor key on a contract record |
| `approval_required` | High-impact action needs a one-use approval |
| `replay_detected` | Approval already used, unknown, or digest/actor mismatch |
| `evidence_write_failed` | Required evidence could not be persisted |
| `postcondition_discrepancy` | Declared effects do not match observed state |
| `incompatible_contract_version` | Requested major is not 1.x |

Budget and source-governance codes stay in `data-flow.js` and `governance.js`.

---

## 6. Vendor exclusion

These keys are outside the contract and are rejected at proposal construction:

`model`, `modelVendor`, `agentVendor`, `agentFramework`, `llmProvider`,
`openai`, `anthropic`, `vendor`.

Identity, decision, receipt, and manifest constructors call
`assertNoVendorFields`. The conformance kit asserts the same keys are absent
from typed decisions and receipts.

---

## 7. Drupal conformance kit

The kit lives at `tests/conformance/`. Runners in `kit.js` are
adapter-agnostic. `drupal.test.js` is the only registered adapter.

Covered cases:

- Allowed bounded read and reversible draft write
- Denied delete, publish, and control-plane write
- Hostile input: vendor fields, script HTML, path escape
- Tenant escape via a site hint the principal is not granted
- Required-evidence write failure (fail closed, no mutation)
- Replay of a consumed approval
- Post-condition discrepancy (`unknown`, never green)
- Upstream allow cannot widen a local deny
- 1.x negotiation; foreign major refused

The kit is offline vitest. It does not require a live Drupal site and does
not implement a second adapter.

```bash
npx vitest run tests/conformance tests/lib/contracts
```

---

## 8. Compatibility

Implementers should call `negotiateContractVersion` before `propose` /
`evaluate`. Speaking 1.x against this connector is compatible. Speaking 2.x
is not, until this package publishes a 2.0 contract.

MCP tool response envelopes are unchanged. Typed decisions and receipts exist
at the contract seam; they are not attached to `drupal_*` tool payloads.
