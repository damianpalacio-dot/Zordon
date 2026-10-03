#!/bin/sh
# Start the Zordon Command Center and open it as an app window (double-click on a Mac).
cd "$(dirname "$0")/.." || exit 1
[ -d node_modules ] || npm install
npm start &
SERVER=$!
sleep 3
URL=http://localhost:4000
if [ -d "/Applications/Google Chrome.app" ]; then
  open -na "Google Chrome" --args --app="$URL"
else
  open "$URL"
fi
# Closing this window shuts Zordon down — he says farewell on the way out.
trap 'kill $SERVER' INT TERM EXIT
wait $SERVER
