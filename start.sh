#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

# Build frontend
echo "Building frontend..."
cd frontend
npm install --silent
npm run build
cd ..

# Copy build output to backend/static
rm -rf backend/static
cp -r frontend/dist backend/static

# Set up Python venv if needed
if [ ! -d .venv ]; then
  echo "Creating Python venv..."
  python3 -m venv .venv
fi

echo "Installing Python dependencies..."
source .venv/bin/activate
pip install -q -r requirements.txt

# Stop any existing instance
lsof -ti:5151 2>/dev/null | xargs kill 2>/dev/null || true

# Start server
echo "Starting Claude Todos on http://localhost:5151"
exec uvicorn backend.main:app --host 0.0.0.0 --port 5151
