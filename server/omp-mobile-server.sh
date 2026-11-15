#!/bin/bash
# Entry point for the LaunchAgent local.omp-mobile (see scripts/install-launchd.sh).
# System Settings > Login Items lists the job under this file name, so keep it descriptive.
# PATH and HOME come from the plist; the server reads its settings from its config file.
exec bun run "$(dirname "$0")/server.ts"
