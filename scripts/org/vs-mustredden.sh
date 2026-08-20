#!/bin/bash
# VERIFY-SUITE: the FOUR must-redden readiness criteria (seed §КРИТЕРИЙ ГОТОВНОСТИ,
# referenced by plan §5). Every plant: mutate IN THE TREE, run through the CLI
# (executable path), record BOTH SIGNS, restore, verify md5 == pre-plant.
# A plant whose md5 does not move prints DEAD PLANT and the run is void.
#
# ⚠ CRITERION 4 WAS A ZOMBIE UNTIL 0820b. Its seed wording — "empty the scenario
# BODY ⇒ 'Scenario text cannot be empty'" — is unreachable in BOTH formats: a
# scenario with no body is never constructed by the parser, so `rawText.min(1)`
# (constants.SCENARIO_EMPTY) has no way to fire. The script ran the plant, the
# md5 moved, and the RED side printed `Change 'mr' is valid` RC=0 — a criterion
# that could not fail, reported as if it had passed. The LIVE redaction is plan
# §5 (`_openspec-patch-plan-0817g.org`, measured 0818c on both formats):
# subtract the requirement's ONLY `Scenario:` block ⇒ RC=1, "must include at
# least one scenario". No new check is introduced — it reddens the validator's
# existing `scenarioCount < 1` branch, so the criterion measures the
# implementation and not itself.
#
# Every criterion below now ends in an explicit verdict line. A RED side that
# comes back green prints ⛔ CRITERION DID NOT REDDEN and sets the exit code,
# which is what the zombie above needed and did not have.
set -u
CLI="${ORG_SMOKE_CLI:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/bin/openspec.js}"
SB="${ORG_SMOKE_SB:-$(mktemp -d)/vs-mr-run}"
rm -rf "$SB"; mkdir -p "$SB"; cd "$SB" || exit 1
export XDG_CONFIG_HOME="$SB/.xdgc" XDG_DATA_HOME="$SB/.xdgd"
OS() { OPENSPEC_TELEMETRY=0 OPENSPEC_NO_UPDATE_CHECK=1 node "$CLI" "$@"; }
step() { printf '\n=========== %s\n' "$*"; }

FAILED=0
verdict() { # $1=criterion $2=ok?(0/1) $3=why
  if [ "$2" = 0 ]; then printf 'VERDICT %s: PASS — %s\n' "$1" "$3"
  else printf '⛔ VERDICT %s: CRITERION DID NOT REDDEN — %s\n' "$1" "$3"; FAILED=1; fi; }

OS init --tools none >/dev/null 2>&1
printf 'schema: ibalta-org\n' > openspec/config.yaml

mkc() { mkdir -p "openspec/changes/$1/specs/data-export"; printf 'schema: ibalta-org\n' > "openspec/changes/$1/.openspec.yaml"
cat > "openspec/changes/$1/proposal.org" <<'EOF'
#+TITLE: Add data export

* Why

Users cannot take their data out today.

* What Changes

- Add a CSV export endpoint.

* Impact

None.
EOF
}

mkc mr
cat > openspec/changes/mr/tasks.org <<'EOF'
* 1. Setup

- [X] 1.1 Create the export module
- [x] 1.2 Register the route
- [-] 1.3 Wire the endpoint
- [ ] 1.4 Add tests
EOF
cat > openspec/changes/mr/specs/data-export/spec.org <<'EOF'
* ADDED Requirements

** Requirement: User can export data
The system SHALL allow users to export their data in CSV format.

*** Scenario: Successful export
- *WHEN* the user asks for an export
- *THEN* the system writes a CSV file
EOF

TASKS=openspec/changes/mr/tasks.org
SPEC=openspec/changes/mr/specs/data-export/spec.org
YAML=openspec/changes/mr/.openspec.yaml

plant_check() { # $1=file $2=md5before
  local now; now=$(md5 -q "$1")
  if [ "$now" = "$2" ]; then echo "⛔ DEAD PLANT — md5 did not move on $1"; FAILED=1; return 1; fi
  echo "plant landed: $2 -> $now"; }
restore_check() { # $1=file $2=md5before
  local now; now=$(md5 -q "$1")
  if [ "$now" = "$2" ]; then echo "restore OK (md5 $now)"; else echo "⛔ RESTORE FAILED on $1"; FAILED=1; fi; }
# Runs `validate <change> --strict`, prints the deciding lines, returns the CLI's RC.
validate_strict() { # $1=change
  local out rc
  out=$(OS validate "$1" --strict 2>&1); rc=$?
  printf '%s\n' "$out" | rg -N 'is valid|ERROR' | head -3
  echo "RC=$rc"
  LAST_OUT="$out"
  return $rc; }

