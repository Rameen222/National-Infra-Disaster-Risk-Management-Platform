#!/usr/bin/env bash
# NIRRP Portal — Production Server
# Run this on the HPC. Clients connect via browser on the local network.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo " ============================================================"
echo "  NIRRP Portal  |  Production Server Mode"
echo "  Heavy processing runs HERE. Clients connect via browser."
echo " ============================================================"
echo ""

# ── Load ports from project-root .env ──────────────────────────
SERVER_PORT=7542
PYBACKEND_PORT=7543
if [ -f ".env" ]; then
    while IFS='=' read -r key value; do
        [[ -z "$key" || "${key:0:1}" == "#" ]] && continue
        value="${value%%#*}"   # strip inline comments
        value="${value// /}"   # strip spaces
        case "$key" in
            SERVER_PORT)    SERVER_PORT=$value ;;
            PYBACKEND_PORT) PYBACKEND_PORT=$value ;;
        esac
    done < .env
fi

# ── Pick Python interpreter ─────────────────────────────────────
if command -v python3 >/dev/null 2>&1; then
    PYBIN=python3
elif command -v python >/dev/null 2>&1; then
    PYBIN=python
else
    echo "[ERROR] Python is not installed. Run ./install.sh first."
    exit 1
fi

# ── Step 1: Build React frontend ────────────────────────────────
echo "[1/3] Building frontend bundle (first run takes ~30s)..."
( cd "$SCRIPT_DIR/client" && npm run build )
echo "[OK] Frontend built → client/dist/"
echo ""

# ── Step 2: Start Express API server in background ──────────────
( cd "$SCRIPT_DIR/server" && npm run dev > "$SCRIPT_DIR/server.log" 2>&1 ) &
EXPRESS_PID=$!
echo "[2/3] Express API server starting on port $SERVER_PORT (PID $EXPRESS_PID)"
echo "      Logs: $SCRIPT_DIR/server.log"
echo ""
sleep 2

# ── Detect LAN IP ───────────────────────────────────────────────
LOCAL_IP=""
if command -v hostname >/dev/null 2>&1; then
    LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
fi
if [ -z "$LOCAL_IP" ] && command -v ipconfig >/dev/null 2>&1; then
    LOCAL_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)
fi

# ── Step 3: Start Flask (waitress) in production mode ───────────
echo "[3/3] Starting production server on port $PYBACKEND_PORT..."
echo ""
echo " ============================================================"
echo "  NIRRP Portal is LIVE"
echo "  ----------------------------------------------------------"
echo "  This machine   :  http://localhost:$PYBACKEND_PORT"
[ -n "$LOCAL_IP" ] && echo "  Network clients:  http://$LOCAL_IP:$PYBACKEND_PORT"
echo ""
echo "  Share the 'Network clients' URL with anyone on the LAN."
echo "  Press Ctrl+C to stop the server."
echo " ============================================================"
echo ""

# Stop Express on exit
cleanup() {
    echo ""
    echo "Stopping Express server..."
    kill "$EXPRESS_PID" 2>/dev/null || true
    exit 0
}
trap cleanup SIGINT SIGTERM

export NIRRP_MODE=production
export SERVER_PORT=$SERVER_PORT
( cd "$SCRIPT_DIR/pybackend" && $PYBIN app.py )
