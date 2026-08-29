#!/usr/bin/env bash
# Starts the Fastify gateway for a load-test run.
#
# Identical to the normal dev command except for SERVICE_JWT_{PRIVATE,PUBLIC}_KEY,
# which are pinned to results/service-key.json so tools/grader.mjs can mint the
# internal service token the §6 verdict callback requires. Nothing else about the
# gateway's configuration is changed for the benchmark.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT/infra/loadtest/tools"
KEY_JSON="$(node service-key.mjs)"
export SERVICE_JWT_PRIVATE_KEY="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).privateKey)' "$KEY_JSON")"
export SERVICE_JWT_PUBLIC_KEY="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).publicKey)' "$KEY_JSON")"
cd "$ROOT/apps/api"
set -a; . ./.env; set +a
export SERVICE_JWT_PRIVATE_KEY SERVICE_JWT_PUBLIC_KEY
exec npx tsx src/server.ts
