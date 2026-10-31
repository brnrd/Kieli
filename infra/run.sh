#!/bin/sh
set -eu
cd "${LAMBDA_TASK_ROOT:-.}"
exec node dist/server/entry.mjs
