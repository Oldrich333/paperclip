#!/usr/bin/env bash

set -euo pipefail

usage() {
  printf 'Usage: %s CONTAINER COMMIT\n' "$0" >&2
  printf '\nCompare every tracked path in COMMIT with the same path under /app in a running CONTAINER.\n' >&2
}

if [[ $# -ne 2 ]]; then
  usage
  exit 2
fi

container="$1"
commit="$2"
repo_root="$(git rev-parse --show-toplevel)"

git -C "$repo_root" rev-parse --verify "$commit^{commit}" >/dev/null

scratch_root="${PAPERCLIP_SCRATCH_DIR:-${PAPERCLIP_RUN_SCRATCH_DIR:-/paperclip}}"
case "$scratch_root" in
  /tmp|/tmp/*)
    printf 'Refusing scratch path under /tmp; set PAPERCLIP_SCRATCH_DIR under /paperclip.\n' >&2
    exit 2
    ;;
esac
mkdir -p "$scratch_root"
workdir="$(mktemp -d "$scratch_root/source-match.XXXXXX")"
cleanup() {
  rm -rf -- "$workdir"
}
trap cleanup EXIT

mkdir -p "$workdir/commit" "$workdir/container"
git -C "$repo_root" archive "$commit" | tar -x -C "$workdir/commit"

# The production Dockerfile copies the repository build context without .github/**.
# The checker itself is host-side verification tooling added after this captured
# image and is also not part of the application correspondence set. Every other
# tracked application path must be present and byte-identical in the running image.
git -C "$repo_root" ls-tree -r -z --name-only "$commit" |
  awk -v RS='\0' 'index($0, ".github/") != 1 && $0 != "scripts/verify-production-source-match.sh" { printf "%s%c", $0, 0 }' > "$workdir/paths"

if ! docker inspect --format '{{.State.Running}}' "$container" | grep -qx true; then
  printf 'Container is not running: %s\n' "$container" >&2
  exit 1
fi

# Transfer only the tracked paths under test. A failed tar read is an unexpected
# absence and must fail the check rather than being hidden by a partial archive.
if ! docker exec -i "$container" tar -C /app --null --no-recursion --files-from=- -cf - < "$workdir/paths" |
  tar -x -C "$workdir/container"; then
  printf 'Could not extract the tracked production paths from %s.\n' "$container" >&2
  exit 1
fi

checked=0
failures=0
while IFS= read -r -d '' path; do
  checked=$((checked + 1))
  commit_file="$workdir/commit/$path"
  container_file="$workdir/container/$path"
  if [[ ! -e "$container_file" ]]; then
    printf 'MISSING %s\n' "$path" >&2
    failures=$((failures + 1))
    continue
  fi
  commit_hash="$(sha256sum "$commit_file" | awk '{print $1}')"
  container_hash="$(sha256sum "$container_file" | awk '{print $1}')"
  if [[ "$commit_hash" != "$container_hash" ]]; then
    printf 'MISMATCH %s commit=%s container=%s\n' "$path" "$commit_hash" "$container_hash" >&2
    failures=$((failures + 1))
  fi
done < "$workdir/paths"

printf 'Checked %d tracked paths; excluded .github/** and host-side verifier by Dockerfile copy-set contract.\n' "$checked"
if (( failures != 0 )); then
  printf '%d production source mismatches or unexpected absences.\n' "$failures" >&2
  exit 1
fi
printf 'Production source correspondence: PASS\n'
