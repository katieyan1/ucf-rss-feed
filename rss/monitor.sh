#!/usr/bin/env bash
# monitor.sh — Generic RSS feed monitor. Polls feeds, logs diffs with latency, publishes to GitHub Gist.
# Usage: ./monitor.sh <source.conf> [output_file]
#
# Setup: cp .env.example .env && edit .env with your GitHub token (scope: gist)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

# Load token
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck source=/dev/null
  source "$ENV_FILE"
fi

if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  echo "ERROR: GITHUB_TOKEN not set." >&2
  exit 1
fi

# Load source config
CONF_FILE="${1:-}"
if [[ -z "$CONF_FILE" || ! -f "$CONF_FILE" ]]; then
  echo "Usage: $0 <source.conf> [output_file]" >&2
  exit 1
fi
source "$CONF_FILE"

OUTFILE="${2:-${SOURCE_NAME,,}_changes.log}"
CACHE_DIR="$SCRIPT_DIR/.cache_${SOURCE_NAME,,}"
POLL_INTERVAL=60
MASTER_GIST_ID_FILE="$CACHE_DIR/master_gist_id"

SEEN_GUIDS_FILE="$CACHE_DIR/seen_guids.txt"
mkdir -p "$CACHE_DIR"
touch "$SEEN_GUIDS_FILE"

log() {
  echo "$1" | tee -a "$OUTFILE"
}

# Extract items: guid\ttitle\tpubDate\tdescription
extract_items() {
  perl -0777 -ne '
    while (/<item>(.*?)<\/item>/gs) {
      my $item = $1;
      my ($guid)  = $item =~ /<guid[^>]*>(.*?)<\/guid>/s;
      my ($link)  = $item =~ /<link>(.*?)<\/link>/s;
      my ($title) = $item =~ /<title>(.*?)<\/title>/s;
      my ($pub)   = $item =~ /<pubDate>(.*?)<\/pubDate>/s;
      my ($desc)  = $item =~ /<description>(.*?)<\/description>/s;
      $guid //= $link // "unknown";
      $title //= "(no title)";
      $pub   //= "";
      $desc  //= "";
      for ($title, $desc) { s/&amp;/&/g; s/&lt;/</g; s/&gt;/>/g; s/&#039;/'"'"'/g; s/&quot;/"/g; s/\t/ /g; s/\n/ /g; }
      print "$guid\t$title\t$pub\t$desc\n";
    }
  '
}

json_escape() {
  python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))" <<< "$1"
}

# Compute latency between pubDate and now. Returns human-readable string.
compute_latency() {
  local pub_date="$1"
  [[ -z "$pub_date" ]] && echo "unknown" && return

  local pub_epoch now_epoch diff_s
  pub_epoch=$(date -d "$pub_date" +%s 2>/dev/null) || { echo "unparseable"; return; }
  now_epoch=$(date +%s)
  diff_s=$((now_epoch - pub_epoch))

  if [[ $diff_s -lt 0 ]]; then
    echo "future ($(( -diff_s ))s ahead)"
  elif [[ $diff_s -lt 60 ]]; then
    echo "${diff_s}s"
  elif [[ $diff_s -lt 3600 ]]; then
    echo "$(( diff_s / 60 ))m $(( diff_s % 60 ))s"
  elif [[ $diff_s -lt 86400 ]]; then
    echo "$(( diff_s / 3600 ))h $(( (diff_s % 3600) / 60 ))m"
  else
    echo "$(( diff_s / 86400 ))d $(( (diff_s % 86400) / 3600 ))h"
  fi
}

