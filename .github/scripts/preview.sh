#!/usr/bin/env bash
set -euo pipefail

SLOTS="${PREVIEW_SLOTS:-5}"
TTL_DAYS="${PREVIEW_TTL_DAYS:-7}"
DOMAIN="${PREVIEW_DOMAIN:-tolo.mercuryksm.net}"
OWNER="${GITHUB_REPOSITORY%%/*}"
KUSTOMIZATION=base/kustomization.yaml

images_of() {
  case "$1" in
    tolo-service-gateway) echo "tolo-service-gateway tolo-fakeidp" ;;
    tolo-tenant-management | tolo-graph-authoring | tolo-observation | tolo-operation) echo "$1 $1-migrate" ;;
    tolo-flow-control | tolo-edge-bridge | tolo-web) echo "$1" ;;
    *) return 1 ;;
  esac
}

url_of() {
  echo "https://s$1.${DOMAIN}"
}

branch_of() {
  echo "preview/$1-$2"
}

previews() {
  gh pr list -R "$GITHUB_REPOSITORY" --state open --label preview --limit 100 \
    --json number,headRefName,labels,createdAt \
    --jq '.[] | [.number, .headRefName, ([.labels[].name | select(test("^slot-[0-9]+$")) | ltrimstr("slot-")] | first // ""), .createdAt] | @tsv'
}

find_preview() {
  local branch
  branch="$(branch_of "$1" "$2")"
  previews | awk -F '\t' -v b="$branch" '$2 == b { print $1 "\t" $3; exit }'
}

source_of() {
  local name="${1#preview/}"
  echo "${name%-*} ${name##*-}"
}

last_used() {
  gh pr view "$1" -R "$GITHUB_REPOSITORY" --json commits --jq '.commits[-1].committedDate'
}

comment() {
  gh pr comment "$2" -R "${OWNER}/$1" --body "$3" > /dev/null
}

ensure_label() {
  gh label create "$2" -R "$1" --color "$3" --description "$4" > /dev/null 2>&1 || true
}

label_source() {
  if [ "$3" = add ]; then
    ensure_label "${OWNER}/$1" preview 0e8a16 "プレビュー環境が動いている"
    gh pr edit "$2" -R "${OWNER}/$1" --add-label preview > /dev/null
  else
    gh pr edit "$2" -R "${OWNER}/$1" --remove-label preview > /dev/null 2>&1 || true
  fi
}

commit_tag() {
  local repo="$1" number="$2" tag="$3" image
  git fetch -q origin main
  git switch -q -C preview-work origin/main
  for image in $(images_of "$repo"); do
    IMAGE="ghcr.io/${OWNER}/${image}" TAG="$tag" \
      yq -i '(.images[] | select(.name == strenv(IMAGE))).newTag = strenv(TAG)' "$KUSTOMIZATION"
    if ! IMAGE="ghcr.io/${OWNER}/${image}" yq -e '.images[] | select(.name == strenv(IMAGE))' "$KUSTOMIZATION" > /dev/null; then
      echo "::error::${KUSTOMIZATION} に ghcr.io/${OWNER}/${image} がありません"
      exit 1
    fi
  done
  git commit -q -am "preview: use ${tag} of ${OWNER}/${repo}#${number}"
}

free_slots() {
  local used k last
  used="$(previews | cut -f 3)"
  for k in $(seq 1 "$SLOTS"); do
    if printf '%s\n' "$used" | grep -qx "$k"; then
      continue
    fi
    last="$(gh pr list -R "$GITHUB_REPOSITORY" --state closed --label "slot-$k" --limit 100 \
      --json closedAt --jq 'map(.closedAt) | max // ""')"
    printf '%s\t%s\n' "${last:-0000}" "$k"
  done | sort | cut -f 2
}

allocations() {
  local number branch slot created repo n
  while IFS=$'\t' read -r number branch slot created; do
    read -r repo n <<< "$(source_of "$branch")"
    printf -- '- s%s: %s/%s#%s（開始 %s、最後の利用 %s）\n' "$slot" "$OWNER" "$repo" "$n" "$created" "$(last_used "$number")"
  done < <(previews)
}

