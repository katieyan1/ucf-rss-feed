#!/usr/bin/env bash
# monitor_nyt_sitemap.sh — Polls NYT RSS + daily sitemap, compares discovery times.
# Tracks which source detects each article first and the delay.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/.env"

[[ -z "${GITHUB_TOKEN:-}" ]] && { echo "ERROR: GITHUB_TOKEN not set." >&2; exit 1; }

OUTFILE="$SCRIPT_DIR/nyt_comparison.log"
CACHE_DIR="$SCRIPT_DIR/.cache_nyt_sitemap"
POLL_INTERVAL=60

# article_db.tsv: url \t first_seen_rss_epoch \t first_seen_sitemap_epoch \t title \t pub_date \t section
DB_FILE="$CACHE_DIR/article_db.tsv"
MASTER_GIST_ID_FILE="$CACHE_DIR/master_gist_id"
TMP_RSS="$CACHE_DIR/tmp_rss.tsv"
TMP_SITEMAP="$CACHE_DIR/tmp_sitemap.tsv"

mkdir -p "$CACHE_DIR"
touch "$DB_FILE"

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

log() { echo "$1" | tee -a "$OUTFILE"; }

format_dur() {
  local s="$1"
  [[ $s -lt 0 ]] && { echo "N/A"; return; }
  if [[ $s -lt 60 ]]; then echo "${s}s"
  elif [[ $s -lt 3600 ]]; then echo "$(( s/60 ))m $(( s%60 ))s"
  elif [[ $s -lt 86400 ]]; then echo "$(( s/3600 ))h $(( (s%3600)/60 ))m"
  else echo "$(( s/86400 ))d $(( (s%86400)/3600 ))h"; fi
}

json_escape() { python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))" <<< "$1"; }

