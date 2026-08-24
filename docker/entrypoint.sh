#!/bin/sh
set -e

# User the server process runs as once the privileged setup below is done.
# Accepts a name, a uid, or uid:gid — anything su-exec and chown understand.
RUN_USER=${FAUXQS_RUN_USER:-node}

# `docker run --user` and Kubernetes runAsUser start us unprivileged: there is
# nothing to chown and nobody to drop to, so most of this script is skipped.
if [ "$(id -u)" = "0" ]; then
  STARTED_AS_ROOT=true
else
  STARTED_AS_ROOT=false
fi

# Catch a bad FAUXQS_RUN_USER here rather than several steps later, where a
# failing chown and a failing su-exec look exactly like an unwritable mount.
if [ "$STARTED_AS_ROOT" = true ] && [ "$FAUXQS_RUN_AS_ROOT" != "true" ]; then
  if ! su-exec "$RUN_USER" true 2>/dev/null; then
    echo "ERROR: FAUXQS_RUN_USER='$RUN_USER' cannot be used to run the server." >&2
    echo "ERROR: Use a user that exists in the image ('node'), or a numeric uid" >&2
    echo "ERROR: or uid:gid — those do not need an /etc/passwd entry." >&2
    exit 1
  fi
fi

CONTAINER_IP=$(hostname -i | awk '{print $1}')
DNS_NAME=${FAUXQS_DNS_NAME:-$(hostname)}
UPSTREAM=${FAUXQS_DNS_UPSTREAM:-8.8.8.8}

# Wildcard DNS is a convenience: the API works without it, so a container that
# cannot bind port 53 should say so and carry on rather than exit.
#
# /usr/sbin/dnsmasq carries cap_net_bind_service+ep so it can bind port 53 when
# the container runs unprivileged. The effective bit is what actually delivers
# the capability, but it also makes execve fail with EPERM whenever
# NET_BIND_SERVICE is missing from the bounding set (--cap-drop=ALL, Kubernetes'
# restricted policy). The uncapped copy covers that case: it cannot ask for the
# capability, but it does not need it wherever port 53 is unprivileged, which is
# the default in Docker.
start_dnsmasq() {
  echo "Starting dnsmasq: *.${DNS_NAME} -> ${CONTAINER_IP} (upstream: ${UPSTREAM})"
  dnsmasq_error=""
  for binary in /usr/sbin/dnsmasq /usr/sbin/dnsmasq-nocap; do
    if dnsmasq_error=$("$binary" --address=/"${DNS_NAME}"/"${CONTAINER_IP}" \
      --server="${UPSTREAM}" --no-resolv 2>&1); then
      return 0
    fi
  done
  echo "WARNING: dnsmasq could not bind port 53: ${dnsmasq_error:-permission denied}"
  echo "WARNING: Wildcard DNS is unavailable, so *.${DNS_NAME} will not resolve"
  echo "WARNING: inside the container and virtual-host-style S3 addressing needs"
  echo "WARNING: forcePathStyle on the client. The API is otherwise unaffected."
  echo "WARNING: Add the NET_BIND_SERVICE capability to enable wildcard DNS."
  return 0
}
start_dnsmasq

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

