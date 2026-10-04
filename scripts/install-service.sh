#!/usr/bin/env bash
# Run claude-api in the background: starts at login, restarts if it crashes.
# macOS uses launchd, Linux a systemd user service. Undo with scripts/uninstall-service.sh
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)" || { echo "node not found on PATH"; exit 1; }
CLAUDE="$(command -v claude)" || { echo "claude not found on PATH — install Claude Code first"; exit 1; }
SERVICE_PATH="$(dirname "$CLAUDE"):$(dirname "$NODE"):/usr/bin:/bin"

case "$(uname -s)" in
Darwin)
  LABEL="com.$(whoami).claude-api"
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  LOG="$HOME/Library/Logs/claude-api.log"
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$DIR/server.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$SERVICE_PATH</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  echo "Installed $LABEL — running from $DIR"
  echo "Logs: tail -f $LOG"
  ;;
Linux)
  UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_DIR/claude-api.service" <<EOF
[Unit]
Description=claude-api: Claude Code as a local API
After=network-online.target

[Service]
WorkingDirectory=$DIR
ExecStart="$NODE" "$DIR/server.mjs"
Environment="PATH=$SERVICE_PATH"
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now claude-api.service
  echo "Installed claude-api.service — running from $DIR"
  echo "Logs: journalctl --user -u claude-api -f"
  echo "To keep it running while you're logged out: loginctl enable-linger $USER"
  ;;
*)
  echo "Only macOS and Linux are supported here — on Windows, run 'npm start' (or use WSL)."
  exit 1
  ;;
esac
