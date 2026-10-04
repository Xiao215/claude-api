#!/usr/bin/env bash
# Stop claude-api and remove it from login items.
set -euo pipefail

case "$(uname -s)" in
Darwin)
  LABEL="com.$(whoami).claude-api"
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
  echo "Removed $LABEL"
  ;;
Linux)
  systemctl --user disable --now claude-api.service 2>/dev/null || true
  rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/claude-api.service"
  systemctl --user daemon-reload
  echo "Removed claude-api.service"
  ;;
*)
  echo "Nothing to remove on this system."
  ;;
esac
