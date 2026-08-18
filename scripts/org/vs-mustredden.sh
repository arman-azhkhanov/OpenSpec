#!/bin/bash
# VERIFY-SUITE: the FOUR must-redden readiness criteria (seed §КРИТЕРИЙ ГОТОВНОСТИ,
# referenced by plan §5). Every plant: mutate IN THE TREE, run through the CLI
# (executable path), record BOTH SIGNS, restore, verify md5 == pre-plant.
# A plant whose md5 does not move prints DEAD PLANT and the run is void.
set -u
CLI="${ORG_SMOKE_CLI:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/bin/openspec.js}"
SB="${ORG_SMOKE_SB:-$(mktemp -d)/vs-mr-run}"
rm -rf "$SB"; mkdir -p "$SB"; cd "$SB" || exit 1
export XDG_CONFIG_HOME="$SB/.xdgc" XDG_DATA_HOME="$SB/.xdgd"
OS() { OPENSPEC_TELEMETRY=0 OPENSPEC_NO_UPDATE_CHECK=1 node "$CLI" "$@"; }
step() { printf '\n=========== %s\n' "$*"; }

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
  if [ "$now" = "$2" ]; then echo "⛔ DEAD PLANT — md5 did not move on $1"; return 1; fi
  echo "plant landed: $2 -> $now"; }
restore_check() { # $1=file $2=md5before
  local now; now=$(md5 -q "$1")
  if [ "$now" = "$2" ]; then echo "restore OK (md5 $now)"; else echo "⛔ RESTORE FAILED on $1"; fi; }

########################################################################
step "CRIT-1  checkbox flip -> openspec list changes k/n"
M0=$(md5 -q $TASKS); cp $TASKS $TASKS.bak
echo "--- GREEN side (before):"; OS list --changes; echo "RC=$?"
sed -i '' 's/- \[ \] 1.4 Add tests/- [X] 1.4 Add tests/' $TASKS
plant_check $TASKS $M0
echo "--- RED side (after flip):"; OS list --changes; echo "RC=$?"
cp $TASKS.bak $TASKS; restore_check $TASKS $M0

########################################################################
step "CRIT-2  scenario level shift -> validate --strict"
M0=$(md5 -q $SPEC); cp $SPEC $SPEC.bak
echo "--- GREEN side (before):"; OS validate mr --strict 2>&1 | rg -N 'is valid|ERROR' | head -3; echo "RC=${PIPESTATUS[0]}"
# shift the scenario UP in depth (*** -> **): shallower than its requirement
sed -i '' 's/^\*\*\* Scenario:/** Scenario:/' $SPEC
plant_check $SPEC $M0
echo "--- RED side (after shift):"; OS validate mr --strict 2>&1 | rg -N 'is valid|ERROR' | head -3; echo "RC=${PIPESTATUS[0]}"
cp $SPEC.bak $SPEC; restore_check $SPEC $M0

########################################################################
step "CRIT-3  drop skip_specs on an EMPTY specs/ -> 'must have at least one delta'"
mkc mrempty; rm -rf openspec/changes/mrempty/specs
printf 'schema: ibalta-org\nskip_specs: true\n' > openspec/changes/mrempty/.openspec.yaml
Y=openspec/changes/mrempty/.openspec.yaml; M0=$(md5 -q $Y); cp $Y $Y.bak
echo "--- GREEN side (skip_specs: true):"; OS validate mrempty --strict 2>&1 | rg -N 'is valid|ERROR' | head -3; echo "RC=${PIPESTATUS[0]}"
printf 'schema: ibalta-org\n' > $Y
plant_check $Y $M0
echo "--- RED side (skip_specs removed):"; OS validate mrempty --strict 2>&1 | rg -N 'is valid|ERROR' | head -3; echo "RC=${PIPESTATUS[0]}"
cp $Y.bak $Y; restore_check $Y $M0

########################################################################
step "CRIT-4  empty the scenario body -> 'Scenario text cannot be empty'"
M0=$(md5 -q $SPEC); cp $SPEC $SPEC.bak
echo "--- GREEN side (before):"; OS validate mr --strict 2>&1 | rg -N 'is valid|ERROR' | head -3; echo "RC=${PIPESTATUS[0]}"
cat > $SPEC <<'EOF'
* ADDED Requirements

** Requirement: User can export data
The system SHALL allow users to export their data in CSV format.

*** Scenario: Successful export
EOF
plant_check $SPEC $M0
echo "--- RED side (empty scenario body):"; OS validate mr --strict 2>&1 | rg -N 'is valid|ERROR' | head -3; echo "RC=${PIPESTATUS[0]}"
cp $SPEC.bak $SPEC; restore_check $SPEC $M0
