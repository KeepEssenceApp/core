#!/bin/sh
# Starts the transcriber: reads the env file, then becomes the Python server (so launchd supervises Python itself).
# The key is only ever in that file (mode 600) and in the server's memory; this script never prints it.
set -eu

ROOT="$HOME/ke-transcriber"
ENV_FILE="${TRANSCRIBER_ENV_FILE:-$HOME/.config/ke-transcriber/env}"

[ -r "$ENV_FILE" ] || { echo "ke-transcriber: cannot read $ENV_FILE" >&2; exit 78; }
# Only its owner may read the file: -rw------- or -r--------.
case "$(ls -ld "$ENV_FILE" | cut -c1-10)" in
  -rw-------|-r--------) ;;
  *) echo "ke-transcriber: $ENV_FILE must be mode 600 (chmod 600 it)" >&2; exit 78 ;;
esac

set -a
. "$ENV_FILE"
set +a

# launchd starts agents with a bare PATH; ffmpeg and ffprobe are Homebrew's.
PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
export PATH
# The model is on disk after the one-time fetch; at run time nothing is downloaded and nothing is reported.
export HF_HUB_OFFLINE=1 HF_HUB_DISABLE_TELEMETRY=1

cd "$ROOT/app"
exec "$ROOT/venv/bin/python" -m ke_transcriber
