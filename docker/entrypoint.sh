#!/bin/sh
set -e

CONTAINER_IP=$(hostname -i | awk '{print $1}')
DNS_NAME=${FAUXQS_DNS_NAME:-$(hostname)}
UPSTREAM=${FAUXQS_DNS_UPSTREAM:-8.8.8.8}

echo "Starting dnsmasq: *.${DNS_NAME} -> ${CONTAINER_IP} (upstream: ${UPSTREAM})"
dnsmasq --address=/${DNS_NAME}/${CONTAINER_IP} --server=${UPSTREAM} --no-resolv

exec tini -- node dist/server.js