# Get or create master index gist for this source.
get_master_gist_id() {
  if [[ -f "$MASTER_GIST_ID_FILE" ]]; then
    cat "$MASTER_GIST_ID_FILE"
    return
  fi

  local init_content
  init_content="# ${SOURCE_DESCRIPTION} RSS Feed Monitor — Diff Index

Live monitor tracking changes across ${SOURCE_DESCRIPTION} RSS feeds.

---

## Diffs

| Time | Changes | Avg Latency | Link |
|------|---------|-------------|------|
"
  local escaped
  escaped=$(json_escape "$init_content")

  local response
  response=$(curl -sf -X POST \
    -H "Authorization: token $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -d "{
      \"description\": \"${SOURCE_DESCRIPTION} RSS Monitor — Master Index\",
      \"public\": false,
      \"files\": {
        \"${SOURCE_NAME,,}-rss-monitor-index.md\": {
          \"content\": $escaped
        }
      }
    }" \
    "https://api.github.com/gists" 2>/dev/null) || {
    echo "  WARN: Failed to create master gist" >&2
    return 1
  }

  local gist_id
  gist_id=$(echo "$response" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
  echo "$gist_id" > "$MASTER_GIST_ID_FILE"

  local gist_url
  gist_url=$(echo "$response" | python3 -c "import json,sys; print(json.load(sys.stdin)['html_url'])")
  log "Master index gist: $gist_url"

  echo "$gist_id"
}

publish_gist() {
  local filename="$1" content="$2"
  local escaped_content
  escaped_content=$(json_escape "$content")

  local response
  response=$(curl -sf -X POST \
    -H "Authorization: token $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -d "{
      \"description\": \"${SOURCE_DESCRIPTION} RSS Changes — $(date -Iseconds)\",
      \"public\": false,
      \"files\": {
        \"$filename\": {
          \"content\": $escaped_content
        }
      }
    }" \
    "https://api.github.com/gists" 2>/dev/null) || {
    echo "  WARN: Failed to publish gist" >&2
    return 1
  }

  echo "$response" | python3 -c "import json,sys; print(json.load(sys.stdin)['html_url'])" 2>/dev/null
}