start() {
  local repo="$1" number="$2" tag="$3" branch found pr slot
  branch="$(branch_of "$repo" "$number")"
  found="$(find_preview "$repo" "$number")"
  commit_tag "$repo" "$number" "$tag"
  if [ -n "$found" ]; then
    IFS=$'\t' read -r pr slot <<< "$found"
    git push -q --force origin "HEAD:refs/heads/${branch}"
    label_source "$repo" "$number" add
    comment "$repo" "$number" "プレビュー環境を ${tag} に更新しました: $(url_of "$slot")"
    return
  fi
  slot="$(free_slots | head -n 1)"
  if [ -z "$slot" ]; then
    comment "$repo" "$number" "空いているスロットがありません（${SLOTS} 本まで）。今の割り当て:
$(allocations)

使い終わった環境は、その PR で \`/preview stop\` とコメントすると返せます。"
    return
  fi
  git push -q --force origin "HEAD:refs/heads/${branch}"
  ensure_label "$GITHUB_REPOSITORY" preview 0e8a16 "プレビュー環境"
  ensure_label "$GITHUB_REPOSITORY" "slot-${slot}" c5def5 "プレビュー環境のスロット s${slot}"
  gh pr create -R "$GITHUB_REPOSITORY" --base main --head "$branch" \
    --title "preview: ${OWNER}/${repo}#${number}" \
    --body "${OWNER}/${repo}#${number} のプレビュー環境（$(url_of "$slot")）。この PR を閉じると環境が消える。" \
    --label preview --label "slot-${slot}" > /dev/null
  label_source "$repo" "$number" add
  comment "$repo" "$number" "プレビュー環境を作りました: $(url_of "$slot")
${TTL_DAYS} 日使われないと回収されます。\`/preview stop\` で返せます。"
}

update() {
  local repo="$1" number="$2" tag="$3" found pr slot
  found="$(find_preview "$repo" "$number")"
  if [ -z "$found" ]; then
    label_source "$repo" "$number" remove
    return
  fi
  IFS=$'\t' read -r pr slot <<< "$found"
  commit_tag "$repo" "$number" "$tag"
  git push -q --force origin "HEAD:refs/heads/$(branch_of "$repo" "$number")"
}

close_preview() {
  gh pr close "$1" -R "$GITHUB_REPOSITORY" --delete-branch --comment "$2" > /dev/null
}

stop() {
  local repo="$1" number="$2" event="$3" found pr slot
  found="$(find_preview "$repo" "$number")"
  label_source "$repo" "$number" remove
  if [ -z "$found" ]; then
    if [ "$event" = issue_comment ]; then
      comment "$repo" "$number" "動いているプレビュー環境はありません。"
    fi
    return
  fi
  IFS=$'\t' read -r pr slot <<< "$found"
  if [ "$event" = issue_comment ]; then
    close_preview "$pr" "${OWNER}/${repo}#${number} の \`/preview stop\` で閉じた。"
    comment "$repo" "$number" "プレビュー環境（s${slot}）を消しました。"
  else
    close_preview "$pr" "${OWNER}/${repo}#${number} が閉じたので閉じた。"
  fi
}

reclaim() {
  local number branch slot created used repo n
  while IFS=$'\t' read -r number branch slot created; do
    used="$(last_used "$number")"
    if ! jq -en --arg used "$used" --argjson days "$TTL_DAYS" \
      '($used | fromdateiso8601) < (now - $days * 86400)' > /dev/null; then
      continue
    fi
    read -r repo n <<< "$(source_of "$branch")"
    close_preview "$number" "${TTL_DAYS} 日使われなかったので回収した（最後の利用 ${used}）。"
    label_source "$repo" "$n" remove
    comment "$repo" "$n" "プレビュー環境（s${slot}）は ${TTL_DAYS} 日使われなかったので回収しました。\`/preview\` とコメントすると作り直せます。"
    echo "reclaimed s${slot}: ${OWNER}/${repo}#${n} (last used ${used})"
  done < <(previews)
}

main() {
  local action="${1:-}"
  case "$action" in
    start | update | stop)
      local repository="${SOURCE_REPOSITORY:-}" number="${SOURCE_NUMBER:-}" tag="${SOURCE_TAG:-}" event="${SOURCE_EVENT:-}"
      local repo="${repository#"${OWNER}"/}"
      if [ "$repo" = "$repository" ] || ! images_of "$repo" > /dev/null; then
        echo "::error::プレビューの対象ではないリポジトリです: '${repository}'"
        exit 1
      fi
      if ! printf '%s' "$number" | grep -Eq '^[1-9][0-9]*$'; then
        echo "::error::プルリクエストの番号が不正です: '${number}'"
        exit 1
      fi
      if [ "$action" != stop ] && ! printf '%s' "$tag" | grep -Eq '^sha-[0-9a-f]{7}$'; then
        echo "::error::イメージのタグが不正です: '${tag}'"
        exit 1
      fi
      case "$action" in
        start) start "$repo" "$number" "$tag" ;;
        update) update "$repo" "$number" "$tag" ;;
        stop) stop "$repo" "$number" "$event" ;;
      esac
      ;;
    reclaim) reclaim ;;
    *)
      echo "usage: $0 start|update|stop|reclaim" >&2
      exit 2
      ;;
  esac
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
