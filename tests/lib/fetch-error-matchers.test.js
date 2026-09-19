/**
 * Regression tests for every piece of code that matches on the text of an
 * error thrown by `drupalFetch` or `drupalGraphqlFetch` (#345).
 *
 * Each error here is produced by the real fetch function from a realistic
 * Drupal response, then handed to the real matcher. A change to how the error
 * detail is cleaned, redacted or bounded that breaks a matcher fails here.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node-fetch", () => ({ default: vi.fn() }));
import fetch from "node-fetch";
import { drupalFetch, drupalGraphqlFetch } from "../../src/lib/drupal-fetch.js";
import { isStaleCopyError, isWorkingCopyPatchError, isProbePassedWithoutSave } from "../../src/lib/patch-preflight.js";
import { isAuthError } from "../../src/lib/backends/index.js";
import { isModeratedStatusError } from "../../src/lib/backends/jsonapi.js";
import {
  isMissingDraftEndpoint,
  isMissingTranslationEndpoint,
  readTranslationInventory,
  rewriteTranslationWorkingRevisionError,
  writeDraft,
} from "../../src/lib/sentinel-draft.js";
import { isUnfilterableModerationState } from "../../src/tools/moderation.js";
import { looksLikeUnknownField } from "../../src/tools/scheduler.js";
import { isInaccessiblePathError } from "../../src/tools/structure.js";
import { classifyTargetError } from "../../src/tools/reports-extra.js";

const site = { _name: "t", baseUrl: "https://x" };
const JSON_API = "application/vnd.api+json";

/** A verbose JSON:API error document, as Drupal sends it with error display on. */
function jsonApiErrors(status, ...details) {
  return JSON.stringify({
    jsonapi: { version: "1.0", meta: { links: { self: { href: "http://jsonapi.org/format/1.0/" } } } },
    errors: details.map((detail) => ({
      title: "Error",
      status: String(status),
      detail,
      links: { via: { href: "https://x/jsonapi/node/article/n1" }, info: { href: "http://www.w3.org/Protocols/rfc2616/rfc2616-sec10.html" } },
      source: { file: "/var/www/html/web/core/modules/jsonapi/src/Controller/EntityResource.php", line: 1 },
      meta: { exception: "Exception in /var/www/html/web/core", trace: ["#0 /var/www/html/web/index.php(19): handle()"] },
    })),
  });
}

const HTML_PAGE = "<!DOCTYPE html><html><head><title>Error</title></head><body><h1>Error</h1><pre>/var/www/html/web/index.php</pre></body></html>";

function respondWith(status, body, contentType = JSON_API) {
  vi.mocked(fetch).mockResolvedValue({
    ok: false,
    status,
    headers: { get: (name) => (name.toLowerCase() === "content-type" ? contentType : null) },
    text: async () => body,
  });
}

/** The error the real drupalFetch throws for a response. */
async function fetchError(status, body, { method = "GET", path = "/jsonapi/node/article/n1", contentType = JSON_API } = {}) {
  respondWith(status, body, contentType);
  try {
    await drupalFetch(site, path, { method });
  } catch (err) {
    return err;
  }
  throw new Error("expected drupalFetch to fail");
}

/** The error the real drupalGraphqlFetch throws for a response. */
async function graphqlError(status, body, contentType = "application/json") {
  respondWith(status, body, contentType);
  try {
    await drupalGraphqlFetch(site, { query: "{ __typename }" });
  } catch (err) {
    return err;
  }
  throw new Error("expected drupalGraphqlFetch to fail");
}

/** A JSON:API-shaped backend whose rawQuery is the real drupalFetch. */
const backend = {
  capabilities: () => ({ sentinelDraft: true }),
  resourcePath: (entityType, bundle) => `/jsonapi/${entityType}/${bundle}`,
  rawQuery: ({ path, options }) => drupalFetch(site, path, options),
  toCanonical: (data) => data,
};

beforeEach(() => {
  vi.mocked(fetch).mockReset();
});

