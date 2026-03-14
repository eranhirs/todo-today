#!/usr/bin/env bash
# Deploy a static public demo to GitHub Pages.
#
# This script:
#   1. Seeds demo data and starts a temporary local backend to capture state
#   2. Builds the frontend in gh-pages mode (base path /claude-todos/)
#   3. Injects the captured state into index.html as window.__DEMO_STATE__
#   4. Force-pushes the result to the gh-pages branch
#
# The result is a fully static demo — no backend required.
# URL: https://eranhirs.github.io/claude-todos/
set -e

cd "$(dirname "$0")/.."

export PATH="$HOME/local/node-v20.19.0-linux-x64/bin:$PATH"
PYTHON=python3.9
PROJECT_DIR="$(pwd)"
DEMO_DATA="$PROJECT_DIR/demo/data"
TEMP_PORT=51399

# ── 1. Seed demo data and capture state ────────────────────────
echo "Seeding demo data..."
.venv/bin/$PYTHON demo/seed.py "$DEMO_DATA"

echo "Starting temporary backend to capture state..."
TODO_DATA_DIR="$DEMO_DATA" TODO_DEMO=1 .venv/bin/uvicorn backend.main:app \
  --host 127.0.0.1 --port $TEMP_PORT &
UVICORN_PID=$!
trap "kill $UVICORN_PID 2>/dev/null" EXIT

for i in 1 2 3 4 5; do
  sleep 1
  if curl -s -o /dev/null "http://127.0.0.1:$TEMP_PORT/api/state" 2>/dev/null; then
    break
  fi
done

STATE_JSON=$(curl -s "http://127.0.0.1:$TEMP_PORT/api/state")
if [ -z "$STATE_JSON" ] || [ "$STATE_JSON" = "" ]; then
  echo "ERROR: Failed to capture demo state"
  exit 1
fi
echo "  Captured demo state ($(echo "$STATE_JSON" | wc -c) bytes)"

kill $UVICORN_PID 2>/dev/null
trap - EXIT

# ── 2. Build frontend in gh-pages mode ─────────────────────────
echo "Building frontend (gh-pages mode)..."
cd frontend
npm install --silent
npx vite build --mode gh-pages
cd ..

# ── 3. Inject state into index.html ───────────────────────────
echo "Injecting demo state into index.html..."
.venv/bin/$PYTHON -c "
import json, sys
state = json.loads(sys.argv[1])
safe_json = json.dumps(state, ensure_ascii=True, separators=(',', ':'))
html = open('frontend/dist/index.html').read()
tag = '<script>window.__DEMO_STATE__=' + safe_json + ';</script>'
html = html.replace('</head>', tag + '</head>', 1)
open('frontend/dist/index.html', 'w').write(html)
" "$STATE_JSON"

# ── 4. Deploy to gh-pages branch ──────────────────────────────
echo "Deploying to gh-pages branch..."
DIST_DIR="$PROJECT_DIR/frontend/dist"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
COMMIT_MSG="Deploy static demo ($(date +%Y-%m-%d))"

# Create a temporary directory for the gh-pages worktree
WORK_DIR=$(mktemp -d)
trap "rm -rf $WORK_DIR" EXIT

# Check if gh-pages branch exists
if git show-ref --verify --quiet refs/heads/gh-pages; then
  git worktree add "$WORK_DIR" gh-pages
else
  # Create orphan gh-pages branch
  git worktree add --detach "$WORK_DIR"
  cd "$WORK_DIR"
  git checkout --orphan gh-pages
  git rm -rf . 2>/dev/null || true
  cd "$PROJECT_DIR"
fi

# Copy built files to worktree
rm -rf "$WORK_DIR/assets"
cp -r "$DIST_DIR"/* "$WORK_DIR/"

# Add .nojekyll so GitHub Pages serves files as-is (underscored dirs, etc.)
touch "$WORK_DIR/.nojekyll"

# Commit and push
cd "$WORK_DIR"
git add -A
if git diff --cached --quiet; then
  echo "No changes to deploy."
else
  git commit -m "$COMMIT_MSG"
  git push origin gh-pages --force
  echo ""
  echo "Static demo deployed to GitHub Pages!"
  echo "  URL: https://eranhirs.github.io/claude-todos/"
fi

# Clean up worktree
cd "$PROJECT_DIR"
git worktree remove "$WORK_DIR" --force 2>/dev/null || rm -rf "$WORK_DIR"

echo "  No backend required — state is embedded in the HTML."
