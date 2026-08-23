#!/usr/bin/env bash
set -euo pipefail

usage() { printf 'Usage: %s CONTAINER COMMIT\n' "$0" >&2; }
[[ $# -eq 2 ]] || { usage; exit 2; }
container=$1 commit=$2 repo_root=$(git rev-parse --show-toplevel)
git -C "$repo_root" rev-parse --verify "$commit^{commit}" >/dev/null

scratch_root=${PAPERCLIP_SCRATCH_DIR:-${PAPERCLIP_RUN_SCRATCH_DIR:-/paperclip}}
case $scratch_root in /tmp|/tmp/*) printf 'Scratch must be under /paperclip.\n' >&2; exit 2;; esac
workdir=$(mktemp -d "$scratch_root/source-match.XXXXXX")
trap 'rm -rf -- "$workdir"' EXIT
mkdir -p "$workdir/commit" "$workdir/image"
git -C "$repo_root" archive "$commit" | tar -x -C "$workdir/commit"

excluded() {
  local path=$1
  case "/$path/" in
    */.github/*|*/.git/*|*/.paperclip/*|*/.pnpm-store/*|*/node_modules/*|*/coverage/*|*/data/*|*/tmp/*|*/dist/*|*/build/*|*/.next/*)
      return 0
      ;;
  esac
  case $path in
    *.log|scripts/verify-production-source-match.sh) return 0;;
  esac
  return 1
}
filter_paths() {
  local path
  while IFS= read -r -d '' path; do
    path=${path#./}
    excluded "$path" || printf '%s\0' "$path"
  done
}

git -C "$repo_root" ls-tree -r -z --name-only "$commit" | filter_paths > "$workdir/commit.paths"
if ! docker inspect --format '{{.State.Running}}' "$container" | grep -qx true; then
  printf 'Container is not running: %s\n' "$container" >&2
  exit 1
fi
docker exec "$container" find /app -mindepth 1 \( -type f -o -type l \) -printf '%P\0' | filter_paths > "$workdir/image.paths"
if ! docker exec -i "$container" tar -C /app --null --no-recursion --files-from=- -cf - < "$workdir/image.paths" | tar -x -C "$workdir/image"; then
  printf 'Could not extract the filtered production tree from %s.\n' "$container" >&2
  exit 1
fi

declare -A commit_paths=() image_paths=()
while IFS= read -r -d '' path; do commit_paths["$path"]=1; done < "$workdir/commit.paths"
while IFS= read -r -d '' path; do image_paths["$path"]=1; done < "$workdir/image.paths"

baseline_count=${#commit_paths[@]} image_count=${#image_paths[@]}
baseline_only=0 image_only=0 mismatches=0
direction_checks=0
for path in "${!commit_paths[@]}"; do
  if [[ -z ${image_paths[$path]+x} ]]; then
    printf 'MISSING %s\n' "$path" >&2
    baseline_only=$((baseline_only + 1))
    continue
  fi
  left=$workdir/commit/$path right=$workdir/image/$path
  if [[ -L $left || -L $right ]]; then
    if [[ ! -L $left || ! -L $right || $(readlink "$left") != $(readlink "$right") ]]; then
      printf 'TYPE/MISMATCH %s\n' "$path" >&2
      mismatches=$((mismatches + 1))
    fi
  elif [[ ! -f $left || ! -f $right || $(sha256sum "$left" | awk '{print $1}') != $(sha256sum "$right" | awk '{print $1}') ]]; then
    printf 'TYPE/MISMATCH %s\n' "$path" >&2
    mismatches=$((mismatches + 1))
  fi
done
direction_checks=$((direction_checks + 1))
for path in "${!image_paths[@]}"; do
  if [[ -z ${commit_paths[$path]+x} ]]; then
    printf 'EXTRA %s\n' "$path" >&2
    image_only=$((image_only + 1))
  fi
done
direction_checks=$((direction_checks + 1))

printf 'Baseline paths: %d\nImage paths: %d\nBaseline-only paths: %d\nImage-only paths: %d\nContent/type mismatches: %d\nDirection checks: %d/2\n' "$baseline_count" "$image_count" "$baseline_only" "$image_only" "$mismatches" "$direction_checks"
if (( direction_checks == 2 && baseline_only == 0 && image_only == 0 && mismatches == 0 )); then
  printf 'Production source correspondence: PASS (both directions checked)\n'
  exit 0
fi
printf 'Production source correspondence: FAIL\n' >&2
exit 1