describe("patch-preflight matchers", () => {
  it("isWorkingCopyPatchError matches core's working-copy 400", async () => {
    const err = await fetchError(400, jsonApiErrors(400,
      "Updating a resource object that has a working copy is not yet supported. See https://www.drupal.org/project/drupal/issues/2795279."
    ), { method: "PATCH" });
    expect(isWorkingCopyPatchError(err)).toBe(true);
    expect(err.message).toContain("https://www.drupal.org/project/drupal/issues/2795279");
    expect(isStaleCopyError(err)).toBe(false);
  });

  it("isStaleCopyError matches the source-side stale-copy refusal", async () => {
    const err = await fetchError(409, jsonApiErrors(409,
      "Write denied by MCP Sentinel: the content changed after this copy was loaded. Reload the latest version and reapply the change."
    ), { method: "PATCH" });
    expect(isStaleCopyError(err)).toBe(true);
    expect(isWorkingCopyPatchError(err)).toBe(false);
  });

  it("isProbePassedWithoutSave matches the ID mismatch 400 and any 422", async () => {
    const mismatch = await fetchError(400, jsonApiErrors(400,
      "The selected entity (2f0c6d3e-5d6a-4b8e-9d6c-0a1b2c3d4e5f) does not match the ID in the payload (00000000-0000-4000-a000-000000000001)."
    ), { method: "PATCH" });
    expect(isProbePassedWithoutSave(mismatch)).toBe(true);

    const unprocessable = await fetchError(422, HTML_PAGE, { method: "PATCH", contentType: "text/html" });
    expect(isProbePassedWithoutSave(unprocessable)).toBe(true);

    const forbidden = await fetchError(403, jsonApiErrors(403, "The current user is not allowed to PATCH the selected resource."), { method: "PATCH" });
    expect(isProbePassedWithoutSave(forbidden)).toBe(false);
  });
});

describe("backend matchers", () => {
  it("isModeratedStatusError matches the moderated published-field 403 only", async () => {
    const moderated = await fetchError(403, jsonApiErrors(403,
      "The current user is not allowed to PATCH the selected field (status). Cannot edit the published field of moderated entities."
    ), { method: "PATCH" });
    expect(isModeratedStatusError(moderated)).toBe(true);

    const denied = await fetchError(403, jsonApiErrors(403, "The current user is not allowed to PATCH the selected field (status)."), { method: "PATCH" });
    expect(isModeratedStatusError(denied)).toBe(false);
  });

  it("isAuthError matches a 401 whatever the body is", async () => {
    expect(isAuthError(await fetchError(401, JSON.stringify({ message: "The access token is invalid." }), { contentType: "application/json" }))).toBe(true);
    expect(isAuthError(await fetchError(401, HTML_PAGE, { contentType: "text/html" }))).toBe(true);
    expect(isAuthError(await fetchError(401, ""))).toBe(true);
    expect(isAuthError(await graphqlError(401, HTML_PAGE, "text/html"))).toBe(true);
    expect(isAuthError(await graphqlError(401, ""))).toBe(true);
  });

  it("isAuthError matches a 403 that names the token or scope, not a plain 403", async () => {
    const scope = await fetchError(403, JSON.stringify({
      error: "insufficient_scope",
      error_description: "The request requires higher privileges than provided by the access token.",
    }), { contentType: "application/json" });
    expect(isAuthError(scope)).toBe(true);

    const graphqlScope = await graphqlError(403, JSON.stringify({ errors: [{ message: "The OAuth scope does not grant GraphQL access." }] }));
    expect(isAuthError(graphqlScope)).toBe(true);

    const plain = await fetchError(403, jsonApiErrors(403, "The current user is not allowed to GET the selected resource."));
    expect(isAuthError(plain)).toBe(false);
  });

  it("isAuthError does not read an unreachable or failing endpoint as an auth failure", async () => {
    expect(isAuthError(await fetchError(502, HTML_PAGE, { contentType: "text/html" }))).toBe(false);
    expect(isAuthError(await graphqlError(500, HTML_PAGE, "text/html"))).toBe(false);
  });
});

