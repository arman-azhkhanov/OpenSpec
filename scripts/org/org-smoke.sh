#!/bin/bash
# Org smoke: FULL delta cycle ADDED -> MODIFIED+RENAMED -> REMOVED on spec.org,
# plus the org-only surfaces the cycle alone does not touch (status, list with
# `[-]` in the denominator, show --json --deltas-only, the `:ID:` PIN across
# RENAMED). Runs the freshly built CLI; re-runnable (rebuilds its own sandbox).
#
# Leg design generalized from the VERIFY-SUITE agent's `vs-fullcycle-smoke.sh`
# (0818b, §3.4) — referenced, not copied: that script proves the three legs, this
# one keeps the CLI-surface steps the earlier org-smoke had and adds the legs it
# was missing.
#
# SELF-DESCRIPTION GATE: the header above claims legs. `assert_legs_present`
# below reads THIS FILE and fails if a claimed leg has no step of its own — the
# defect this rewrite closes was a header promising a cycle the body never ran
# (`feedback_selfdescription_sync`), and a promise nothing checks rots again.
#
# Usage: bash org-smoke.sh    ·   exit 0 = every step met its expectation.
set -u
CLI="${ORG_SMOKE_CLI:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/bin/openspec.js}"
SELF="${BASH_SOURCE[0]}"
SB="${ORG_SMOKE_SB:-$(mktemp -d)/org-smoke-run}"

