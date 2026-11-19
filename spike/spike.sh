#!/usr/bin/env bash
# Stage-1 spike: probe OpenCode Go with a real key. Run it yourself:
#   bash spike/spike.sh            # key from ~/.config/opencode-go/api_key
#   OC_KEY_FILE=/path bash spike/spike.sh
# Output goes to spike/out/ (gitignored). The key itself is never written there.
set -uo pipefail

KEY_FILE="${OC_KEY_FILE:-$HOME/.config/opencode-go/api_key}"
[ -s "$KEY_FILE" ] || { echo "no key file at $KEY_FILE" >&2; exit 1; }
KEY="$(tr -d '[:space:]' < "$KEY_FILE")"

BASE=https://opencode.ai/inference/go
UA="opencode-go-worker/0.0.1-spike"
SID="spike-$(uuidgen | tr 'A-Z' 'a-z')"
OUT="$(cd "$(dirname "$0")" && pwd)/out"
mkdir -p "$OUT"
: > "$OUT/summary.txt"

# Models per API family (override with env vars).
M_CC="${M_CC:-glm-5.3-flash}"        # recommended_api: chat-completions
M_MSG="${M_MSG:-qwen3.8-flash}"      # recommended_api: messages
M_RESP="${M_RESP:-gpt-6-luna}"       # recommended_api: responses

log() { echo "$*" | tee -a "$OUT/summary.txt"; }

# req NAME METHOD URL AUTHMODE [BODY] [extra curl args...]
#   AUTHMODE: bearer | xapikey | both | none
req() {
  local name=$1 method=$2 url=$3 auth=$4 body=${5:-}; shift 5 2>/dev/null || shift $#
  local -a h=(-H "User-Agent: $UA" -H "x-opencode-session: $SID" -H 'content-type: application/json')
  case $auth in
    bearer)  h+=(-H "Authorization: Bearer $KEY");;
    xapikey) h+=(-H "x-api-key: $KEY" -H 'anthropic-version: 2023-06-01');;
    both)    h+=(-H "Authorization: Bearer $KEY" -H "x-api-key: $KEY" -H 'anthropic-version: 2023-06-01');;
  esac
  local -a b=()
  [ -n "$body" ] && b=(--data-binary "$body")
  local code
  code=$(curl -sS -N -m 120 -X "$method" "${h[@]}" ${b[@]+"${b[@]}"} "$@" \
    -D "$OUT/$name.headers" -o "$OUT/$name.body" -w '%{http_code} %{time_total}s' "$url" 2>"$OUT/$name.err")
  # scrub key just in case it is echoed anywhere
  sed -i '' "s#$KEY#<KEY>#g" "$OUT/$name.headers" "$OUT/$name.body" "$OUT/$name.err" 2>/dev/null
  log "$(printf '%-28s %s' "$name" "$code")"
}

log "session=$SID  ua=$UA  $(date -u +%FT%TZ)"

# 1. usage (unofficial)
req usage_bearer  GET https://opencode.ai/zen/go/v1/usage bearer
req usage_xapikey GET https://opencode.ai/zen/go/v1/usage xapikey

# 2. models with auth (does it add per-account fields?)
req models_auth GET "$BASE/v1/models" bearer

P='Reply with exactly: pong'

# 3. chat/completions, non-stream + stream, auth variants
CC_BODY=$(printf '{"model":"%s","messages":[{"role":"user","content":"%s"}],"max_tokens":64}' "$M_CC" "$P")
CC_STREAM=$(printf '{"model":"%s","messages":[{"role":"user","content":"%s"}],"max_tokens":64,"stream":true,"stream_options":{"include_usage":true}}' "$M_CC" "$P")
req cc_bearer        POST "$BASE/openai/v1/chat/completions" bearer  "$CC_BODY"
req cc_xapikey       POST "$BASE/openai/v1/chat/completions" xapikey "$CC_BODY"
req cc_stream        POST "$BASE/openai/v1/chat/completions" bearer  "$CC_STREAM"

# 4. messages, auth variants + stream
MSG_BODY=$(printf '{"model":"%s","max_tokens":64,"messages":[{"role":"user","content":"%s"}]}' "$M_MSG" "$P")
MSG_STREAM=$(printf '{"model":"%s","max_tokens":64,"stream":true,"messages":[{"role":"user","content":"%s"}]}' "$M_MSG" "$P")
req msg_bearer       POST "$BASE/anthropic/v1/messages" bearer  "$MSG_BODY"
req msg_xapikey      POST "$BASE/anthropic/v1/messages" xapikey "$MSG_BODY"
req msg_stream       POST "$BASE/anthropic/v1/messages" xapikey "$MSG_STREAM"

# 5. cross-API: does each path accept models whose native API differs?
req cross_cc_msgmodel   POST "$BASE/openai/v1/chat/completions" bearer \
  "$(printf '{"model":"%s","messages":[{"role":"user","content":"%s"}],"max_tokens":64}' "$M_MSG" "$P")"
req cross_cc_respmodel  POST "$BASE/openai/v1/chat/completions" bearer \
  "$(printf '{"model":"%s","messages":[{"role":"user","content":"%s"}],"max_tokens":64}' "$M_RESP" "$P")"
req cross_msg_ccmodel   POST "$BASE/anthropic/v1/messages" xapikey \
  "$(printf '{"model":"%s","max_tokens":64,"messages":[{"role":"user","content":"%s"}]}' "$M_CC" "$P")"

# 6. prompt cache: same long prefix twice under the same session
LONG=$(python3 -c 'print(("The quick brown fox jumps over the lazy dog. " * 400).strip())')
CACHE_BODY=$(python3 -c 'import json,sys; print(json.dumps({"model":sys.argv[1],"max_tokens":16,"messages":[{"role":"system","content":sys.argv[2]},{"role":"user","content":"Say ok"}]}))' "$M_CC" "$LONG")
req cache_1 POST "$BASE/openai/v1/chat/completions" bearer "$CACHE_BODY"
req cache_2 POST "$BASE/openai/v1/chat/completions" bearer "$CACHE_BODY"

# 7. reasoning_effort passthrough
req cc_effort POST "$BASE/openai/v1/chat/completions" bearer \
  "$(printf '{"model":"%s","messages":[{"role":"user","content":"%s"}],"max_tokens":256,"reasoning_effort":"low"}' "$M_CC" "$P")"

# usage again, to see whether the spike moved the percentages
req usage_after GET https://opencode.ai/zen/go/v1/usage bearer

echo
echo "done. results in $OUT  (summary.txt lists status codes)"
