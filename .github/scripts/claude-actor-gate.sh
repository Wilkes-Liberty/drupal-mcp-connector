#!/usr/bin/env bash
# Decides whether a comment or review may start a Claude run.
#
# Called by the "authorize" job in .github/workflows/claude.yml. Every value
# comes in through the environment (never interpolated into the script), and
# the only thing written back is allowed=true|false on $GITHUB_OUTPUT.
#
# Rules, all of which must hold (DEV-1197, Wilkes-Liberty/vault#852):
#   - CLAUDE_ALLOWED_ACTORS (repo or org variable) names the humans who may
#     start a run, separated by commas and/or whitespace. Empty or unset
#     means nobody: the gate fails closed instead of falling back to
#     author_association, which a shared login can satisfy.
#   - The sender is a User account, not a Bot, and no login involved ends
#     in "[bot]".
#   - github.actor, github.triggering_actor and the event sender are all on
#     the list (a re-run is checked against whoever pressed re-run).
#   - The comment or review author is still OWNER, MEMBER or COLLABORATOR.
#
# A refusal is not an error: the script exits 0 with allowed=false so the
# Claude job is skipped instead of every stray @claude turning CI red.
set -euo pipefail

result=false

emit() {
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf 'allowed=%s\n' "$result" >>"$GITHUB_OUTPUT"
  fi
  printf 'allowed=%s\n' "$result"
}

# Reasons are fixed strings. Logins are not echoed, so nothing an outside
# account controls ends up in the log or can look like a workflow command.
deny() {
  printf 'Claude run skipped: %s\n' "$1"
  emit
  exit 0
}

lower() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

# GitHub logins: letters, digits and single hyphens, at most 39 characters.
valid_login() {
  [[ "$1" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?$ ]]
}

declare -A allowed=()
# Split on commas and any whitespace; ignore empty entries.
read -r -a entries <<<"$(printf '%s' "${CLAUDE_ALLOWED_ACTORS:-}" | tr ',\n\r\t' '    ')"
for entry in "${entries[@]}"; do
  if valid_login "$entry"; then
    allowed["$(lower "$entry")"]=1
  fi
done
if [[ ${#allowed[@]} -eq 0 ]]; then
  deny "CLAUDE_ALLOWED_ACTORS is empty, so no one is allowed (fail closed)"
fi

if [[ "${SENDER_TYPE:-}" != "User" ]]; then
  deny "the event sender is not a User account"
fi

for login in "${ACTOR:-}" "${TRIGGERING_ACTOR:-}" "${SENDER_LOGIN:-}"; do
  if [[ "$(lower "$login")" == *"[bot]" ]]; then
    deny "bot accounts cannot start Claude"
  fi
  if ! valid_login "$login"; then
    deny "missing or malformed actor login"
  fi
  if [[ -z "${allowed[$(lower "$login")]:-}" ]]; then
    deny "an actor is not in CLAUDE_ALLOWED_ACTORS"
  fi
done

case "${AUTHOR_ASSOCIATION:-}" in
  OWNER | MEMBER | COLLABORATOR) ;;
  *) deny "the author is not an owner, member or collaborator" ;;
esac

result=true
emit
