#!/usr/bin/env bash
#
# leak-scan — fail if a tracked file contains a secret, internal-infra ref, or a client identifier.
#
# Runs as a pre-push hook (fast local catch) AND a CI gate (authoritative, unbypassable). Exit 1 on a
# leak, 0 when clean. Scans TRACKED files only (git ls-files), skips binaries + build/vendor dirs.
#
# SECURE-BY-CONSTRUCTION: the committed pattern file (scripts/leak-patterns.txt) is 100% GENERIC — only
# secret/infra SHAPES, never a client or org name — so this config leaks nothing even in a public repo.
# The sensitive CLIENT-NAME denylist is injected PRIVATELY at scan time, never committed:
#   - env  LEAK_CLIENT_DENYLIST  (newline- or comma-separated regexes; CI injects it from a repo/org secret)
#   - file .leak-clientnames     (gitignored; for local dev)
#
# Placeholder allowlist (scripts/leak-allow.txt) lets obvious fakes pass (example-org, glpat-EXAMPLE, …).
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "leak-scan: not a git repo" >&2; exit 2; }
cd "$ROOT"
DIR="scripts"
PATTERNS="$DIR/leak-patterns.txt"
ALLOW="$DIR/leak-allow.txt"
[ -f "$PATTERNS" ] || { echo "leak-scan: missing $PATTERNS" >&2; exit 2; }

# Deny set = generic committed patterns + optional private client denylist (env + gitignored file).
deny="$(grep -vE '^[[:space:]]*(#|$)' "$PATTERNS")"
if [ -n "${LEAK_CLIENT_DENYLIST:-}" ]; then
  deny="$deny"$'\n'"$(printf '%s' "$LEAK_CLIENT_DENYLIST" | tr ',' '\n')"
fi
[ -f .leak-clientnames ] && deny="$deny"$'\n'"$(grep -vE '^[[:space:]]*(#|$)' .leak-clientnames)"

# Files: tracked, minus binaries + build/vendor dirs (base64 blobs in dist cause false positives).
mapfile -t files < <(git ls-files \
  | grep -vEi '\.(png|jpe?g|gif|webp|ico|svg|pdf|zip|gz|tgz|wasm|woff2?|ttf|otf|eot|mp4|webm|mov|jar|class)$' \
  | grep -vE '(^|/)(node_modules|dist|build|coverage|\.git)/')
[ "${#files[@]}" -eq 0 ] && { echo "leak-scan: no scannable files"; exit 0; }

found=0
while IFS= read -r pat; do
  [ -z "$pat" ] && continue
  while IFS= read -r hit; do
    [ -z "$hit" ] && continue
    # allowlisted line (an obvious placeholder) → skip
    if [ -f "$ALLOW" ] && grep -qE -f "$ALLOW" <<<"$hit"; then continue; fi
    echo "LEAK  $hit"
    found=1
  done < <(grep -nHE "$pat" "${files[@]}" 2>/dev/null)
done <<<"$deny"

if [ "$found" -ne 0 ]; then
  echo "" >&2
  echo "❌ leak-scan FAILED — remove the above (or add an obvious-placeholder to $ALLOW) before pushing." >&2
  exit 1
fi
echo "✅ leak-scan clean — ${#files[@]} tracked files, no secrets/infra/client-identifiers."