########################################################################
step "CRIT-1  checkbox flip -> openspec list changes k/n"
M0=$(md5 -q $TASKS); cp $TASKS $TASKS.bak
echo "--- GREEN side (before):"; G1=$(OS list --changes 2>&1); echo "$G1"; echo "RC=$?"
sed -i '' 's/- \[ \] 1.4 Add tests/- [X] 1.4 Add tests/' $TASKS
plant_check $TASKS $M0
echo "--- RED side (after flip):"; R1=$(OS list --changes 2>&1); echo "$R1"; echo "RC=$?"
# This criterion's sign is the COUNT, not the exit code: the flip must move k/n.
if [ "$G1" = "$R1" ]; then verdict CRIT-1 1 "list output identical before and after the flip"
else verdict CRIT-1 0 "flip moved the task count ($(printf '%s' "$G1" | rg -No '[0-9]+/[0-9]+ tasks' | head -1) -> $(printf '%s' "$R1" | rg -No '[0-9]+/[0-9]+ tasks' | head -1))"; fi
cp $TASKS.bak $TASKS; restore_check $TASKS $M0

########################################################################
step "CRIT-2  scenario level shift -> validate --strict"
M0=$(md5 -q $SPEC); cp $SPEC $SPEC.bak
echo "--- GREEN side (before):"; validate_strict mr; G=$?
sed -i '' 's/^\*\*\* Scenario:/** Scenario:/' $SPEC
plant_check $SPEC $M0
echo "--- RED side (after shift):"; validate_strict mr; R=$?
if [ "$G" = 0 ] && [ "$R" != 0 ]; then verdict CRIT-2 0 "green RC=$G, red RC=$R"
else verdict CRIT-2 1 "green RC=$G, red RC=$R"; fi
cp $SPEC.bak $SPEC; restore_check $SPEC $M0

########################################################################
step "CRIT-3  drop skip_specs on an EMPTY specs/ -> 'must have at least one delta'"
mkc mrempty; rm -rf openspec/changes/mrempty/specs
printf 'schema: ibalta-org\nskip_specs: true\n' > openspec/changes/mrempty/.openspec.yaml
Y=openspec/changes/mrempty/.openspec.yaml; M0=$(md5 -q $Y); cp $Y $Y.bak
echo "--- GREEN side (skip_specs: true):"; validate_strict mrempty; G=$?
printf 'schema: ibalta-org\n' > $Y
plant_check $Y $M0
echo "--- RED side (skip_specs removed):"; validate_strict mrempty; R=$?
if [ "$G" = 0 ] && [ "$R" != 0 ]; then verdict CRIT-3 0 "green RC=$G, red RC=$R"
else verdict CRIT-3 1 "green RC=$G, red RC=$R"; fi
cp $Y.bak $Y; restore_check $Y $M0

########################################################################
# LIVE redaction (plan §5, 0818c). The seed's "empty the scenario body" wording
# is the zombie described at the top of this file — do not restore it.
step "CRIT-4  subtract the requirement's ONLY Scenario block -> 'must include at least one scenario'"
M0=$(md5 -q $SPEC); cp $SPEC $SPEC.bak
echo "--- GREEN side (before):"; validate_strict mr; G=$?
# Everything up to the Scenario header, i.e. the requirement keeps its prose and
# loses its one scenario. Subtraction, not a rewritten fixture: the diff against
# the green file is exactly the removed block.
sed -n '1,/^\*\*\* Scenario:/p' $SPEC.bak | sed '$d' > $SPEC
plant_check $SPEC $M0
echo "--- RED side (scenario block removed):"; validate_strict mr; R=$?
if [ "$G" = 0 ] && [ "$R" != 0 ] && printf '%s' "$LAST_OUT" | rg -qN 'must include at least one scenario'; then
  verdict CRIT-4 0 "green RC=$G, red RC=$R with the scenario-count message"
else
  verdict CRIT-4 1 "green RC=$G, red RC=$R (expected RC!=0 and 'must include at least one scenario')"
fi
cp $SPEC.bak $SPEC; restore_check $SPEC $M0

########################################################################
printf '\n=========== SUMMARY\n'
if [ "$FAILED" = 0 ]; then echo "all four criteria reddened; all plants landed and were restored"; else echo "⛔ at least one criterion did not redden or a plant/restore failed"; fi
exit $FAILED
