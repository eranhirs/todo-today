#!/usr/bin/env bash
# Launch a demo instance on port 5153 with isolated data.
# Does NOT interfere with the real instance on port 5152.
set -e

cd "$(dirname "$0")/.."

TAKE_SCREENSHOT=false
for arg in "$@"; do
  [[ "$arg" == "--screenshot" ]] && TAKE_SCREENSHOT=true
done

PYTHON=python3.9
DEMO_PORT=5153
DEMO_DATA="$(pwd)/demo/data"
TMUX_SESSION="todo-today-demo"

# Seed demo data (regenerates fresh each time)
echo "Seeding demo data..."
.venv/bin/$PYTHON demo/seed.py "$DEMO_DATA"

# Reuse the already-built frontend from backend/static
if [ ! -d backend/static ]; then
  echo "ERROR: backend/static not found. Run start-local.sh first to build the frontend."
  exit 1
fi

# Kill existing demo tmux session if running
while tmux has-session -t "$TMUX_SESSION" 2>/dev/null; do
  echo "Stopping existing demo (tmux session: $TMUX_SESSION)..."
  tmux kill-session -t "$TMUX_SESSION" 2>/dev/null
  sleep 0.5
done

# Start demo server with isolated data dir
echo "Starting demo on http://localhost:$DEMO_PORT"
tmux new-session -d -s "$TMUX_SESSION" \
  "cd $(pwd) && TODO_DATA_DIR=$DEMO_DATA TODO_DEMO=1 .venv/bin/uvicorn backend.main:app --host 0.0.0.0 --port $DEMO_PORT 2>&1 | tee demo/uvicorn.log"

# Wait for server
for i in 1 2 3 4 5; do
  sleep 1
  if ! tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    echo "ERROR: Demo server crashed. Check demo/uvicorn.log:"
    tail -5 demo/uvicorn.log
    exit 1
  fi
  if curl -s -o /dev/null "http://localhost:$DEMO_PORT/api/state" 2>/dev/null; then
    echo "Demo ready (tmux session: $TMUX_SESSION)."
    echo "  View logs: tmux attach -t $TMUX_SESSION"
    echo "  Stop:      tmux kill-session -t $TMUX_SESSION"

    if $TAKE_SCREENSHOT; then
      echo ""
      echo "Taking screenshot..."
      .venv/bin/$PYTHON demo/screenshot.py --port "$DEMO_PORT"
    fi
    exit 0
  fi
done
echo "WARNING: Demo started but not responding yet."
echo "  Check logs: tmux attach -t $TMUX_SESSION"
