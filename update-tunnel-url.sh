#!/bin/bash
# Detect current tunnel URL and update dashboard JS if changed
TUNNEL_URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' /tmp/dashboard-tunnel.log | tail -1)
if [ -z "$TUNNEL_URL" ]; then
  echo "No tunnel URL found"
  exit 1
fi

CURRENT=$(grep -o "https://[a-z0-9-]*\.trycloudflare\.com" /Users/henry/.openclaw/workspace/dashboard/js/app.js | head -1)
if [ "$TUNNEL_URL" = "$CURRENT" ]; then
  echo "URL unchanged: $TUNNEL_URL"
  exit 0
fi

echo "Updating tunnel URL: $CURRENT → $TUNNEL_URL"
sed -i '' "s|const API_URL = '.*'|const API_URL = '${TUNNEL_URL}'|" /Users/henry/.openclaw/workspace/dashboard/js/app.js
cd /Users/henry/.openclaw/workspace/dashboard
git add js/app.js
git commit -m "Auto-update tunnel URL to $TUNNEL_URL"
git push origin main
echo "Dashboard updated to $TUNNEL_URL"
