#!/bin/bash
set -e

echo "Deploying worker..."
npx wrangler deploy

echo ""
echo "Starting remote dev session to fire initial scheduled run..."
npx wrangler dev --remote --test-scheduled --port 8787 > /tmp/wrangler-dev.log 2>&1 &
DEV_PID=$!

# Wait for the dev server to be ready
echo -n "Waiting for dev server"
for i in $(seq 1 30); do
  if curl -s "http://localhost:8787" > /dev/null 2>&1; then
    break
  fi
  echo -n "."
  sleep 1
done
echo ""

echo "Triggering scheduled event..."
curl -s -o /dev/null -w "HTTP %{http_code}\n" \
  "http://localhost:8787/__scheduled?cron=0+*+*+*+*"

kill $DEV_PID 2>/dev/null || true
wait $DEV_PID 2>/dev/null || true

echo "Done — Discord widget updated."
