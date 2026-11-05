#!/bin/sh
#
# Sets up Garage on first deploy and on every redeploy (safe to re-run):
# assigns the node layout, creates the access key and bucket, and writes
# the key to /run/lega-s3/s3.env for the server to load at startup.
# This replaces the manual docker/garage/setup.sh step.

set -eu

API="${GARAGE_ADMIN_URL:-http://garage:3903}"
BUCKET="${S3_BUCKET:-lega}"
KEY_NAME="${GARAGE_KEY_NAME:-lega}"
# Storage the node may use, in bytes (default 50 GB).
CAPACITY="${GARAGE_CAPACITY_BYTES:-53687091200}"
OUT_DIR=/run/lega-s3
OUT="$OUT_DIR/s3.env"
# The server container runs as uid 1001 (see packages/server/Dockerfile).
SERVER_UID="${SERVER_UID:-1001}"

api() {
  method=$1
  path=$2
  shift 2
  curl -fsS -X "$method" \
    -H "Authorization: Bearer ${GARAGE_ADMIN_TOKEN}" \
    -H 'Content-Type: application/json' \
    "$API$path" "$@"
}

echo "Waiting for the Garage admin API..."
tries=0
until api GET /v1/status >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [ "$tries" -ge 60 ]; then
    echo "Garage did not answer at $API" >&2
    exit 1
  fi
  sleep 2
done

NODE_ID=$(api GET /v1/status | jq -r '.node')
LAYOUT=$(api GET /v1/layout)
HAS_ROLE=$(echo "$LAYOUT" | jq --arg id "$NODE_ID" '[.roles[] | select(.id == $id)] | length')

if [ "$HAS_ROLE" = "0" ]; then
  VERSION=$(echo "$LAYOUT" | jq '.version')
  echo "Assigning layout to node $NODE_ID (version $((VERSION + 1)))..."
  api POST /v1/layout \
    -d "[{\"id\":\"$NODE_ID\",\"zone\":\"dc1\",\"capacity\":$CAPACITY,\"tags\":[]}]" >/dev/null
  api POST /v1/layout/apply -d "{\"version\":$((VERSION + 1))}" >/dev/null
else
  echo "Node already has a layout."
fi

# Access key: reuse it if it exists, otherwise create it.
KEY_ID=$(api GET /v1/key | jq -r --arg n "$KEY_NAME" '[.[] | select(.name == $n)][0].id // empty')
if [ -z "$KEY_ID" ]; then
  echo "Creating access key '$KEY_NAME'..."
  KEY_JSON=$(api POST /v1/key -d "{\"name\":\"$KEY_NAME\"}")
else
  echo "Reusing access key '$KEY_NAME'."
  KEY_JSON=$(api GET "/v1/key?id=$KEY_ID&showSecretKey=true")
fi
ACCESS_KEY=$(echo "$KEY_JSON" | jq -r '.accessKeyId')
SECRET_KEY=$(echo "$KEY_JSON" | jq -r '.secretAccessKey')

# Bucket: the layout can take a moment to apply, so retry creating it.
BUCKET_ID=""
tries=0
while [ -z "$BUCKET_ID" ]; do
  BUCKET_ID=$(api GET "/v1/bucket?globalAlias=$BUCKET" 2>/dev/null | jq -r '.id // empty' || true)
  if [ -z "$BUCKET_ID" ]; then
    BUCKET_ID=$(api POST /v1/bucket -d "{\"globalAlias\":\"$BUCKET\"}" 2>/dev/null | jq -r '.id // empty' || true)
  fi
  if [ -z "$BUCKET_ID" ]; then
    tries=$((tries + 1))
    if [ "$tries" -ge 30 ]; then
      echo "Could not create bucket '$BUCKET'" >&2
      exit 1
    fi
    sleep 2
  fi
done
echo "Bucket '$BUCKET' is ready."

api POST /v1/bucket/allow \
  -d "{\"bucketId\":\"$BUCKET_ID\",\"accessKeyId\":\"$ACCESS_KEY\",\"permissions\":{\"read\":true,\"write\":true,\"owner\":true}}" >/dev/null

mkdir -p "$OUT_DIR"
umask 077
printf 'S3_ACCESS_KEY_ID=%s\nS3_SECRET_ACCESS_KEY=%s\n' "$ACCESS_KEY" "$SECRET_KEY" > "$OUT.tmp"
chown "$SERVER_UID:$SERVER_UID" "$OUT.tmp"
mv "$OUT.tmp" "$OUT"
echo "Wrote S3 credentials for the server."
