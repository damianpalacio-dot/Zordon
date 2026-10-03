#!/bin/sh
# Pull the latest Zordon changes from GitHub and reinstall dependencies (double-click on a Mac).
cd "$(dirname "$0")/.." || exit 1
git pull && npm install && echo "Zordon is up to date. Start it again with start-zordon.command"
