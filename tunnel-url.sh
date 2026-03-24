#!/bin/bash
# Get the current tunnel URL from the cloudflared log
grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' /tmp/dashboard-tunnel.log | tail -1
