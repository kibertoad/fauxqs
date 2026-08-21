#!/bin/sh
set -e

# User the server process runs as once the privileged setup below is done.
# Accepts a name, a uid, or uid:gid — anything su-exec and chown understand.
RUN_USER=${FAUXQS_RUN_USER:-node}

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

# Disable S3 file storage if directory is not a mounted volume
if [ -n "$FAUXQS_S3_STORAGE_DIR" ] && ! mountpoint -q "$FAUXQS_S3_STORAGE_DIR" 2>/dev/null; then
  echo "No volume mounted at $FAUXQS_S3_STORAGE_DIR — S3 file storage disabled"
  unset FAUXQS_S3_STORAGE_DIR
fi

# Log persistence status
if [ -z "$FAUXQS_DATA_DIR" ]; then
  echo "Persistence: OFF (no data directory)"
elif [ "$FAUXQS_PERSISTENCE" = "true" ]; then
  echo "Persistence: ON (dataDir=$FAUXQS_DATA_DIR)"
else
  echo "Persistence: OFF (set FAUXQS_PERSISTENCE=true to enable)"
fi

# Log S3 file storage status
if [ -n "$FAUXQS_S3_STORAGE_DIR" ]; then
  echo "S3 file storage: ON (s3StorageDir=$FAUXQS_S3_STORAGE_DIR)"
else
  echo "S3 file storage: OFF"
fi

# Log tenant management status
if [ -n "$FAUXQS_TENANT_TTL" ]; then
  echo "Tenant management: ON (ttl=${FAUXQS_TENANT_TTL}s)"
else
  echo "Tenant management: OFF"
fi

# Directories the server actually writes to — these must be writable by RUN_USER.
# Mirrors src/server.ts: dataDir is only used when FAUXQS_PERSISTENCE=true.
# Collected as positional parameters so that paths containing spaces survive.
set --
if [ "$FAUXQS_PERSISTENCE" = "true" ] && [ -n "$FAUXQS_DATA_DIR" ]; then
  set -- "$@" "$FAUXQS_DATA_DIR"
fi
if [ -n "$FAUXQS_S3_STORAGE_DIR" ]; then
  set -- "$@" "$FAUXQS_S3_STORAGE_DIR"
fi

start_server() {
  echo "Server user: $1"
  shift
  exec "$@"
}

# Already unprivileged (docker run --user, Kubernetes runAsUser): nothing to drop.
# dnsmasq carries cap_net_bind_service as a file capability so port 53 still works.
if [ "$(id -u)" != "0" ]; then
  start_server "$(id -un 2>/dev/null || id -u) (container started as non-root)" \
    tini -- node dist/server.js
fi

# Escape hatch for setups where the server genuinely needs root.
if [ "$FAUXQS_RUN_AS_ROOT" = "true" ]; then
  start_server "root (FAUXQS_RUN_AS_ROOT=true)" tini -- node dist/server.js
fi

# Hand the mounted directories over to RUN_USER. Bind-mounted host directories
# are typically root-owned, so this is what keeps `-v ./volume:/data` working.
for dir in "$@"; do
  chown -R "$RUN_USER" "$dir" 2>/dev/null || true
done

# If a directory still isn't writable (read-only mount, remote filesystem that
# ignores chown), keep running as root rather than crash-looping on startup.
for dir in "$@"; do
  if ! su-exec "$RUN_USER" sh -c "[ -w \"$dir\" ]" 2>/dev/null; then
    echo "WARNING: $dir is not writable by '$RUN_USER' and could not be chowned."
    echo "WARNING: Falling back to running the server as root. Fix the ownership on"
    echo "WARNING: the host, or set FAUXQS_RUN_USER to a user that can write to it."
    start_server "root (fallback: $dir not writable by '$RUN_USER')" \
      tini -- node dist/server.js
  fi
done

start_server "$RUN_USER" su-exec "$RUN_USER" tini -- node dist/server.js
