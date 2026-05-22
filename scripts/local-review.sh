#!/usr/bin/env bash
# Run @rex/cli locally against a real PR.
# Usage:
#   ./scripts/local-review.sh <owner/repo> <pr-number> [command]
#
# Required env:
#   ANTHROPIC_API_KEY (or OPENAI_API_KEY if using openai/* model)
#   GITHUB_PAT      — fine-grained PAT with Contents:read, Issues:rw, PRs:rw
#
# Optional env:
#   REX_MODEL       — default anthropic/claude-sonnet-4-5
#   REX_CHECKOUT    — default /tmp/rex-pr-checkout (cleaned and recreated)
#   REX_PROMPT      — extra instruction for the agent
#
# WARNING: this posts a real review/fix to the PR.

set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <owner/repo> <pr-number> [review|fix]" >&2
  exit 1
fi

REPO="$1"
PR="$2"
CMD="${3:-review}"
MODEL="${REX_MODEL:-anthropic/claude-sonnet-4-5}"
CHECKOUT="${REX_CHECKOUT:-/tmp/rex-pr-checkout}"

if [[ -z "${GITHUB_PAT:-}" ]]; then
  echo "GITHUB_PAT env var required (fine-grained PAT with Contents:read, Issues:rw, PRs:rw)" >&2
  exit 1
fi

if [[ "$MODEL" == anthropic/* && -z "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "ANTHROPIC_API_KEY required for $MODEL" >&2
  exit 1
fi
if [[ "$MODEL" == openai/* && -z "${OPENAI_API_KEY:-}" ]]; then
  echo "OPENAI_API_KEY required for $MODEL" >&2
  exit 1
fi

echo ">>> preparing checkout at $CHECKOUT"
rm -rf "$CHECKOUT"
git clone --quiet "https://x-access-token:${GITHUB_PAT}@github.com/${REPO}.git" "$CHECKOUT"
( cd "$CHECKOUT" && git fetch --quiet origin "pull/${PR}/head:rex-pr-${PR}" && git checkout --quiet "rex-pr-${PR}" )

HEAD_SHA=$( cd "$CHECKOUT" && git rev-parse HEAD )
echo ">>> head SHA: $HEAD_SHA"
echo ">>> running rex-cli ($CMD) with $MODEL"

cd "$(dirname "$0")/.."

REX_COMMAND="$CMD" \
REX_MODEL="$MODEL" \
REX_APP_TOKEN="$GITHUB_PAT" \
REX_REPO_DIR="$CHECKOUT" \
REX_REPOSITORY="$REPO" \
REX_PR_NUMBER="$PR" \
REX_HEAD_SHA="$HEAD_SHA" \
REX_PROMPT="${REX_PROMPT:-}" \
  pnpm --filter @rex/cli start