update_master_gist() {
  local ts="$1" summary="$2" avg_latency="$3" diff_url="$4"

  local master_id
  master_id=$(get_master_gist_id) || return 1

  local current_content
  current_content=$(curl -sf \
    -H "Authorization: token $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/gists/$master_id" | \
    python3 -c "import json,sys; d=json.load(sys.stdin)['files']; print(list(d.values())[0]['content'])" 2>/dev/null) || {
    echo "  WARN: Failed to fetch master gist" >&2
    return 1
  }

  local new_row="| $ts | $summary | $avg_latency | [View diff]($diff_url) |"
  local updated_content="${current_content}${new_row}
"
  local escaped
  escaped=$(json_escape "$updated_content")

  local file_key="${SOURCE_NAME,,}-rss-monitor-index.md"
  curl -sf -X PATCH \
    -H "Authorization: token $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -d "{\"files\":{\"$file_key\":{\"content\":$escaped}}}" \
    "https://api.github.com/gists/$master_id" >/dev/null 2>&1
}

build_diff_report() {
  local ts="$1"
  local report="# ${SOURCE_DESCRIPTION} RSS Feed Changes\n"
  report+="**Detected at:** $ts\n\n"

  if [[ -n "$new_report" ]]; then
    report+="## New Articles\n\n"
    report+="$new_report"
  fi

  if [[ -n "$drop_report" ]]; then
    report+="\n## Dropped Articles\n\n"
    report+="$drop_report"
  fi

  printf '%b' "$report"
}

# --- Main loop ---

log "========================================"
log "${SOURCE_DESCRIPTION} RSS Monitor started at $(date -Iseconds)"
log "Polling ${#FEEDS[@]} feeds every ${POLL_INTERVAL}s"
log "Output: $OUTFILE | Gists: private"
master_id=$(get_master_gist_id) && log "Master index: https://gist.github.com/$master_id"
log "========================================"
echo ""

poll_count=0

while true; do
  poll_count=$((poll_count + 1))
  ts=$(date -Iseconds)
  changes_this_round=0
  new_count=0
  drop_count=0
  new_report=""
  drop_report=""
  latency_sum=0
  latency_count=0

  for section in "${!FEEDS[@]}"; do
    url="${FEEDS[$section]}"
    cache_file="$CACHE_DIR/${section}.tsv"

    xml=$(curl -sf --max-time 15 "$url" 2>/dev/null) || {
      echo "[$ts] WARN: Failed to fetch $section" >&2
      continue
    }

    current=$(echo "$xml" | extract_items | sort)

    if [[ ! -f "$cache_file" ]]; then
      echo "$current" > "$cache_file"
      # Seed seen GUIDs so initial articles aren't re-reported if they cycle
      echo "$current" | cut -f1 >> "$SEEN_GUIDS_FILE"
      count=$(echo "$current" | grep -c . || true)
      log "[$ts] INIT  $section — $count items cached"
      continue
    fi

    previous=$(cat "$cache_file")

    new_guids=$(comm -23 <(echo "$current" | cut -f1 | sort) <(echo "$previous" | cut -f1 | sort))
    removed_guids=$(comm -13 <(echo "$current" | cut -f1 | sort) <(echo "$previous" | cut -f1 | sort))

    if [[ -n "$new_guids" ]]; then
      while IFS= read -r guid; do
        [[ -z "$guid" ]] && continue

        # Skip if we've already reported this GUID (dedup against feed churn)
        if grep -qFx "$guid" "$SEEN_GUIDS_FILE" 2>/dev/null; then
          continue
        fi
        echo "$guid" >> "$SEEN_GUIDS_FILE"

        info=$(echo "$current" | grep "^${guid}	" | head -1)
        title=$(echo "$info" | cut -f2)
        pubdate=$(echo "$info" | cut -f3)
        desc=$(echo "$info" | cut -f4)

        latency=$(compute_latency "$pubdate")

        # Accumulate numeric latency for averaging
        if [[ -n "$pubdate" ]]; then
          pub_epoch=$(date -d "$pubdate" +%s 2>/dev/null) && {
            now_epoch=$(date +%s)
            diff_s=$((now_epoch - pub_epoch))
            if [[ $diff_s -ge 0 ]]; then
              latency_sum=$((latency_sum + diff_s))
              latency_count=$((latency_count + 1))
            fi
          }
        fi

        log "[$ts] NEW   $section | $title (latency: $latency)"
        [[ -n "$pubdate" ]] && log "        published: $pubdate"

        new_report+="### [$section] $title\n"
        [[ -n "$pubdate" ]] && new_report+="- **Published:** $pubdate\n"
        new_report+="- **Scrape latency:** $latency\n"
        [[ -n "$desc" ]] && new_report+="- **Summary:** $desc\n"
        new_report+="- **GUID:** $guid\n\n"

        changes_this_round=$((changes_this_round + 1))
        new_count=$((new_count + 1))
      done <<< "$new_guids"
    fi

    if [[ -n "$removed_guids" ]]; then
      while IFS= read -r guid; do
        [[ -z "$guid" ]] && continue
        info=$(echo "$previous" | grep "^${guid}	" | head -1)
        title=$(echo "$info" | cut -f2)

        log "[$ts] DROP  $section | $title"
        drop_report+="- **[$section]** $title\n"

        changes_this_round=$((changes_this_round + 1))
        drop_count=$((drop_count + 1))
      done <<< "$removed_guids"
    fi

    echo "$current" > "$cache_file"
  done

  if [[ $changes_this_round -gt 0 ]]; then
    # Compute average latency
    avg_latency="N/A"
    if [[ $latency_count -gt 0 ]]; then
      avg_s=$((latency_sum / latency_count))
      if [[ $avg_s -lt 60 ]]; then
        avg_latency="${avg_s}s"
      elif [[ $avg_s -lt 3600 ]]; then
        avg_latency="$(( avg_s / 60 ))m $(( avg_s % 60 ))s"
      else
        avg_latency="$(( avg_s / 3600 ))h $(( (avg_s % 3600) / 60 ))m"
      fi
    fi

    log "[$ts] --- $changes_this_round change(s), avg latency: $avg_latency (poll #$poll_count) ---"

    diff_content=$(build_diff_report "$ts")
    filename="${SOURCE_NAME,,}-rss-diff-$(date +%Y%m%d-%H%M%S).md"
    gist_url=$(publish_gist "$filename" "$diff_content") && {
      log "[$ts] GIST  $gist_url"
      summary="${new_count} new, ${drop_count} dropped"
      update_master_gist "$ts" "$summary" "$avg_latency" "$gist_url" && {
        log "[$ts] INDEX updated"
      }
    }
    log ""
  fi

  sleep "$POLL_INTERVAL"
done
