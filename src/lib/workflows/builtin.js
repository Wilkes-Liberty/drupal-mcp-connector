/**
 * Connector-authored workflow definitions (#333).
 *
 * Public names and steps match the previous hand-written prompts in
 * src/index.js. They go through the same loader as module workflows.
 */

const SITE = { name: "site", description: "Named site (omit for default)", required: false };

export const builtinWorkflowProvider = {
  id: "builtin",
  namespace: "builtin",
  builtin: true,
  workflows: [
    {
      id: "content_audit",
      name: "drupal-content-audit",
      description: "Walk through a full content audit: inventory, staleness, SEO gaps, accessibility issues, and recommendations.",
      readOnly: true,
      tools: [
        "drupal_report_content_summary",
        "drupal_report_stale_content",
        "drupal_report_field_completeness",
        "drupal_report_seo_meta_coverage",
        "drupal_report_seo_audit",
        "drupal_report_accessibility_audit",
      ],
      arguments: [SITE],
      instructions:
        "Please run a comprehensive content audit {arg:site_phrase}. Do not assume any particular content type exists — every site has a different model, so discover it first and audit the types this site actually has.\n" +
        "1. Call {tool:drupal_report_content_summary} for the full inventory. Its byContentType list is the set of content types to audit — derive the types from it; never assume a fixed type such as \"article\".\n" +
        "2. For each content type that has nodes, call {tool:drupal_report_stale_content} (days: 180).\n" +
        "3. For each content type that has nodes, call {tool:drupal_report_field_completeness}.\n" +
        "4. For each content type with published nodes, check SEO: prefer {tool:drupal_report_seo_meta_coverage} (it reads the site's actual meta field rather than assuming one) and use {tool:drupal_report_seo_audit} for title-length and thin-content checks.\n" +
        "5. For each content type with published nodes, call {tool:drupal_report_accessibility_audit}.\n" +
        "6. For any content type reporting zero nodes, skip its per-type scans and record it as empty — an empty type is not a clean one.\n" +
        "7. Synthesize findings into: (a) immediate actions, (b) medium-term improvements, (c) process recommendations.\n" +
        "Present results as a structured report with counts, severity, and specific node links where possible. State which content types were scanned so an empty or unexpected model cannot be mistaken for a clean audit.",
    },
    {
      id: "create_article",
      name: "drupal-create-article",
      description: "Guided workflow to research, draft, and publish an article node with all fields, tags, and metadata.",
      readOnly: false,
      tools: [
        "drupal_list_content_types",
        "drupal_get_entity_schema",
        "drupal_list_vocabularies",
        "drupal_get_taxonomy_terms",
        "drupal_create_node",
      ],
      arguments: [
        SITE,
        { name: "topic", description: "Article topic/brief", required: true },
      ],
      instructions:
        "I need to create a new article {arg:site_phrase} about: {arg:topic}\n\n" +
        "Please:\n" +
        "1. Call {tool:drupal_list_content_types} to confirm \"article\" exists and check its fields.\n" +
        "2. Call {tool:drupal_get_entity_schema} for node/article to see all available fields.\n" +
        "3. Call {tool:drupal_list_vocabularies} and {tool:drupal_get_taxonomy_terms} for relevant vocabularies.\n" +
        "4. Draft the article — title, body (well-structured HTML), summary, and meta description.\n" +
        "5. Suggest appropriate taxonomy tags.\n" +
        "6. Call {tool:drupal_create_node} with status: false (draft) and show me the result.\n" +
        "7. Ask me to review before publishing.",
    },
    {
      id: "seo_fix",
      name: "drupal-seo-fix",
      description: "Find SEO gaps in content (missing meta descriptions, thin content, title issues) and fix them interactively.",
      readOnly: false,
      tools: ["drupal_report_seo_audit"],
      arguments: [
        SITE,
        { name: "type", description: "Content type to scan", required: false },
      ],
      instructions:
        "Please find and fix SEO issues in \"{arg:type}\" content {arg:site_phrase}.\n\n" +
        "1. Call {tool:drupal_report_seo_audit} to identify all issues.\n" +
        "2. For nodes missing meta descriptions: generate appropriate descriptions (max 160 chars) and update them.\n" +
        "3. For thin content (under 300 words): flag for editorial review — do not auto-expand.\n" +
        "4. For title length issues: suggest better titles but ask before updating.\n" +
        "5. Report what was fixed, what needs human review, and any patterns you noticed.",
    },
    {
      id: "user_cleanup",
      name: "drupal-user-cleanup",
      description: "Identify inactive, never-logged-in, or overly permissioned user accounts and take action.",
      readOnly: false,
      tools: ["drupal_report_user_activity", "drupal_list_users", "drupal_list_roles"],
      arguments: [SITE],
      instructions:
        "Please audit user accounts {arg:site_phrase} and recommend cleanup actions.\n\n" +
        "1. Call {tool:drupal_report_user_activity} to identify inactive and never-logged-in accounts.\n" +
        "2. Call {tool:drupal_list_users} with no filter to get the full list.\n" +
        "3. Call {tool:drupal_list_roles} to see all available roles.\n" +
        "4. Identify: (a) accounts inactive 90+ days, (b) never-logged-in accounts, (c) accounts with admin roles that look like test/temp accounts.\n" +
        "5. For each category, recommend action (block, delete, or keep) with reasoning.\n" +
        "6. Ask for approval before making any changes.",
    },
    {
      id: "full_audit",
      name: "drupal-full-audit",
      description: "Run a full site-health audit — content, link/404 integrity, and configuration posture — and turn the scored dashboard into a prioritized action plan.",
      readOnly: true,
      tools: [
        "drupal_audit_site_health",
        "drupal_report_404_log",
        "drupal_report_redirect_health",
        "drupal_report_broken_links",
        "drupal_audit_config_best_practices",
        "drupal_report_module_audit",
        "drupal_report_permission_audit",
        "drupal_report_pii_exposure",
        "drupal_report_duplicate_content",
        "drupal_report_readability",
      ],
      arguments: [
        SITE,
        { name: "type", description: "Primary content type to audit", required: false },
      ],
      instructions:
        "Please run a full site-health audit {arg:site_phrase} and turn it into a prioritized action plan.\n\n" +
        "1. Call {tool:drupal_audit_site_health} (type: \"{arg:type}\") for the scored dashboard and overall grade.\n" +
        "2. For any section reporting high-severity findings, drill in with the matching tool for detail:\n" +
        "   - links/404: {tool:drupal_report_404_log}, {tool:drupal_report_redirect_health}, {tool:drupal_report_broken_links} (checkLive only with approval).\n" +
        "   - config: {tool:drupal_audit_config_best_practices}, {tool:drupal_report_module_audit}, {tool:drupal_report_permission_audit}.\n" +
        "   - content: {tool:drupal_report_pii_exposure}, {tool:drupal_report_duplicate_content}, {tool:drupal_report_readability}.\n" +
        "3. For sections reported 'unavailable', note what (server-tool bridge or drush) would enable them — do not treat unavailable as 'passing'.\n" +
        "4. Synthesize a prioritized plan: (a) high-severity/security fixes first, (b) content-quality improvements, (c) process recommendations.\n" +
        "5. Present counts, severity, and specific node/config references; propose redirects for the top 404s. Ask before making any changes.",
    },
  ],
};
