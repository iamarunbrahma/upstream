#!/usr/bin/env bash
# Sends a $1.00 sandbox payout to one sandbox personal account and prints its status.
# Usage: scripts/paypal-smoke.sh <sandbox-personal-email>
set -euo pipefail
set -a; source apps/web/.env.local; set +a
API=https://api-m.sandbox.paypal.com
RECEIVER=${1:?usage: scripts/paypal-smoke.sh <sandbox-personal-email>}
TOKEN=$(curl -s -u "$PAYPAL_CLIENT_ID:$PAYPAL_CLIENT_SECRET" -d grant_type=client_credentials "$API/v1/oauth2/token" \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["access_token"])')
BODY=$(cat <<JSON
{"sender_batch_header":{"sender_batch_id":"smoke-$(date +%s)","email_subject":"Upstream smoke test","email_message":"Smoke test"},
 "items":[{"recipient_type":"EMAIL","amount":{"value":"1.00","currency":"USD"},"receiver":"$RECEIVER","note":"smoke","sender_item_id":"smoke-1"}]}
JSON
)
BATCH_ID=$(curl -s -X POST "$API/v1/payments/payouts" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$BODY" \
  | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["batch_header"]["payout_batch_id"])')
echo "batch: $BATCH_ID"
sleep 8
curl -s "$API/v1/payments/payouts/$BATCH_ID" -H "Authorization: Bearer $TOKEN" \
  | python3 -c 'import json,sys;d=json.load(sys.stdin);print("batch_status:",d["batch_header"]["batch_status"]);[print("item:",i["transaction_status"]) for i in d.get("items",[])]'
