#!/bin/bash
set -a
source ~/.openclaw/.env
set +a
exec /usr/local/bin/node /Users/henry/.openclaw/workspace/dashboard/server.cjs
