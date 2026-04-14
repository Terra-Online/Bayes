#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8788}"
EMAIL="${1:-bridgechan7@gmail.com}"
PASSWORD="${2:-StrongPass123!}"
NAME="${3:-BridgeChan}"
LOCALE="${4:-zh-HK}"
COOKIE_JAR="/tmp/bayes_auth_cookie.jar"

rm -f "$COOKIE_JAR"

echo "[1/5] send otp -> $EMAIL"
send_status=$(curl -sS -o /tmp/bayes_e2e_send_otp.json -w '%{http_code}' \
  "$BASE_URL/auth/v1/email-otp/send-verification-otp" \
  -H 'content-type: application/json' \
  -H "x-oem-locale: $LOCALE" \
  --data "{\"email\":\"$EMAIL\",\"type\":\"sign-in\",\"locale\":\"$LOCALE\"}")

echo "send_status=$send_status"
cat /tmp/bayes_e2e_send_otp.json
echo

if [[ "$send_status" != "200" ]]; then
  echo "Send OTP failed; abort."
  exit 1
fi

read -r -p "[2/5] input OTP received by $EMAIL: " OTP

if [[ ! "$OTP" =~ ^[0-9]{6}$ ]]; then
  echo "OTP must be 6 digits"
  exit 1
fi

echo "[3/5] register with otp"
register_status=$(curl -sS -c "$COOKIE_JAR" -b "$COOKIE_JAR" -o /tmp/bayes_e2e_register.json -w '%{http_code}' \
  "$BASE_URL/auth/v1/register" \
  -H 'content-type: application/json' \
  --data "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"otp\":\"$OTP\",\"name\":\"$NAME\"}")

echo "register_status=$register_status"
cat /tmp/bayes_e2e_register.json
echo

if [[ "$register_status" != "200" ]]; then
  echo "Register failed; abort."
  exit 1
fi

echo "[4/5] fetch business session"
session_status=$(curl -sS -c "$COOKIE_JAR" -b "$COOKIE_JAR" -o /tmp/bayes_e2e_session.json -w '%{http_code}' \
  "$BASE_URL/auth/v1/session")

echo "session_status=$session_status"
cat /tmp/bayes_e2e_session.json
echo

echo "[5/5] sign in with email/password (native endpoint)"
signin_status=$(curl -sS -c "$COOKIE_JAR" -b "$COOKIE_JAR" -o /tmp/bayes_e2e_signin.json -w '%{http_code}' \
  "$BASE_URL/auth/v1/sign-in/email" \
  -H 'content-type: application/json' \
  --data "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")

echo "signin_status=$signin_status"
cat /tmp/bayes_e2e_signin.json
echo

echo "done"