describe("Sentinel draft matchers", () => {
  const input = { entityType: "node", bundle: "page", id: "n1", attributes: { title: "T" }, draftRevision: { liveVid: "10", workingVid: "12" } };

  it("rewrites a 404 or 405 on the draft endpoint to the missing-endpoint error", async () => {
    respondWith(404, jsonApiErrors(404, "No route found for \"PATCH /jsonapi/node/page/n1/mcp-draft\""));
    const notFound = await writeDraft(backend, input, true).catch((err) => err);
    expect(isMissingDraftEndpoint(notFound)).toBe(true);

    respondWith(404, HTML_PAGE, "text/html");
    const htmlNotFound = await writeDraft(backend, input, true).catch((err) => err);
    expect(isMissingDraftEndpoint(htmlNotFound)).toBe(true);

    respondWith(405, "");
    const notAllowed = await writeDraft(backend, input, true).catch((err) => err);
    expect(isMissingDraftEndpoint(notAllowed)).toBe(true);
  });

  it("does not read a 403 or a 500 on the draft endpoint as absence", async () => {
    respondWith(403, jsonApiErrors(403, "Draft update access denied."));
    const denied = await writeDraft(backend, input, true).catch((err) => err);
    expect(isMissingDraftEndpoint(denied)).toBe(false);
    expect(denied.message).toContain("Drupal 403");
    expect(denied.message).toContain("Draft update access denied.");

    respondWith(500, HTML_PAGE, "text/html");
    const failed = await writeDraft(backend, input, true).catch((err) => err);
    expect(isMissingDraftEndpoint(failed)).toBe(false);
  });

  it("rewrites a 404 on the translation inventory to the missing-translation-endpoint error", async () => {
    respondWith(404, jsonApiErrors(404, "No route found for \"GET /jsonapi/node/page/n1/mcp-translations\""));
    const notFound = await readTranslationInventory(backend, { entityType: "node", bundle: "page", id: "n1" }).catch((err) => err);
    expect(isMissingTranslationEndpoint(notFound)).toBe(true);

    respondWith(403, jsonApiErrors(403, "Translation inventory access denied."));
    const denied = await readTranslationInventory(backend, { entityType: "node", bundle: "page", id: "n1" }).catch((err) => err);
    expect(isMissingTranslationEndpoint(denied)).toBe(false);
  });

  it("rewriteTranslationWorkingRevisionError matches the live-only 409", async () => {
    const err = await fetchError(409, jsonApiErrors(409, "A working revision exists. Reload and send both revision IDs."), {
      method: "POST", path: "/jsonapi/node/page/n1/mcp-draft/translations",
    });
    const rewritten = rewriteTranslationWorkingRevisionError(err);
    expect(rewritten).not.toBe(err);
    expect(rewritten.message).toMatch(/a working draft exists/);

    const other = await fetchError(409, jsonApiErrors(409, "The live or working revision changed. Reload before retrying."), { method: "POST" });
    expect(rewriteTranslationWorkingRevisionError(other)).toBe(other);
  });
});

describe("tool matchers", () => {
  it("isUnfilterableModerationState matches core's unfilterable moderation_state 500", async () => {
    const err = await fetchError(500, jsonApiErrors(500, "'moderation_state' not found"), {
      path: "/jsonapi/node/article?filter[moderation_state]=draft",
    });
    expect(isUnfilterableModerationState(err)).toBe(true);

    const other = await fetchError(500, jsonApiErrors(500, "SQLSTATE[HY000]: General error"), { path: "/jsonapi/node/article" });
    expect(isUnfilterableModerationState(other)).toBe(false);
  });

  it("looksLikeUnknownField matches an unknown-attribute 422, not a server failure", async () => {
    const err = await fetchError(422, jsonApiErrors(422, "The attribute publish_on does not exist on the node--page resource type."), { method: "PATCH" });
    expect(looksLikeUnknownField(err)).toBe(true);

    const html = await fetchError(502, HTML_PAGE, { method: "PATCH", contentType: "text/html" });
    expect(looksLikeUnknownField(html)).toBe(false);
  });

  it("isInaccessiblePathError matches the 422 path race, with the path redacted or not", async () => {
    const short = await fetchError(422, jsonApiErrors(422, "link.0.uri: The path '/sentinel' is inaccessible."), { method: "POST" });
    expect(isInaccessiblePathError(short)).toBe(true);

    const nested = await fetchError(422, jsonApiErrors(422, "link.0.uri: The path '/about/team' is inaccessible."), { method: "POST" });
    expect(isInaccessiblePathError(nested)).toBe(true);

    const forbidden = await fetchError(403, jsonApiErrors(403, "The path '/about/team' is inaccessible."), { method: "POST" });
    expect(isInaccessiblePathError(forbidden)).toBe(false);
  });

  it("isInaccessiblePathError still matches when a long violation comes first", async () => {
    const err = await fetchError(422, jsonApiErrors(422,
      `title: ${"This value is too long. ".repeat(40)}`,
      "link.0.uri: The path '/about/team' is inaccessible."
    ), { method: "POST" });
    expect(isInaccessiblePathError(err)).toBe(true);
  });

  it("classifyTargetError reads the status whatever the body is", async () => {
    expect(classifyTargetError(await fetchError(404, jsonApiErrors(404, "The requested resource was not found.")))).toBe("missing");
    expect(classifyTargetError(await fetchError(404, HTML_PAGE, { contentType: "text/html" }))).toBe("missing");
    expect(classifyTargetError(await fetchError(404, ""))).toBe("missing");
    expect(classifyTargetError(await fetchError(403, jsonApiErrors(403, "Access denied.")))).toBe("forbidden");
    expect(classifyTargetError(await fetchError(401, HTML_PAGE, { contentType: "text/html" }))).toBe("forbidden");
    expect(classifyTargetError(await fetchError(500, HTML_PAGE, { contentType: "text/html" }))).toBe("failed");
  });
});

