#!/bin/bash
# examples/skills/system_grep/scripts/search.sh
#
# A bash skill invoked automatically by the SDK's loadSkillsFromDirectory method.
# The SDK passes the JSON arguments as $1.
# We use Node to safely extract the parameters without needing `jq`.

DIR=$(node -pe "try { JSON.parse(process.argv[1]).directory || '.' } catch(e) { '.' }" "$1")
PATTERN=$(node -pe "try { JSON.parse(process.argv[1]).pattern || '' } catch(e) { '' }" "$1")

if [ -z "$PATTERN" ]; then
  echo '{"success": false, "error": "Pattern is required."}'
  exit 1
fi

# Execute grep securely (recursive, list filenames only, ignore binary) and cap at 50 lines.
# pipefail inside the substitution makes $? reflect grep, not head — `$?` after a
# bare pipe is head's (always 0), so a no-match grep (exit 1) reported success.
OUTPUT=$(set -o pipefail; grep -rIl "$PATTERN" "$DIR" 2>&1 | head -n 50)
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
  # Ensure the output is properly JSON-escaped for the SDK
  JSON_SAFE_OUTPUT=$(node -pe "JSON.stringify(process.argv[1])" "$OUTPUT")
  echo "{\"success\": true, \"result\": $JSON_SAFE_OUTPUT}"
else
  JSON_SAFE_OUTPUT=$(node -pe "JSON.stringify(process.argv[1])" "$OUTPUT")
  echo "{\"success\": false, \"error\": \"No matches found or an error occurred.\", \"stderr\": $JSON_SAFE_OUTPUT}"
fi
