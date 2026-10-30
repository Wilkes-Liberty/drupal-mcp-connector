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
  if [[ "$(cat "$out")" != "allowed=$expected" ]]; then
    fail "$name: expected allowed=$expected, got '$(cat "$out")'"
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

# The refusal log must not echo logins an outside account controls.
run_gate false "log hygiene" ACTOR=mallory TRIGGERING_ACTOR=mallory SENDER_LOGIN=mallory
if grep -q mallory "$scratch/log"; then
  fail "gate log echoed an actor login"
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
  grep -qE "^\s+if: needs\.authorize\.outputs\.allowed == 'true'$" "$file" ||
    echo "claude job is not conditioned on the gate output"
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
