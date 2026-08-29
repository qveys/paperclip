#!/bin/sh
set -e

# Capture runtime UID/GID from environment variables, defaulting to 1000
PUID=${USER_UID:-1000}
PGID=${USER_GID:-1000}

# Without root we can neither remap the node user (usermod/groupmod/chown)
# nor switch users (gosu needs CAP_SETUID/CAP_SETGID), so exec directly.
if [ "$(id -u)" -ne 0 ]; then
    if [ "$(id -u)" -ne "$PUID" ] || [ "$(id -g)" -ne "$PGID" ]; then
        echo "docker-entrypoint.sh: running unprivileged as $(id -u):$(id -g); cannot remap to requested ${PUID}:${PGID}" >&2
    fi
    export PATH="/opt/paperclip/bin:${PATH}"
    if [ -f /opt/paperclip/lib/zombie-safe-spawn.js ]; then
        export NODE_OPTIONS="${NODE_OPTIONS:-} --require /opt/paperclip/lib/zombie-safe-spawn.js"
    fi
    exec "$@"
fi

# Adjust the node user's UID/GID if they differ from the runtime request
if [ "$(id -u node)" -ne "$PUID" ]; then
    echo "Updating node UID to $PUID"
    usermod -o -u "$PUID" node
fi

if [ "$(id -g node)" -ne "$PGID" ]; then
    echo "Updating node GID to $PGID"
    groupmod -o -g "$PGID" node
    usermod -g "$PGID" node
fi

home_dir="${PAPERCLIP_HOME:-/paperclip}"
if [ -d "$home_dir" ] && [ -n "$(find "$home_dir" \( ! -user node -o ! -group node \) -print -quit 2>/dev/null)" ]; then
    chown -R node:node /paperclip /app/data 2>/dev/null || true
fi

export PATH="/opt/paperclip/bin:${PATH}"

# Bridges between /paperclip and /app/data for plugins and adapters
if [ -d /paperclip/.paperclip ]; then
    mkdir -p /app/data
    [ -e /app/data/.paperclip ] || ln -sfn /paperclip/.paperclip /app/data/.paperclip
    [ -e /app/data/adapter-plugins ] || ln -sfn /paperclip/adapter-plugins /app/data/adapter-plugins
fi

if [ -d /app/server/node_modules/@paperclipai ]; then
    mkdir -p /paperclip/adapter-plugins/node_modules
    ln -sfn /app/server/node_modules/@paperclipai /paperclip/adapter-plugins/node_modules/@paperclipai 2>/dev/null || true
    if [ -d /app/server/node_modules/@paperclipai/hermes-paperclip-adapter ]; then
        ln -sfn /app/server/node_modules/@paperclipai/hermes-paperclip-adapter /paperclip/adapter-plugins/node_modules/hermes-paperclip-adapter 2>/dev/null || true
    fi
fi

# Run entrypoint.d boot steps if present
ENTRYPOINT_D="/opt/paperclip/entrypoint.d"
if [ -d "$ENTRYPOINT_D" ]; then
    for step in "$ENTRYPOINT_D"/*.sh; do
        [ -e "$step" ] || continue
        name="$(basename "$step")"
        case "$name" in
            *.bg.sh)
                "$step" > "/tmp/entrypoint-${name%.sh}.log" 2>&1 &
                ;;
            *)
                "$step" || echo "warn: ${name} partiel" >&2
                ;;
        esac
    done
fi

if [ -f /opt/paperclip/lib/zombie-safe-spawn.js ]; then
    export NODE_OPTIONS="${NODE_OPTIONS:-} --require /opt/paperclip/lib/zombie-safe-spawn.js"
fi

exec gosu node "$@"
