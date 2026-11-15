#!/bin/bash
# Installs the LaunchAgent local.omp-mobile: launchd starts the server at login and restarts it
# when it exits. Run it again after you move the server folder or reinstall bun.
set -euo pipefail

label=local.omp-mobile
server_dir=$(cd "$(dirname "$0")/.." && pwd -P)
bun_path=$(command -v bun) || { echo "install-launchd: bun is not on PATH" >&2; exit 1; }
bun_dir=$(dirname "$bun_path")
agents="$HOME/Library/LaunchAgents"
plist="$agents/$label.plist"
domain="gui/$(id -u)"

# The values go into sed replacements and XML text unescaped.
for value in "$server_dir" "$HOME" "$bun_dir"; do
  case "$value" in
    *[\&\<\>\|]*)
      echo "install-launchd: cannot use a path that contains &, <, > or |: $value" >&2
      exit 1
      ;;
  esac
done

mkdir -p "$agents" "$HOME/Library/Logs"
rendered=$(mktemp)
trap 'rm -f "$rendered"' EXIT
sed -e "s|{{SERVER_DIR}}|$server_dir|g" -e "s|{{HOME}}|$HOME|g" -e "s|{{BUN_DIR}}|$bun_dir|g" \
  "$server_dir/launchd/$label.plist.template" > "$rendered"
if grep -q '{{' "$rendered"; then
  echo "install-launchd: the template has a placeholder this script does not fill" >&2
  exit 1
fi
plutil -lint -s "$rendered"
mv "$rendered" "$plist"
chmod 644 "$plist"

# Unload the running job and wait until it is gone, so the new server never starts while the old one holds the port.
if launchctl print "$domain/$label" > /dev/null 2>&1; then
  launchctl bootout "$domain/$label" || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    launchctl print "$domain/$label" > /dev/null 2>&1 || break
    sleep 1
  done
  if launchctl print "$domain/$label" > /dev/null 2>&1; then
    echo "install-launchd: $label is still loaded 10 seconds after bootout" >&2
    exit 1
  fi
fi

launchctl bootstrap "$domain" "$plist"
echo "install-launchd: $label runs $server_dir/omp-mobile-server.sh; logs in $HOME/Library/Logs/omp-mobile.log"
