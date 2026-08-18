#!/bin/bash
# VERIFY-SUITE own smoke: FULL org cycle ADDED -> MODIFIED + RENAMED -> REMOVED
# through the freshly built CLI. Re-runnable (rebuilds its own sandbox).
# Authored by the VERIFY-SUITE agent (non-author of the patch), 0818b.
set -u
CLI="${ORG_SMOKE_CLI:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/bin/openspec.js}"
SB="${ORG_SMOKE_SB:-$(mktemp -d)/vs-fullcycle-run}"
rm -rf "$SB"; mkdir -p "$SB"; cd "$SB" || exit 1
export XDG_CONFIG_HOME="$SB/.xdgc" XDG_DATA_HOME="$SB/.xdgd"

OS() { OPENSPEC_TELEMETRY=0 OPENSPEC_NO_UPDATE_CHECK=1 node "$CLI" "$@"; }
step() { printf '\n########## %s\n' "$*"; }

OS init --tools none >/dev/null 2>&1; echo "init RC=$?"
printf 'schema: ibalta-org\n' > openspec/config.yaml

mk_change() { mkdir -p "openspec/changes/$1/specs/data-export"; printf 'schema: ibalta-org\n' > "openspec/changes/$1/.openspec.yaml"; }
proposal() {
cat > "openspec/changes/$1/proposal.org" <<EOF
#+TITLE: $2

* Why

$2 is needed.

* What Changes

- $2.

* Impact

None.
EOF
cat > "openspec/changes/$1/tasks.org" <<'EOF'
* 1. Work

- [X] 1.1 Do it
EOF
}

# ---------- LEG 1: ADDED (two requirements) ----------
mk_change add-export; proposal add-export "Add data export"
cat > openspec/changes/add-export/specs/data-export/spec.org <<'EOF'
* ADDED Requirements

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

step "L1a validate add-export --strict"; OS validate add-export --strict; echo "RC=$?"
step "L1b archive add-export --yes"; OS archive add-export --yes 2>&1 | tail -4; echo "RC=${PIPESTATUS[0]}"
step "L1c main spec after ADDED"; cat openspec/specs/data-export/spec.org

# capture the minted IDs -- the PIN is the whole point of leg 2
ID_BEFORE=$(rg -N '^:ID:' openspec/specs/data-export/spec.org | sort | md5 -q)
echo "IDS_MD5_AFTER_ADDED=$ID_BEFORE"

# ---------- LEG 2: MODIFIED + RENAMED ----------
mk_change refine-export; proposal refine-export "Refine data export"
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

step "L2a validate refine-export --strict"; OS validate refine-export --strict; echo "RC=$?"
step "L2b archive refine-export --yes"; OS archive refine-export --yes 2>&1 | tail -5; echo "RC=${PIPESTATUS[0]}"
step "L2c main spec after MODIFIED+RENAMED"; cat openspec/specs/data-export/spec.org
ID_AFTER=$(rg -N '^:ID:' openspec/specs/data-export/spec.org | sort | md5 -q)
echo "IDS_MD5_AFTER_RENAME=$ID_AFTER"
if [ "$ID_BEFORE" = "$ID_AFTER" ]; then echo "PIN_OK: :ID: set unchanged across RENAMED"; else echo "PIN_BROKEN: :ID: set changed across RENAMED"; fi

# ---------- LEG 3: REMOVED ----------
mk_change drop-export; proposal drop-export "Drop throttling requirement"
cat > openspec/changes/drop-export/specs/data-export/spec.org <<'EOF'
* REMOVED Requirements

** Requirement: Export is throttled per account
The throttling requirement is withdrawn.

*** Scenario: Too many exports
- *WHEN* the user exceeds the quota
- *THEN* the system rejects the request
EOF

step "L3a validate drop-export --strict"; OS validate drop-export --strict; echo "RC=$?"
step "L3b archive drop-export --yes"; OS archive drop-export --yes 2>&1 | tail -5; echo "RC=${PIPESTATUS[0]}"
step "L3c main spec after REMOVED"; cat openspec/specs/data-export/spec.org

step "L4 archive dir"; ls openspec/changes/archive/ 2>/dev/null
