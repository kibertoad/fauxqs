#!/bin/sh
set -e

CONTAINER_IP=$(hostname -i | awk '{print $1}')
DNS_NAME=${FAUXQS_DNS_NAME:-$(hostname)}
UPSTREAM=${FAUXQS_DNS_UPSTREAM:-8.8.8.8}

echo "Starting dnsmasq: *.${DNS_NAME} -> ${CONTAINER_IP} (upstream: ${UPSTREAM})"
dnsmasq --address=/${DNS_NAME}/${CONTAINER_IP} --server=${UPSTREAM} --no-resolv

# Disable persistence if /data is not a mounted volume (avoids writing to ephemeral container storage)
if [ -n "$FAUXQS_DATA_DIR" ] && ! mountpoint -q "$FAUXQS_DATA_DIR" 2>/dev/null; then
  echo "No volume mounted at $FAUXQS_DATA_DIR — persistence disabled"
  unset FAUXQS_DATA_DIR
fi

# Log persistence status
if [ -z "$FAUXQS_DATA_DIR" ]; then
  echo "Persistence: OFF (no data directory)"
elif [ "$FAUXQS_PERSISTENCE" = "true" ]; then
  echo "Persistence: ON (dataDir=$FAUXQS_DATA_DIR)"
else
  echo "Persistence: OFF (set FAUXQS_PERSISTENCE=true to enable)"
fi

exec tini -- node dist/server.js