PASS=0
FAIL=0
step() { printf '\n########## %s\n' "$*"; }
ok()   { PASS=$((PASS+1)); printf '  PASS  %s\n' "$*"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL  %s\n' "$*"; }
check_rc() { # check_rc <expected> <actual> <label>
  if [ "$1" = "$2" ]; then ok "$3 (RC=$2)"; else bad "$3 (RC=$2, expected $1)"; fi
}
check_has() { # check_has <file> <pattern> <label>
  if rg -q -- "$2" "$1"; then ok "$3"; else bad "$3 — pattern not found: $2"; fi
}

# ---------- SELF-DESCRIPTION GATE (runs before any CLI call) ----------
assert_legs_present() {
  local leg missing=0
  for leg in ADDED MODIFIED RENAMED REMOVED; do
    # Count the leg OUTSIDE this function and outside the header comment: a
    # mention in prose must not satisfy a claim about the body.
    local n
    n=$(rg -c "^step \"L[0-9].*$leg" "$SELF" || true)
    if [ -z "$n" ] || [ "$n" -eq 0 ]; then
      printf '  SELF-DESCRIPTION BROKEN: header claims %s, body runs no %s step\n' "$leg" "$leg"
      missing=$((missing+1))
    fi
  done
  if [ "$missing" -gt 0 ]; then FAIL=$((FAIL+missing)); else ok "self-description: all 4 claimed legs have steps"; fi
}
step "0. self-description gate"
assert_legs_present
# Control that the gate is not vacuous: a leg name that is NOT claimed and NOT
# run must come back absent by the very same form.
if [ -z "$(rg -c '^step "L[0-9].*DEPRECATED' "$SELF" || true)" ]; then
  ok "gate control: the same form reports absence for a leg that is not there"
else
  bad "gate control: form matched a leg that does not exist"
fi

rm -rf "$SB"; mkdir -p "$SB"; cd "$SB" || exit 1
export XDG_CONFIG_HOME="$SB/.xdgc" XDG_DATA_HOME="$SB/.xdgd"
OS() { OPENSPEC_TELEMETRY=0 OPENSPEC_NO_UPDATE_CHECK=1 node "$CLI" "$@"; }

mk_change() {
  mkdir -p "openspec/changes/$1/specs/data-export"
  printf 'schema: ibalta-org\n' > "openspec/changes/$1/.openspec.yaml"
  cat > "openspec/changes/$1/proposal.org" <<EOF
#+TITLE: $2

* Why

$2 — the reason this change exists.

* What Changes

- $2.

* Impact

None.
EOF
  cat > "openspec/changes/$1/tasks.org" <<'EOF'
* 1. Setup

- [X] 1.1 Create the export module
- [-] 1.2 Wire the endpoint
- [ ] 1.3 Add tests
EOF
}

step "0b. init + select the org schema"
OS init --tools none >/dev/null 2>&1; check_rc 0 $? "init --tools none"
printf 'schema: ibalta-org\n' > openspec/config.yaml

# ---------- LEG 1: ADDED ----------
step "L1a ADDED — stage the change"
mk_change add-export "Add data export"
cat > openspec/changes/add-export/specs/data-export/spec.org <<'EOF'
* Purpose

Lets users take their data out of the product in a portable, documented format.

* ADDED Requirements

** Documentation Requirements
A divider header, not a requirement — it must not become a delta.

** Requirement: User can export data
The system SHALL allow users to export their data in CSV format.

*** Scenario: Successful export
- *WHEN* the user asks for an export
- *THEN* the system writes a CSV file

** Requirement: Export is rate limited
The system SHALL rate limit export requests.

*** Scenario: Too many exports
- *WHEN* the user exceeds the quota
- *THEN* the system rejects the request
EOF

step "L1b ADDED — org-only CLI surfaces (status / list / show)"
OS status --change add-export > s.out 2>&1; check_rc 0 $? "status --change"
check_has s.out 'ibalta-org' "status names the org schema"
OS list --changes > l.out 2>&1; check_rc 0 $? "list --changes"
# `[-]` counts as UNDONE and stays IN the denominator: 3 tasks, 1 done.
check_has l.out '1/3 tasks' "list counts [-] in the denominator (1/3 tasks)"
OS show add-export --json --deltas-only > d.out 2>&1; check_rc 0 $? "show --json --deltas-only"
check_has d.out '"deltaCount": 2' "show reports 2 deltas (divider header excluded)"

step "L1c ADDED — validate + archive"
OS validate add-export --strict > v.out 2>&1; check_rc 0 $? "validate --strict"
OS archive add-export --yes > a.out 2>&1; check_rc 0 $? "archive --yes"
if [ -f openspec/specs/data-export/spec.org ]; then ok "main spec written as spec.org"; else bad "main spec missing"; fi
check_has openspec/specs/data-export/spec.org '^\*\* Requirement: User can export data' "org requirement header emitted"
ID_COUNT_BEFORE=$(rg -c -N '^:ID:' openspec/specs/data-export/spec.org 2>/dev/null || echo 0)
ID_BEFORE=$(rg -N '^:ID:' openspec/specs/data-export/spec.org 2>/dev/null | sort | md5 -q)
printf '  IDS_AFTER_ADDED count=%s md5=%s\n' "$ID_COUNT_BEFORE" "$ID_BEFORE"
if [ "$ID_COUNT_BEFORE" -ge 2 ]; then ok "two :ID: minted by ADDED"; else bad "expected 2 minted :ID:, found $ID_COUNT_BEFORE"; fi

# ---------- LEG 2: MODIFIED + RENAMED ----------
step "L2a MODIFIED + RENAMED — stage the change"
mk_change refine-export "Refine data export"
cat > openspec/changes/refine-export/specs/data-export/spec.org <<'EOF'
* MODIFIED Requirements

** Requirement: User can export data
The system SHALL allow users to export their data in CSV and JSON formats.

*** Scenario: Successful export
- *WHEN* the user asks for an export
- *THEN* the system writes a CSV or JSON file

* RENAMED Requirements

- FROM: ** Requirement: Export is rate limited
- TO: ** Requirement: Export is throttled per account
EOF

step "L2b MODIFIED + RENAMED — validate + archive + the :ID: PIN"
OS validate refine-export --strict > v2.out 2>&1; check_rc 0 $? "validate --strict"
OS archive refine-export --yes > a2.out 2>&1; check_rc 0 $? "archive --yes"
check_has openspec/specs/data-export/spec.org 'JSON formats' "MODIFIED body landed"
check_has openspec/specs/data-export/spec.org '^\*\* Requirement: Export is throttled per account' "RENAMED header landed"
ID_AFTER=$(rg -N '^:ID:' openspec/specs/data-export/spec.org 2>/dev/null | sort | md5 -q)
printf '  IDS_AFTER_RENAME md5=%s\n' "$ID_AFTER"
# The PIN is only a fact if there WERE ids to pin: two empty sets have the same
# md5, and calling that "unchanged" is how a missing spec passes as a green PIN.
if [ "$ID_COUNT_BEFORE" -lt 2 ]; then
  bad ":ID: PIN not measurable — ADDED minted $ID_COUNT_BEFORE ids, nothing to pin"
elif [ "$ID_BEFORE" = "$ID_AFTER" ]; then
  ok ":ID: set unchanged across RENAMED (plan §3(a) PIN, $ID_COUNT_BEFORE ids)"
else
  bad ":ID: set changed across RENAMED (before=$ID_BEFORE after=$ID_AFTER)"
fi

# ---------- LEG 3: REMOVED ----------
step "L3a REMOVED — stage the change"
mk_change drop-export "Drop the throttling requirement"
cat > openspec/changes/drop-export/specs/data-export/spec.org <<'EOF'
* REMOVED Requirements

** Requirement: Export is throttled per account
The throttling requirement is withdrawn.

*** Scenario: Too many exports
- *WHEN* the user exceeds the quota
- *THEN* the system rejects the request
EOF

step "L3b REMOVED — validate + archive"
OS validate drop-export --strict > v3.out 2>&1; check_rc 0 $? "validate --strict"
OS archive drop-export --yes > a3.out 2>&1; check_rc 0 $? "archive --yes"
# Absence only means removal if the requirement was PRESENT before this leg and
# a main spec exists to be absent from — otherwise "gone" is just "never there".
if [ ! -f openspec/specs/data-export/spec.org ]; then
  bad "REMOVED not measurable — no main spec exists"
elif rg -q '^\*\* Requirement: User can export data' openspec/specs/data-export/spec.org; then
  if rg -q '^\*\* Requirement: Export is throttled per account' openspec/specs/data-export/spec.org; then
    bad "REMOVED requirement is still in the main spec"
  else
    ok "REMOVED requirement gone, the untouched one still there (both signs)"
  fi
else
  bad "REMOVED not measurable — the spec lost the requirement that must SURVIVE"
fi

step "4. resulting tree"
find openspec/specs -type f | sort
ls openspec/changes/archive/ 2>/dev/null
printf '\n===== main spec =====\n'
cat openspec/specs/data-export/spec.org 2>/dev/null

printf '\n########## SUMMARY: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