get_master_gist_id() {
  if [[ -f "$MASTER_GIST_ID_FILE" ]]; then cat "$MASTER_GIST_ID_FILE"; return; fi

  local content="# NYT RSS vs Sitemap — Discovery Comparison

Which finds articles first: RSS feeds or the daily sitemap?

---

| Time | Found via | Article | pub→RSS | pub→Sitemap | Winner | Margin |
|------|-----------|---------|---------|-------------|--------|--------|
"
  local escaped; escaped=$(json_escape "$content")
  local resp; resp=$(curl -sf -X POST \
    -H "Authorization: token $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -d "{\"description\":\"NYT RSS vs Sitemap Comparison\",\"public\":false,\"files\":{\"nyt-rss-vs-sitemap.md\":{\"content\":$escaped}}}" \
    "https://api.github.com/gists" 2>/dev/null) || return 1

  local gid; gid=$(echo "$resp" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
  echo "$gid" > "$MASTER_GIST_ID_FILE"
  log "Comparison gist: https://gist.github.com/$gid"
  echo "$gid"
}

append_master_row() {
  local row="$1"
  local mid; mid=$(get_master_gist_id) || return 1
  local cur; cur=$(curl -sf \
    -H "Authorization: token $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/gists/$mid" | \
    python3 -c "import json,sys; d=json.load(sys.stdin)['files']; print(list(d.values())[0]['content'])" 2>/dev/null) || return 1
  local updated="${cur}${row}
"
  local escaped; escaped=$(json_escape "$updated")
  curl -sf -X PATCH \
    -H "Authorization: token $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -d "{\"files\":{\"nyt-rss-vs-sitemap.md\":{\"content\":$escaped}}}" \
    "https://api.github.com/gists/$mid" >/dev/null 2>&1
}

# Check if URL is already in DB. Sets db_rss and db_sitemap globals.
db_check() {
  local url="$1"
  db_rss=""; db_sitemap=""
  local line; line=$(grep -F "$url	" "$DB_FILE" | head -1) || return 1
  db_rss=$(echo "$line" | cut -f2)
  db_sitemap=$(echo "$line" | cut -f3)
  return 0
}

# --- Main ---

log "========================================"
log "NYT RSS vs Sitemap started at $(date -Iseconds)"
mid=$(get_master_gist_id) && log "Gist: https://gist.github.com/$mid"
log "========================================"

TODAY=$(date +%Y/%m/%d)
SITEMAP_URL="https://www.nytimes.com/sitemap/${TODAY}/"
rows_to_append=""

while true; do
  ts=$(date -Iseconds)
  now=$(date +%s)
  rows_to_append=""

  # Roll date
  new_today=$(date +%Y/%m/%d)
  [[ "$new_today" != "$TODAY" ]] && { TODAY="$new_today"; SITEMAP_URL="https://www.nytimes.com/sitemap/${TODAY}/"; log "[$ts] Date: $TODAY"; }

  # --- RSS ---
  > "$TMP_RSS"
  for section in "${!FEEDS[@]}"; do
    xml=$(curl -sf --max-time 15 "${FEEDS[$section]}" 2>/dev/null) || continue
    echo "$xml" | perl -0777 -ne '
      while (/<item>(.*?)<\/item>/gs) {
        my $i=$1;
        my($l)=$i=~/<link>(.*?)<\/link>/s; my($t)=$i=~/<title>(.*?)<\/title>/s; my($p)=$i=~/<pubDate>(.*?)<\/pubDate>/s;
        $l//=""; $t//=""; $p//="";
        for($t){s/&amp;/&/g;s/&lt;/</g;s/&gt;/>/g;s/&#039;/'"'"'/g;s/&quot;/"/g;s/\t/ /g;}
        $l=~s/\?.*//;
        print "$l\t$t\t$p\t'"$section"'\n" if $l;
      }' >> "$TMP_RSS"
  done

  # Process RSS discoveries
  while IFS=$'\t' read -r url title pubdate section; do
    [[ -z "$url" ]] && continue
    db_check "$url" && [[ -n "$db_rss" ]] && continue  # Already seen in RSS

    # New RSS discovery
    pub_epoch=$(date -d "$pubdate" +%s 2>/dev/null || echo "")
    rss_lat="N/A"
    [[ -n "$pub_epoch" ]] && rss_lat=$(format_dur $((now - pub_epoch)))

    if db_check "$url" 2>/dev/null && [[ -n "$db_sitemap" ]]; then
      # Sitemap had it first
      sitemap_lat="N/A"
      [[ -n "$pub_epoch" ]] && sitemap_lat=$(format_dur $((db_sitemap - pub_epoch)))
      margin=$(format_dur $((now - db_sitemap)))
      log "[$ts] RSS   $section | $title | RSS:$rss_lat Sitemap:$sitemap_lat | Sitemap won by $margin"
      short="${title:0:55}"; [[ ${#title} -gt 55 ]] && short="$short..."
      rows_to_append+="| $ts | Both | $short | $rss_lat | $sitemap_lat | **Sitemap** | $margin |
"
      # Update DB: set RSS time
      sed -i "s|^${url}\t\t|${url}\t${now}\t|" "$DB_FILE" 2>/dev/null || \
        sed -i "s|^${url}\t[^\t]*\t|&|" "$DB_FILE" 2>/dev/null  # already has sitemap time, add rss
      # More robust update
      python3 -c "
import sys
lines=open('$DB_FILE').readlines()
with open('$DB_FILE','w') as f:
  for l in lines:
    p=l.rstrip('\n').split('\t')
    if p[0]=='$url' and (p[1]=='' or p[1]=='$now'):
      p[1]='$now'
    f.write('\t'.join(p)+'\n')
"
    else
      # RSS is first (or article not in DB yet)
      log "[$ts] RSS   $section | $title | RSS:$rss_lat | RSS first"
      short="${title:0:55}"; [[ ${#title} -gt 55 ]] && short="$short..."
      rows_to_append+="| $ts | RSS | $short | $rss_lat | — | **RSS** | — |
"
      # Add to DB
      printf '%s\t%s\t\t%s\t%s\t%s\n' "$url" "$now" "$title" "$pubdate" "$section" >> "$DB_FILE"
    fi
  done < "$TMP_RSS"

  # --- Sitemap ---
  sitemap_html=$(curl -sf --max-time 15 -A "Mozilla/5.0" "$SITEMAP_URL" 2>/dev/null) || {
    echo "[$ts] WARN: sitemap fetch failed" >&2
    sleep "$POLL_INTERVAL"; continue
  }

  echo "$sitemap_html" | grep -oP 'href="(https://www\.nytimes\.com/2026/[^"]+)"[^>]*>([^<]+)' | \
    sed 's/href="//; s/"[^>]*>/\t/' | \
    perl -pe "s/&#x27;/'/g; s/&amp;/&/g; s/&quot;/\"/g; s/\t/\t/" > "$TMP_SITEMAP"

  while IFS=$'\t' read -r url title; do
    [[ -z "$url" ]] && continue
    url=$(echo "$url" | sed 's/\?.*//')
    db_check "$url" && [[ -n "$db_sitemap" ]] && continue  # Already seen in sitemap

    if db_check "$url" 2>/dev/null && [[ -n "$db_rss" ]]; then
      # RSS had it first
      db_line=$(grep -F "$url	" "$DB_FILE" | head -1)
      pubdate=$(echo "$db_line" | cut -f5)
      pub_epoch=$(date -d "$pubdate" +%s 2>/dev/null || echo "")
      rss_lat="N/A"; sitemap_lat="N/A"
      [[ -n "$pub_epoch" ]] && { rss_lat=$(format_dur $((db_rss - pub_epoch))); sitemap_lat=$(format_dur $((now - pub_epoch))); }
      margin=$(format_dur $((now - db_rss)))
      log "[$ts] SMAP  $title | RSS:$rss_lat Sitemap:$sitemap_lat | RSS won by $margin"
      short="${title:0:55}"; [[ ${#title} -gt 55 ]] && short="$short..."
      rows_to_append+="| $ts | Both | $short | $rss_lat | $sitemap_lat | **RSS** | $margin |
"
      # Update DB: set sitemap time
      python3 -c "
import sys
lines=open('$DB_FILE').readlines()
with open('$DB_FILE','w') as f:
  for l in lines:
    p=l.rstrip('\n').split('\t')
    if p[0]=='$url' and p[2]=='':
      p[2]='$now'
    f.write('\t'.join(p)+'\n')
"
    else
      # Sitemap is first
      log "[$ts] SMAP  $title | Sitemap first"
      short="${title:0:55}"; [[ ${#title} -gt 55 ]] && short="$short..."
      rows_to_append+="| $ts | Sitemap | $short | — | detected | **Sitemap** | — |
"
      printf '%s\t\t%s\t%s\t\t\n' "$url" "$now" "$title" >> "$DB_FILE"
    fi
  done < "$TMP_SITEMAP"

  # Batch-append all rows to gist
  if [[ -n "$rows_to_append" ]]; then
    mid=$(get_master_gist_id) || true
    if [[ -n "${mid:-}" ]]; then
      cur=$(curl -sf \
        -H "Authorization: token $GITHUB_TOKEN" \
        -H "Accept: application/vnd.github+json" \
        "https://api.github.com/gists/$mid" | \
        python3 -c "import json,sys; d=json.load(sys.stdin)['files']; print(list(d.values())[0]['content'])" 2>/dev/null) || cur=""
      if [[ -n "$cur" ]]; then
        updated="${cur}${rows_to_append}"
        escaped=$(json_escape "$updated")
        curl -sf -X PATCH \
          -H "Authorization: token $GITHUB_TOKEN" \
          -H "Accept: application/vnd.github+json" \
          -d "{\"files\":{\"nyt-rss-vs-sitemap.md\":{\"content\":$escaped}}}" \
          "https://api.github.com/gists/$mid" >/dev/null 2>&1 && \
          log "[$ts] GIST updated"
      fi
    fi
  fi

  sleep "$POLL_INTERVAL"
done