# Is the directory in $FAUXQS_PROBE_DIR writable, including what is already in
# it? Two things make this less obvious than `test -w`:
#
#   * for root, `test -w` reports success on a read-only mount even though every
#     write then fails with EROFS, so the directory is tested by creating a file;
#   * a root-owned fauxqs.db inside a world-writable /data passes a check on the
#     directory alone and then fails every write at runtime, so the entries are
#     tested too. Only the top level — anything deeper is covered by the
#     recursive chown, and `test -w` is accurate for the unprivileged user.
#
# The path is passed through the environment so that the inner shell never
# parses it — quoting it into `sh -c` would re-expand $, quotes and spaces.
PROBE='
  probe=$FAUXQS_PROBE_DIR/.fauxqs-write-probe
  : > "$probe" 2>/dev/null || exit 1
  rm -f "$probe"
  for entry in "$FAUXQS_PROBE_DIR"/* "$FAUXQS_PROBE_DIR"/.[!.]*; do
    [ -e "$entry" ] || continue
    [ -w "$entry" ] || exit 1
  done
'

writable_by_run_user() {
  FAUXQS_PROBE_DIR=$1 su-exec "$RUN_USER" sh -c "$PROBE" 2>/dev/null
}

writable_by_me() {
  FAUXQS_PROBE_DIR=$1 sh -c "$PROBE" 2>/dev/null
}

# Set when the server has to stay root to be able to write to a directory that
# could not be handed over to RUN_USER.
ROOT_FALLBACK_REASON=""

# Makes $1 writable by the user the server will run as, or fails the container.
# Never returns with the directory in a state the server cannot use.
check_write_dir() {
  dir=$1

  # Started unprivileged: no chown, and no user to switch to. All we can do is
  # report it, which still beats a healthy-looking container that answers every
  # write with "attempt to write a readonly database".
  if [ "$STARTED_AS_ROOT" = false ]; then
    writable_by_me "$dir" && return 0
    echo "ERROR: $dir is not writable by uid $(id -u)." >&2
    echo "ERROR: The container was started as a non-root user, so it cannot take" >&2
    echo "ERROR: ownership of the mount itself. Either chown the mount to that uid" >&2
    echo "ERROR: on the host, or start the container as root and let the entrypoint" >&2
    echo "ERROR: hand it over." >&2
    exit 1
  fi

  if [ "$FAUXQS_RUN_AS_ROOT" = "true" ]; then
    writable_by_me "$dir" && return 0
    echo "ERROR: $dir is not writable even as root — most likely a read-only mount." >&2
    echo "ERROR: Mount it read-write, or unset the variable that points at it." >&2
    exit 1
  fi

  # Already usable: leave the mount's ownership exactly as it is. This is the
  # common case on every restart and for host directories that are already
  # prepared, and it keeps `chown -R` off host files that do not need it.
  writable_by_run_user "$dir" && return 0

  # Bind-mounted host directories are typically root-owned, so hand this one
  # over — only now that the probe has shown it is actually necessary.
  chown_error=$(chown -R "$RUN_USER" "$dir" 2>&1) || true
  writable_by_run_user "$dir" && return 0

  echo "WARNING: $dir could not be handed over to '$RUN_USER'."
  if [ -n "$chown_error" ]; then
    echo "WARNING: chown said: $chown_error"
  fi

  # Some remote filesystems ignore chown while root can still write. Staying
  # root keeps those setups working, and unlike a blind fallback it is backed by
  # a check: root demonstrably can write here.
  if writable_by_me "$dir"; then
    echo "WARNING: Keeping the server as root, which can write to $dir."
    echo "WARNING: Set FAUXQS_RUN_USER to a user that owns it to drop privileges."
    ROOT_FALLBACK_REASON="$dir not writable by '$RUN_USER'"
    return 0
  fi

  echo "ERROR: $dir is writable by neither '$RUN_USER' nor root — most likely a" >&2
  echo "ERROR: read-only mount. Root could not write it either, so falling back to" >&2
  echo "ERROR: root would only trade one failure for another: refusing to start." >&2
  echo "ERROR: Mount $dir read-write, or unset the variable that points at it." >&2
  exit 1
}

# Directories the server actually writes to. Collected as this function's own
# positional parameters, which shadow the script's: paths containing spaces
# survive, and the container's CMD arguments in $@ are left untouched.
# Mirrors src/server.ts: dataDir is only used when FAUXQS_PERSISTENCE=true.
preflight_write_dirs() {
  set --
  if [ "$FAUXQS_PERSISTENCE" = "true" ] && [ -n "$FAUXQS_DATA_DIR" ]; then
    set -- "$@" "$FAUXQS_DATA_DIR"
  fi
  if [ -n "$FAUXQS_S3_STORAGE_DIR" ]; then
    set -- "$@" "$FAUXQS_S3_STORAGE_DIR"
  fi
  for dir in "$@"; do
    check_write_dir "$dir"
  done
}

preflight_write_dirs

# The one place the server is launched. $1 describes the user it ends up running
# as; anything after it is a launcher prefix the server command is appended to.
start_server() {
  echo "Server user: $1"
  shift
  exec "$@" tini -- node dist/server.js
}

if [ "$FAUXQS_RUN_AS_ROOT" = "true" ]; then
  # Escape hatch for setups where the server genuinely needs root.
  start_server "root (FAUXQS_RUN_AS_ROOT=true)"
elif [ "$STARTED_AS_ROOT" = false ]; then
  start_server "$(id -un 2>/dev/null || id -u) (container started as non-root)"
elif [ -n "$ROOT_FALLBACK_REASON" ]; then
  start_server "root (fallback: $ROOT_FALLBACK_REASON)"
else
  start_server "$RUN_USER" su-exec "$RUN_USER"
fi
