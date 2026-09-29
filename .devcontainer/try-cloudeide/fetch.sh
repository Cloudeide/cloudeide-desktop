#!/usr/bin/env bash
# Installs what Electron needs and puts the last built CloudeIDE on the desktop.
#
# Run once, when the Codespace is created. Everything it downloads comes from
# this repository's own workflow runs, using the token the Codespace already
# holds.
set -euo pipefail

echo "--- libraries Electron expects on a desktop, which a base image omits ---"
sudo apt-get update -y
sudo apt-get install -y --no-install-recommends \
	libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libgbm1 \
	libgtk-3-0 libasound2 libxkbfile1 libsecret-1-0 xdg-utils

repo="${GITHUB_REPOSITORY:-Cloudeide/cloudeide-desktop}"

rm -rf ~/dl && mkdir -p ~/dl
echo "--- the latest release: the file the download button gives people ---"
if ! gh release download --repo "$repo" --pattern 'CloudeIDE-linux-x64.tar.gz' --dir ~/dl; then
	echo "--- no release to download; the most recent green desktop build instead ---"
	run="$(gh run list --repo "$repo" --workflow desktop.yml --status success \
		--limit 1 --json databaseId --jq '.[0].databaseId')"
	if [ -z "$run" ]; then
		echo "Nothing to download yet. Run the 'Desktop app' workflow, then re-run:"
		echo "  ./.devcontainer/try-cloudeide/fetch.sh"
		exit 0
	fi
	gh run download "$run" --repo "$repo" --name cloudeide-linux-x64 --dir ~/dl
fi

echo "--- unpacking ---"
rm -rf ~/VSCode-linux-x64
tar -xzf ~/dl/*.tar.gz -C ~
rm -rf ~/dl
test -x ~/VSCode-linux-x64/cloudeide

echo "--- a small project to open it on ---"
./build/cloudeide/sample-project.sh ~/cafe >/dev/null

# Fluxbox reads this at startup; without it the desktop is an empty grey field
# with no obvious way in.
mkdir -p ~/Desktop
cat > ~/Desktop/CloudeIDE.desktop <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=CloudeIDE
Exec=/home/vscode/VSCode-linux-x64/cloudeide --no-sandbox --disable-gpu --password-store=basic /home/vscode/cafe
Terminal=false
DESKTOP
chmod +x ~/Desktop/CloudeIDE.desktop

# And a one-word way to start it from a terminal, for whoever prefers that.
sudo ln -sf ~/VSCode-linux-x64/cloudeide /usr/local/bin/cloudeide

cat <<'DONE'

CloudeIDE is unpacked at ~/VSCode-linux-x64.

Open the forwarded port 6080 in a browser — phone included — and the
desktop appears. Start the application by typing `cloudeide` in a
terminal here, or by clicking CloudeIDE on that desktop.
DONE
