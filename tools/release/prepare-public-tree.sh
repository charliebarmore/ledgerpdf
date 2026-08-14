#!/bin/bash
# Export the releasable tree without publishing the private engineering history.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 /absolute/path/to/new-empty-ledgerpdf-tree" >&2
  exit 2
fi

SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DESTINATION="$1"
PUBLIC_ROOTS=(
  .github .gitignore .node-version .nvmrc
  CHANGELOG.md CODE_OF_CONDUCT.md CONTRIBUTING.md COPYRIGHT.md DATA-FLOW.md
  DESIGN-PRINCIPLES.md DESIGN.md DISCLAIMER.md LICENSE PRIVACY.md README.md
  RELEASING.md SECURITY.md SUPPORT.md TERMS.md THIRD-PARTY-NOTICES.md
  app docs engine spike tools
)
PRIVATE_ROOTS=(CLAUDE.md PROJECT.md ROADMAP.md references templates)

listed_in() {
  local needle="$1"
  shift
  local item
  for item in "$@"; do
    [ "$item" = "$needle" ] && return 0
  done
  return 1
}

case "$DESTINATION" in
  /*) ;;
  *) echo "destination must be an absolute path" >&2; exit 2 ;;
esac
if [ -e "$DESTINATION" ]; then
  echo "refusing to overwrite existing destination: $DESTINATION" >&2
  exit 2
fi

# Every tracked root entry must be classified. This is the safety property the
# old tar exclude-list lacked: a newly added internal document cannot silently
# become public merely because someone forgot to extend a denylist.
unclassified=0
while IFS= read -r -d '' entry; do
  if listed_in "$entry" "${PUBLIC_ROOTS[@]}" || listed_in "$entry" "${PRIVATE_ROOTS[@]}"; then
    continue
  fi
  echo "refusing public export: unclassified root entry: $entry" >&2
  unclassified=1
done < <(git -C "$SOURCE_ROOT" ls-tree -z --name-only HEAD)
[ "$unclassified" -eq 0 ] || exit 2

mkdir -p "$DESTINATION"
git -C "$SOURCE_ROOT" archive --format=tar HEAD "${PUBLIC_ROOTS[@]}" | tar -xf - -C "$DESTINATION"
node "$DESTINATION/tools/release/check-public-tree.mjs" "$DESTINATION"

echo "Public tree prepared at $DESTINATION"
echo "Review and secret-scan it, then sync it into a clean checkout of the existing public repository."
echo "See RELEASING.md. The initial-public-history check is only for a brand-new repository."
