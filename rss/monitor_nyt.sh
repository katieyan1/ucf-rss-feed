#!/usr/bin/env bash
# monitor_nyt.sh — Polls NYT RSS feeds every 10 seconds, logs diffs, publishes to GitHub Gist.
# Usage: ./monitor_nyt.sh [output_file]
# Default output: nyt_changes.log
#
# Setup: cp .env.example .env && edit .env with your GitHub token (scope: gist)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

# Load token from .env
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck source=/dev/null
  source "$ENV_FILE"
fi

if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  echo "ERROR: GITHUB_TOKEN not set. Copy .env.example to .env and add your token." >&2
  exit 1
fi

OUTFILE="${1:-nyt_changes.log}"
CACHE_DIR="$SCRIPT_DIR/.nyt_cache"
POLL_INTERVAL=10

# NYT feeds to monitor
declare -A FEEDS=(
  [HomePage]="https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml"
  [World]="https://rss.nytimes.com/services/xml/rss/nyt/World.xml"
  [US]="https://rss.nytimes.com/services/xml/rss/nyt/US.xml"
  [Politics]="https://rss.nytimes.com/services/xml/rss/nyt/Politics.xml"
  [Business]="https://rss.nytimes.com/services/xml/rss/nyt/Business.xml"
  [Technology]="https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml"
  [Science]="https://rss.nytimes.com/services/xml/rss/nyt/Science.xml"
  [Health]="https://rss.nytimes.com/services/xml/rss/nyt/Health.xml"
  [Arts]="https://rss.nytimes.com/services/xml/rss/nyt/Arts.xml"
  [Opinion]="https://rss.nytimes.com/services/xml/rss/nyt/Opinion.xml"
)

mkdir -p "$CACHE_DIR"

log() {
  echo "$1" | tee -a "$OUTFILE"
}

# Extract items from RSS XML as "guid\ttitle\tpubDate\tdescription" lines.
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

# Escape a string for safe embedding in JSON
json_escape() {
  python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))" <<< "$1"
}

MASTER_GIST_ID_FILE="$CACHE_DIR/master_gist_id"

