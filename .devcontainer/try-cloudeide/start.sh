#!/usr/bin/env bash
# Opens CloudeIDE on the Codespace's desktop, on the sample project.
#
# Runs at every start. The desktop comes up in the background, so this waits
# for its display before starting the app, and does nothing if the app is
# already open or has not been downloaded.
set -uo pipefail

app="$HOME/VSCode-linux-x64/cloudeide"
[ -x "$app" ] || { echo "CloudeIDE is not downloaded yet: ./.devcontainer/try-cloudeide/fetch.sh"; exit 0; }
pgrep -f "VSCode-linux-x64/cloudeide" >/dev/null && { echo "CloudeIDE is already open"; exit 0; }

for _ in $(seq 1 60); do
	[ -S /tmp/.X11-unix/X1 ] && break
	sleep 1
done

# --password-store=basic: the desktop has no keyring, and without one storing
# the sign-in token stops on a question about which weaker store to use.
DISPLAY=:1 nohup "$app" --no-sandbox --disable-gpu --password-store=basic "$HOME/cafe" \
	>/tmp/cloudeide.log 2>&1 &
disown
echo "CloudeIDE is starting on the desktop (port 6080). Log: /tmp/cloudeide.log"
