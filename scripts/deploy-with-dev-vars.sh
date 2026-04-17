#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE="${DEPLOY_VARS_FILE:-.dev.vars}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "[deploy-with-dev-vars] Missing env file: $ENV_FILE" >&2
  echo "[deploy-with-dev-vars] Set DEPLOY_VARS_FILE or create .dev.vars first." >&2
  exit 1
fi

REQUIRED_KEYS=(
  UPSTASH_REDIS_REST_URL
  UPSTASH_REDIS_REST_TOKEN
  BETTER_AUTH_SECRET
  BETTER_AUTH_URL
  GOOGLE_CLIENT_ID
  GOOGLE_CLIENT_SECRET
  DISCORD_CLIENT_ID
  DISCORD_CLIENT_SECRET
  RESEND_AUTH_KEY
  RESEND_FROM_EMAIL
  RESEND_FROM_NAME
)

MISSING_KEYS=()
for key in "${REQUIRED_KEYS[@]}"; do
  line="$(rg -m1 "^${key}=" "$ENV_FILE" || true)"
  if [[ -z "$line" ]]; then
    MISSING_KEYS+=("$key")
    continue
  fi

  value="${line#*=}"
  value="${value%\"}"
  value="${value#\"}"

  if [[ -z "$value" ]]; then
    MISSING_KEYS+=("$key")
  fi

done

if [[ ${#MISSING_KEYS[@]} -gt 0 ]]; then
  echo "[deploy-with-dev-vars] Missing or empty required keys in $ENV_FILE:" >&2
  for key in "${MISSING_KEYS[@]}"; do
    echo "  - $key" >&2
  done
  exit 1
fi

betterAuthUrlLine="$(rg -m1 '^BETTER_AUTH_URL=' "$ENV_FILE" || true)"
betterAuthUrl="${betterAuthUrlLine#*=}"
betterAuthUrl="${betterAuthUrl%\"}"
betterAuthUrl="${betterAuthUrl#\"}"

if [[ "$betterAuthUrl" == *"localhost"* || "$betterAuthUrl" == *"127.0.0.1"* ]]; then
  echo "[deploy-with-dev-vars] BETTER_AUTH_URL looks local: $betterAuthUrl" >&2
  echo "[deploy-with-dev-vars] Refusing production deploy with local auth URL." >&2
  exit 1
fi

echo "[deploy-with-dev-vars] Uploading secrets from $ENV_FILE and deploying with --keep-vars"
ARGS=("$@")
if [[ ${#ARGS[@]} -gt 0 && "${ARGS[0]}" == "--" ]]; then
  ARGS=("${ARGS[@]:1}")
fi

if [[ ${#ARGS[@]} -gt 0 ]]; then
  pnpm exec wrangler deploy --keep-vars --secrets-file "$ENV_FILE" "${ARGS[@]}"
else
  pnpm exec wrangler deploy --keep-vars --secrets-file "$ENV_FILE"
fi