# Get or create the master index gist. Prints the gist ID.
get_master_gist_id() {
  if [[ -f "$MASTER_GIST_ID_FILE" ]]; then
    cat "$MASTER_GIST_ID_FILE"
    return
  fi

  local init_content
  init_content='# NYT RSS Feed Monitor — Diff Index

Live monitor tracking changes across 10 NYT RSS feeds.

---

## Diffs

| Time | Changes | Link |
|------|---------|------|
'
  local escaped
  escaped=$(json_escape "$init_content")

  local response
  response=$(curl -sf -X POST \
    -H "Authorization: token $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -d "{
      \"description\": \"NYT RSS Monitor — Master Index\",
      \"public\": false,
      \"files\": {
        \"nyt-rss-monitor-index.md\": {
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

# Publish a diff report to GitHub Gist. Args: $1=filename, $2=content
# Prints the new gist's URL.
publish_gist() {
  local filename="$1"
  local content="$2"
  local escaped_content
  escaped_content=$(json_escape "$content")

  local response
  response=$(curl -sf -X POST \
    -H "Authorization: token $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -d "{
      \"description\": \"NYT RSS Feed Changes — $(date -Iseconds)\",
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

  local gist_url
  gist_url=$(echo "$response" | python3 -c "import json,sys; print(json.load(sys.stdin)['html_url'])" 2>/dev/null) || {
    echo "  WARN: Gist created but couldn't parse URL" >&2
    return 1
  }
  echo "$gist_url"
}

# Append a row to the master index gist table. Args: $1=timestamp, $2=summary, $3=diff_gist_url
update_master_gist() {
  local ts="$1" summary="$2" diff_url="$3"

  local master_id
  master_id=$(get_master_gist_id) || return 1

  # Fetch current content
  local current_content
  current_content=$(curl -sf \
    -H "Authorization: token $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/gists/$master_id" | \
    python3 -c "import json,sys; print(json.load(sys.stdin)['files']['nyt-rss-monitor-index.md']['content'])" 2>/dev/null) || {
    echo "  WARN: Failed to fetch master gist" >&2
    return 1
  }

  # Append new row to the table
  local new_row="| $ts | $summary | [View diff]($diff_url) |"
  local updated_content="${current_content}${new_row}
"
  local escaped
  escaped=$(json_escape "$updated_content")

  curl -sf -X PATCH \
    -H "Authorization: token $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -d "{
      \"files\": {
        \"nyt-rss-monitor-index.md\": {
          \"content\": $escaped
        }
      }
    }" \
    "https://api.github.com/gists/$master_id" >/dev/null 2>&1 || {
    echo "  WARN: Failed to update master gist" >&2
    return 1
  }
}

# Build a markdown diff report for one polling round.
# Globals used: new_report, drop_report (accumulated by the main loop)
build_diff_report() {
  local ts="$1"
  local report="# NYT RSS Feed Changes\n"
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

log "========================================"
log "NYT RSS Monitor started at $(date -Iseconds)"
log "Polling ${#FEEDS[@]} feeds every ${POLL_INTERVAL}s"
log "Output: $OUTFILE | Gists: private"
master_id=$(get_master_gist_id) && log "Master index: https://gist.github.com/$master_id"
log "========================================"
echo ""

poll_count=0
new_count=0
drop_count=0

while true; do
  poll_count=$((poll_count + 1))
  ts=$(date -Iseconds)
  changes_this_round=0
  new_count=0
  drop_count=0
  new_report=""
  drop_report=""

  for section in "${!FEEDS[@]}"; do
    url="${FEEDS[$section]}"
    cache_file="$CACHE_DIR/${section}.tsv"

    # Fetch feed
    xml=$(curl -sf --max-time 15 "$url" 2>/dev/null) || {
      echo "[$ts] WARN: Failed to fetch $section" >&2
      continue
    }

    # Extract current items
    current=$(echo "$xml" | extract_items | sort)

    if [[ ! -f "$cache_file" ]]; then
      echo "$current" > "$cache_file"
      count=$(echo "$current" | grep -c . || true)
      log "[$ts] INIT  $section — $count items cached"
      continue
    fi

    previous=$(cat "$cache_file")

    # Diff by guid
    new_guids=$(comm -23 <(echo "$current" | cut -f1 | sort) <(echo "$previous" | cut -f1 | sort))
    removed_guids=$(comm -13 <(echo "$current" | cut -f1 | sort) <(echo "$previous" | cut -f1 | sort))

    if [[ -n "$new_guids" ]]; then
      while IFS= read -r guid; do
        [[ -z "$guid" ]] && continue
        info=$(echo "$current" | grep "^${guid}	" | head -1)
        title=$(echo "$info" | cut -f2)
        pubdate=$(echo "$info" | cut -f3)
        desc=$(echo "$info" | cut -f4)

        log "[$ts] NEW   $section | $title"
        [[ -n "$pubdate" ]] && log "        published: $pubdate"

        new_report+="### [$section] $title\n"
        [[ -n "$pubdate" ]] && new_report+="- **Published:** $pubdate\n"
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
    log "[$ts] --- $changes_this_round change(s) detected (poll #$poll_count) ---"

    # Build and publish diff gist, then update master index
    diff_content=$(build_diff_report "$ts")
    filename="nyt-rss-diff-$(date +%Y%m%d-%H%M%S).md"
    gist_url=$(publish_gist "$filename" "$diff_content") && {
      log "[$ts] GIST  $gist_url"
      summary="${new_count} new, ${drop_count} dropped"
      update_master_gist "$ts" "$summary" "$gist_url" && {
        log "[$ts] INDEX updated"
      }
    }
    log ""
  fi

  sleep "$POLL_INTERVAL"
done
