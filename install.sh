#!/usr/bin/env bash
set -e

echo "============================================"
echo " NIRRP Portal - Installing Dependencies"
echo "============================================"
echo ""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── 0/4: bootstrap .env files from templates ────────────────
if [ ! -f ".env" ] && [ -f ".env.example" ]; then
    cp ".env.example" ".env"
    echo "[OK] Created .env from .env.example"
fi
if [ ! -f "server/.env" ] && [ -f "server/.env.example" ]; then
    cp "server/.env.example" "server/.env"
    echo "[OK] Created server/.env from server/.env.example"
fi
mkdir -p "pybackend/temp"

# ── 1/4: Node.js + npm ──────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
    echo "[ERROR] Node.js is not installed. Download it from https://nodejs.org"
    exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
    echo "[ERROR] npm is not installed. It usually comes with Node.js."
    exit 1
fi
echo "[OK] Node.js $(node -v) detected"
echo "[OK] npm $(npm -v) detected"
echo ""

# ── 2/4: server (Express) ───────────────────────────────────
echo "[1/3] Installing server dependencies..."
( cd "$SCRIPT_DIR/server" && npm install )
echo "[OK] Server dependencies installed."
echo ""

# ── 3/4: client (Vite/React) ────────────────────────────────
echo "[2/3] Installing client dependencies..."
( cd "$SCRIPT_DIR/client" && npm install )
echo "[OK] Client dependencies installed."
echo ""

# ── 4/4: pybackend (Flask) ──────────────────────────────────
echo "[3/3] Installing Python dependencies..."
# Linux/macOS usually have python3; Windows-style python may also exist.
if command -v python3 >/dev/null 2>&1; then
    PYBIN=python3
elif command -v python >/dev/null 2>&1; then
    PYBIN=python
else
    echo "[ERROR] Python is not installed. Download it from https://www.python.org"
    exit 1
fi
echo "[OK] $($PYBIN --version) detected"
( cd "$SCRIPT_DIR/pybackend" && $PYBIN -m pip install --upgrade pip && $PYBIN -m pip install -r requirements.txt )
echo "[OK] Python dependencies installed."
echo ""

echo "============================================"
echo " All dependencies installed successfully!"
echo ""
echo " Development (this machine only):"
echo "   ./start.sh"
echo ""
echo " Production / HPC server (LAN access):"
echo "   ./serve.sh"
echo "============================================"
