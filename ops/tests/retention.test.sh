#!/usr/bin/env bash
# Tests retention_plan from ops/lib.sh with fake backup files. Needs bash 4+ and GNU date (run it in the ops image):
#   docker run --rm -v "$PWD/ops":/ops:ro --entrypoint bash orderloop-ops:local /ops/tests/retention.test.sh
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
dir=$(mktemp -d); trap 'rm -rf "$dir"' EXIT
fails=0
mk() { for ts in "$@"; do : > "$dir/orderloop-$ts.dump.age"; : > "$dir/orderloop-$ts.manifest.json"; done; }
check() { # name expected-kept-timestamps(space separated) always
  local name=$1 want=$2 always=$3 got
  got=$(retention_plan "$dir" "${KD}" "${KW}" "$dir/orderloop-$always.dump.age" | awk '$1=="keep"{print $2}' | sed 's#.*/orderloop-##; s#\.dump\.age##' | sort | tr '\n' ' ' | sed 's/ $//')
  want=$(echo "$want" | tr ' ' '\n' | sort | tr '\n' ' ' | sed 's/ $//')
  if [[ $got == "$want" ]]; then echo "ok   $name"; else echo "FAIL $name"; echo "     wanted: $want"; echo "     got:    $got"; fails=$((fails + 1)); fi
}

# Several backups on one day: only the newest of that day survives. Three days, one per day: all kept (daily 7).
mk 20261019T020000Z 20261019T140000Z 20261020T020000Z 20261021T020000Z 20261021T150000Z
KD=7; KW=4
check "newest per day, three days" "20261019T140000Z 20261020T020000Z 20261021T150000Z" 20261021T150000Z

# 14 consecutive daily backups with daily=3 weekly=2: the newest 3 days plus the newest of the last 2 ISO weeks.
rm -f "$dir"/*; for d in $(seq 8 21); do mk "202610$(printf %02d $d)T020000Z"; done
KD=3; KW=2
# 2026-10-21 is a Wednesday (ISO week 43); week 43's newest is the 21st (already kept); week 42's newest is Sunday 2026-10-18.
check "daily 3 + weekly 2" "20261021T020000Z 20261020T020000Z 20261019T020000Z 20261018T020000Z" 20261021T020000Z

# The backup just written is always kept, even if the plan alone would drop it.
rm -f "$dir"/*; mk 20261021T020000Z 20261021T030000Z
KD=1; KW=0
check "the new backup is kept" "20261021T020000Z 20261021T030000Z" 20261021T020000Z

# A dump without a manifest is never deleted (it may be half-copied or in use).
rm -f "$dir"/*; mk 20261020T020000Z 20261021T020000Z; : > "$dir/orderloop-20261001T020000Z.dump.age"
KD=1; KW=0
check "orphan dump untouched" "20261001T020000Z 20261021T020000Z" 20261021T020000Z

# Nothing in the directory: no output, no error.
rm -f "$dir"/*
[[ -z $(retention_plan "$dir" 7 4 "$dir/orderloop-20261021T020000Z.dump.age" | grep -v keep) ]] && echo "ok   empty directory" || { echo "FAIL empty directory"; fails=$((fails + 1)); }

# backup_epoch and newest_backup
rm -f "$dir"/*; mk 20261020T020000Z 20261021T020000Z
[[ $(backup_epoch orderloop-20261021T020000Z.dump.age) == 1792548000 ]] && echo "ok   backup_epoch" || { echo "FAIL backup_epoch $(backup_epoch orderloop-20261021T020000Z.dump.age)"; fails=$((fails + 1)); }
[[ $(newest_backup "$dir") == "$dir/orderloop-20261021T020000Z.dump.age" ]] && echo "ok   newest_backup" || { echo "FAIL newest_backup"; fails=$((fails + 1)); }

[[ $fails -eq 0 ]] && echo "all retention tests passed" || { echo "$fails retention test(s) failed"; exit 1; }
