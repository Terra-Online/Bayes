#!/usr/bin/env bash
set -euo pipefail

# Edit these two variables for quick manual testing.
EMAIL="yueandy597@outlook.com"
LOCALE="zh-HK"

# Optional variables.
BASE_URL="${BASE_URL:-https://api.opendfieldmap.org}"

# CLI arguments override the defaults above.
if [[ $# -ge 1 ]]; then
  EMAIL="$1"
fi
if [[ $# -ge 2 ]]; then
  LOCALE="$2"
fi

if [[ -z "$EMAIL" || -z "$LOCALE" ]]; then
  echo "Usage: $0 [email] [locale]"
  echo "Example: $0 864933829@qq.com zh-CN"
  exit 1
fi

echo "[1/1] send verification otp email=$EMAIL locale=$LOCALE"
send_code=$(curl -sS -o /tmp/oem_send_otp_resp.json -w '%{http_code}' \
  "$BASE_URL/auth/v1/email-otp/send-verification-otp" \
  -H 'content-type: application/json' \
  -H "x-oem-locale: $LOCALE" \
  --data "{\"email\":\"$EMAIL\",\"type\":\"sign-in\",\"locale\":\"$LOCALE\"}")

echo "send_otp_status=$send_code"

echo
echo "send otp response:"
cat /tmp/oem_send_otp_resp.json
echo

echo "done"