// A status number inside the path or the detail is not the response status.
// Each matcher below used to test the whole message for a bare number (#355).
describe("matchers read the response status, not a number in the text", () => {
  it("drupalFetch and drupalGraphqlFetch errors carry the status", async () => {
    expect((await fetchError(500, jsonApiErrors(500, "Upstream answered 404."))).status).toBe(500);
    expect((await fetchError(404, "")).status).toBe(404);
    expect((await graphqlError(401, HTML_PAGE, "text/html")).status).toBe(401);
  });

  it("classifyTargetError does not read a 500 that mentions 404 as a missing target", async () => {
    const upstream = await fetchError(500, jsonApiErrors(500, "Upstream answered 404 for the media source."), { path: "/jsonapi/media/image/x" });
    expect(classifyTargetError(upstream)).toBe("failed");

    const quoted = await fetchError(500, jsonApiErrors(500, "Subrequest failed: Drupal 404 on GET /jsonapi/file/file/f1"));
    expect(classifyTargetError(quoted)).toBe("failed");

    const idInPath = await fetchError(403, jsonApiErrors(403, "Access denied."), { path: "/jsonapi/node/article/404" });
    expect(classifyTargetError(idInPath)).toBe("forbidden");
  });

  it("classifyTargetError reads a message with no status property only at its start", () => {
    expect(classifyTargetError(new Error("Drupal 404 on GET /jsonapi/node/page/n1: Not Found"))).toBe("missing");
    expect(classifyTargetError(new Error("Drupal 403 on GET /jsonapi/node/page/n1: Access denied"))).toBe("forbidden");
    expect(classifyTargetError(new Error("Upstream answered 404 for the media source."))).toBe("failed");
    expect(classifyTargetError(new Error("lookup failed: Drupal 404 on GET /jsonapi/x"))).toBe("failed");
    expect(classifyTargetError(new Error("connect ECONNREFUSED 10.0.0.4:404"))).toBe("failed");
  });

  it("isAuthError does not read a 401 or 403 in the path or the detail as an auth failure", async () => {
    const idInPath = await fetchError(404, jsonApiErrors(404, "The requested resource was not found."), { path: "/jsonapi/node/article/401" });
    expect(isAuthError(idInPath)).toBe(false);

    const detail = await fetchError(500, jsonApiErrors(500, "Node 401 could not be rendered."));
    expect(isAuthError(detail)).toBe(false);

    const tokenWord = await fetchError(500, jsonApiErrors(500, "Replacement token [node:403] could not be resolved."));
    expect(isAuthError(tokenWord)).toBe(false);

    const graphql = await graphqlError(500, JSON.stringify({ errors: [{ message: "Entity 401 failed to load." }] }));
    expect(isAuthError(graphql)).toBe(false);

    expect(isAuthError(new Error("connect ECONNREFUSED 10.0.0.4:401"))).toBe(false);
  });

  it("isProbePassedWithoutSave does not read a failure that mentions Drupal 422 as a passed probe", async () => {
    const failed = await fetchError(500, jsonApiErrors(500, "Subrequest returned Drupal 422 while saving."), { method: "PATCH" });
    expect(isProbePassedWithoutSave(failed)).toBe(false);

    const denied = await fetchError(403, jsonApiErrors(403, "Denied. An earlier attempt ended in Drupal 422."), { method: "PATCH" });
    expect(isProbePassedWithoutSave(denied)).toBe(false);
  });

  it("isInaccessiblePathError does not read a 422 in the path or the detail as the 422 race", async () => {
    const forbidden = await fetchError(403, jsonApiErrors(403, "Menu link 422: the path '/about/team' is inaccessible."), { method: "POST" });
    expect(isInaccessiblePathError(forbidden)).toBe(false);

    const idInPath = await fetchError(500, jsonApiErrors(500, "The storage is inaccessible."), { method: "PATCH", path: "/jsonapi/menu_link_content/menu_link_content/422" });
    expect(isInaccessiblePathError(idInPath)).toBe(false);
  });

  it("a draft or inventory failure that mentions Drupal 404 is not an absent endpoint", async () => {
    const input = { entityType: "node", bundle: "page", id: "n1", attributes: { title: "T" }, draftRevision: { liveVid: "10", workingVid: "12" } };
    respondWith(500, jsonApiErrors(500, "Subrequest failed: Drupal 404 on GET /jsonapi/file/file/f1"));
    const draft = await writeDraft(backend, input, true).catch((err) => err);
    expect(isMissingDraftEndpoint(draft)).toBe(false);
    expect(draft.message).toContain("Drupal 500");

    respondWith(403, jsonApiErrors(403, "Denied. The upstream said Drupal 405."));
    const inventory = await readTranslationInventory(backend, { entityType: "node", bundle: "page", id: "n1" }).catch((err) => err);
    expect(isMissingTranslationEndpoint(inventory)).toBe(false);
  });
});
