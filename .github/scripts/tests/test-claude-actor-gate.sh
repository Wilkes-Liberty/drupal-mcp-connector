#!/usr/bin/env bash
# Regression tests for the @claude gate (DEV-1197, Wilkes-Liberty/vault#852).
#
# Part 1 runs .github/scripts/claude-actor-gate.sh against the cases that
# must be refused or allowed. Part 2 checks .github/workflows/claude.yml is
# wired so the gate actually decides, and plants known-bad copies to prove
# each static check can fail. Run from the repository root:
#
#   bash .github/scripts/tests/test-claude-actor-gate.sh
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
gate="$root/.github/scripts/claude-actor-gate.sh"
workflow="$root/.github/workflows/claude.yml"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

failures=0
fail() {
  printf 'FAIL: %s\n' "$1"
  failures=$((failures + 1))
}

# run_gate EXPECTED NAME [VAR=value | -u VAR ...]
# Defaults describe an allowed human; each case overrides or unsets
# (-u VAR) only what it tests. The gate runs with an otherwise empty
# environment so nothing from the caller leaks in.
run_gate() {
  local expected="$1" name="$2"
  shift 2
  declare -A vars=(
    [CLAUDE_ALLOWED_ACTORS]="alice, Bob"
    [ACTOR]=alice
    [TRIGGERING_ACTOR]=alice
    [SENDER_LOGIN]=alice
    [SENDER_TYPE]=User
    [AUTHOR_ASSOCIATION]=MEMBER
  )
  while (($#)); do
    if [[ "$1" == "-u" ]]; then
      unset "vars[$2]"
      shift 2
    else
      vars["${1%%=*}"]="${1#*=}"
      shift
    fi
  done
  local out="$scratch/output"
  local -a assignments=("PATH=$PATH" "GITHUB_OUTPUT=$out")
  local key
  for key in "${!vars[@]}"; do
    assignments+=("$key=${vars[$key]}")
  done
  : >"$out"
  if ! env -i "${assignments[@]}" bash "$gate" >"$scratch/log" 2>&1; then
    fail "$name: gate exited non-zero"
    return
  fi
  local got_allowed
  got_allowed="$(grep '^allowed=' "$out" || true)"
  if [[ "$got_allowed" != "allowed=$expected" ]]; then
    fail "$name: expected allowed=$expected, got '$got_allowed'"
  fi
  # RUN_ATTEMPT is optional for these cases. When it is a positive integer
  # the gate must record it next to the decision, including on a refusal.
  # Any other supplied value fails closed and must not be copied out.
  if [[ -n "${vars[RUN_ATTEMPT]+x}" ]]; then
    local got_attempt
    got_attempt="$(grep '^attempt=' "$out" || true)"
    if [[ "${vars[RUN_ATTEMPT]}" =~ ^[1-9][0-9]*$ ]]; then
      if [[ "$got_attempt" != "attempt=${vars[RUN_ATTEMPT]}" ]]; then
        fail "$name: expected attempt=${vars[RUN_ATTEMPT]}, got '$got_attempt'"
      fi
    elif [[ -n "$got_attempt" ]]; then
      fail "$name: recorded a malformed run attempt"
    fi
  elif grep -q '^attempt=' "$out"; then
    fail "$name: wrote attempt without RUN_ATTEMPT"
  fi
}

run_gate true "listed human with MEMBER association"
run_gate true "logins compare case-insensitively" ACTOR=BOB TRIGGERING_ACTOR=bob SENDER_LOGIN=Bob
run_gate true "newline-separated list" CLAUDE_ALLOWED_ACTORS=$'carol\nalice'
run_gate true "OWNER association" AUTHOR_ASSOCIATION=OWNER
run_gate true "COLLABORATOR association" AUTHOR_ASSOCIATION=COLLABORATOR

run_gate false "unset allowlist fails closed" -u CLAUDE_ALLOWED_ACTORS
run_gate false "empty allowlist fails closed" CLAUDE_ALLOWED_ACTORS=
run_gate false "allowlist of separators only fails closed" CLAUDE_ALLOWED_ACTORS=" , ,"
run_gate false "actor not on the list" ACTOR=mallory TRIGGERING_ACTOR=mallory SENDER_LOGIN=mallory
run_gate false "re-run by someone not on the list" TRIGGERING_ACTOR=mallory
run_gate false "sender not on the list" SENDER_LOGIN=mallory
run_gate false "list prefix is not a match" CLAUDE_ALLOWED_ACTORS=alice2 ACTOR=alice
run_gate false "Bot sender type" SENDER_TYPE=Bot
run_gate false "Organization sender type" SENDER_TYPE=Organization
run_gate false "missing sender type" -u SENDER_TYPE
run_gate false "[bot] login even if listed" CLAUDE_ALLOWED_ACTORS="alice,claude[bot]" ACTOR="claude[bot]"
run_gate false "[BOT] suffix in another case" TRIGGERING_ACTOR="Alice[BOT]"
run_gate false "empty actor" ACTOR=
run_gate false "malformed login" ACTOR="alice;id" CLAUDE_ALLOWED_ACTORS="alice;id"
run_gate false "CONTRIBUTOR association" AUTHOR_ASSOCIATION=CONTRIBUTOR
run_gate false "NONE association" AUTHOR_ASSOCIATION=NONE
run_gate false "missing association" -u AUTHOR_ASSOCIATION

run_gate true "records the run attempt beside the decision" RUN_ATTEMPT=1
run_gate true "records a later run attempt" RUN_ATTEMPT=2
run_gate false "denial still records a valid attempt" RUN_ATTEMPT=3 ACTOR=mallory TRIGGERING_ACTOR=mallory SENDER_LOGIN=mallory
run_gate false "zero run attempt fails closed" RUN_ATTEMPT=0
run_gate false "empty run attempt fails closed" RUN_ATTEMPT=
run_gate false "malformed run attempt fails closed" RUN_ATTEMPT=1x

# The refusal log must not echo logins an outside account controls.
run_gate false "log hygiene" ACTOR=mallory TRIGGERING_ACTOR=mallory SENDER_LOGIN=mallory
if grep -q mallory "$scratch/log"; then
  fail "gate log echoed an actor login"
fi

# A rejected attempt value is caller-controlled on a hostile runner; the
# fixed denial must not copy it into the log.
run_gate false "attempt value is not logged" RUN_ATTEMPT=$'2\n::notice::pwned'
if grep -q pwned "$scratch/log"; then
  fail "gate log echoed the run attempt"
fi

# ---------------------------------------------------------------- workflow
# check_workflow FILE -> prints one line per problem, nothing when clean.
check_workflow() {
  local file="$1"
  grep -qE '^permissions: \{\}$' "$file" ||
    echo "workflow-level permissions are not empty"
  grep -qE '^\s+CLAUDE_ALLOWED_ACTORS: \$\{\{ vars\.CLAUDE_ALLOWED_ACTORS \}\}$' "$file" ||
    echo "gate does not read vars.CLAUDE_ALLOWED_ACTORS"
  grep -qE 'run: bash \.github/scripts/claude-actor-gate\.sh$' "$file" ||
    echo "authorize job does not run the gate script"
  grep -qE '^\s+needs: authorize$' "$file" ||
    echo "claude job does not depend on authorize"
  # shellcheck disable=SC2016 # a literal GitHub expression, not shell
  grep -qF 'RUN_ATTEMPT: ${{ github.run_attempt }}' "$file" ||
    echo "gate does not receive github.run_attempt"
  # shellcheck disable=SC2016 # a literal GitHub expression, not shell
  grep -qF 'attempt: ${{ steps.gate.outputs.attempt }}' "$file" ||
    echo "attempt output is not taken from the gate step"
  # The Claude job's if must require this attempt's gate output. A partial
  # re-run freezes steps.gate.outputs and only changes github.run_attempt.
  local claude_if
  claude_if="$(awk '
    /^  claude:/ { job = 1; next }
    job && /^  [a-z0-9-]+:/ { job = 0 }
    job && /^    if:/ { show = 1 }
    show { print }
    show && /^    [a-z]/ && !/^    if:/ { show = 0 }
  ' "$file")"
  grep -qF "needs.authorize.outputs.allowed == 'true'" <<<"$claude_if" ||
    echo "claude job is not conditioned on the gate output"
  # shellcheck disable=SC2016 # a literal GitHub expression, not shell
  grep -qF "needs.authorize.outputs.attempt == format('{0}', github.run_attempt)" <<<"$claude_if" ||
    echo "claude job does not bind authorization to this run attempt"
  # If a partial re-run still starts the job, the default-branch gate must
  # refuse before the action. The PR checkout cannot be the script source.
  local claude_body gate_at action_at
  claude_body="$(awk '
    /^  claude:/ { job = 1; next }
    job && /^  [a-z0-9-]+:/ { job = 0 }
    job { print }
  ' "$file")"
  grep -qF 'path: .gate' <<<"$claude_body" ||
    echo "claude job does not isolate the default-branch gate checkout"
  grep -qF 'bash .gate/.github/scripts/claude-actor-gate.sh' <<<"$claude_body" ||
    echo "claude job does not re-run the trusted gate"
  grep -qF "grep -qx 'allowed=true'" <<<"$claude_body" ||
    echo "claude job does not fail closed when the fresh gate refuses"
  gate_at="$(awk '/bash \.gate\/\.github\/scripts\/claude-actor-gate\.sh/ { print NR; exit }' <<<"$claude_body")"
  action_at="$(awk '/anthropics\/claude-code-action/ { print NR; exit }' <<<"$claude_body")"
  if [[ -z "$gate_at" || -z "$action_at" || "$gate_at" -ge "$action_at" ]]; then
    echo "trusted gate does not run before the Claude action"
  fi
  grep -qF "github.event.sender.type != 'Bot'" "$file" ||
    echo "Bot senders are not filtered before a runner starts"
  grep -qF "!endsWith(github.actor, '[bot]')" "$file" ||
    echo "[bot] actors are not filtered before a runner starts"
  # shellcheck disable=SC2016 # a literal GitHub expression, not shell
  grep -qF 'ref: ${{ github.event.repository.default_branch }}' "$file" ||
    echo "gate checkout is not pinned to the default branch"
  grep -qE '^\s+persist-credentials: false$' "$file" ||
    echo "gate checkout keeps the token in .git/config"
  # Only the claude job may hold write scopes; it must be the last job.
  awk '/^  authorize:/{a=1} /^  claude:/{a=0} a && /: write/' "$file" | grep -q . &&
    echo "authorize job has write permissions"

  # Turn cap: max_turns input (reusable) or --max-turns flag (inline).
  local turns
  turns="$(grep -oE '(max_turns: |--max-turns )[0-9]+' "$file" | grep -oE '[0-9]+$' || true)"
  if [[ -z "$turns" ]]; then
    echo "no explicit turn cap"
  else
    while read -r n; do
      ((n <= 15)) || echo "turn cap $n is above 15"
    done <<<"$turns"
  fi

  # No ${{ }} inside any run: script; event data must arrive through env:.
  awk '
    function indent(s) { match(s, /^ */); return RLENGTH }
    inrun && NF && indent($0) <= runindent { inrun = 0 }
    inrun && /\$\{\{/ { print "expression inside run: at line " NR }
    /^ *(- )?run:/ {
      line = $0
      runindent = indent(line)
      if (line ~ /- run:/) runindent += 2
      rest = line
      sub(/^ *(- )?run: */, "", rest)
      if (rest ~ /\$\{\{/) print "expression inside run: at line " NR
      if (rest ~ /^[|>]/) inrun = 1
    }
  ' "$file"
}

problems="$(check_workflow "$workflow")"
if [[ -n "$problems" ]]; then
  while IFS= read -r line; do fail "claude.yml: $line"; done <<<"$problems"
fi

# Planted regressions: each must be caught.
plant() {
  local name="$1" sed_expr="$2" bad="$scratch/bad.yml"
  sed -E "$sed_expr" "$workflow" >"$bad"
  if cmp -s "$workflow" "$bad"; then
    fail "planted '$name' did not change the workflow (test is stale)"
  elif [[ -z "$(check_workflow "$bad")" ]]; then
    fail "planted '$name' was not detected"
  fi
}
plant "allowlist removed" '/CLAUDE_ALLOWED_ACTORS: /d'
plant "gate output ignored" "s/needs\.authorize\.outputs\.allowed == 'true'/always()/"
plant "attempt binding removed" '/needs\.authorize\.outputs\.attempt/d'
plant "run attempt not passed to the gate" '/RUN_ATTEMPT: /d'
plant "in-job gate removed" '/bash \.gate\/\.github\/scripts\/claude-actor-gate\.sh/d'
# shellcheck disable=SC2016 # a literal GitHub expression, not shell
plant "attempt output re-read from the context" 's#attempt: \$\{\{ steps\.gate\.outputs\.attempt \}\}#attempt: ${{ github.run_attempt }}#'
plant "write scope at workflow level" 's/^permissions: \{\}$/permissions: write-all/'
plant "turn cap raised" 's/(max_turns: |--max-turns )[0-9]+/\150/'
# shellcheck disable=SC2016 # a literal GitHub expression, not shell
plant "event data in run:" 's#run: bash \.github/scripts/claude-actor-gate\.sh#run: echo "${{ github.event.comment.body }}"#'
plant "bot filter removed" "s/github\.event\.sender\.type != 'Bot'/true/"
plant "unpinned gate checkout" '/ref: \$\{\{ github\.event\.repository\.default_branch \}\}/d'

if ((failures > 0)); then
  printf '%d failure(s)\n' "$failures"
  exit 1
fi
echo "claude gate: all checks passed"
