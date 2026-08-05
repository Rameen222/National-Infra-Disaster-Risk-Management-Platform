#!/usr/bin/env bash
echo "============================================"
echo " NIRRP Portal - Starting..."
echo "============================================"
echo ""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Load ports from project-root .env (with sensible fallbacks) ──
CLIENT_PORT=7541
SERVER_PORT=7542
PYBACKEND_PORT=7543
if [ -f ".env" ]; then
    while IFS='=' read -r key value; do
        # skip blank lines and comments
        [[ -z "$key" || "${key:0:1}" == "#" ]] && continue
        case "$key" in
            CLIENT_PORT)    CLIENT_PORT=$value ;;
            SERVER_PORT)    SERVER_PORT=$value ;;
            PYBACKEND_PORT) PYBACKEND_PORT=$value ;;
        esac
    done < .env
fi

# Pick whichever Python we have
if command -v python3 >/dev/null 2>&1; then
    PYBIN=python3
elif command -v python >/dev/null 2>&1; then
    PYBIN=python
else
    echo "[ERROR] Python is not installed. Run ./install.sh first."
    exit 1
fi

# ── 1/3: Express server in background ────────────────────────
( cd "$SCRIPT_DIR/server" && npm run dev > "$SCRIPT_DIR/server.log" 2>&1 ) &
SERVER_PID=$!
echo "[1/3] Express server starting on port $SERVER_PORT (PID $SERVER_PID)..."
echo "      (Server logs: $SCRIPT_DIR/server.log)"

# ── 2/3: Python backend in background ────────────────────────
( cd "$SCRIPT_DIR/pybackend" && PYBACKEND_PORT=$PYBACKEND_PORT $PYBIN app.py > "$SCRIPT_DIR/pybackend.log" 2>&1 ) &
PYBACKEND_PID=$!
echo "[2/3] Python backend starting on port $PYBACKEND_PORT (PID $PYBACKEND_PID)..."
echo "      (Python logs: $SCRIPT_DIR/pybackend.log)"

# Give backends a moment to bind
sleep 3

# ── Detect local network IP ──────────────────────────────────
LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
if [ -z "$LOCAL_IP" ]; then
    LOCAL_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)
fi

# ── Open browser ─────────────────────────────────────────────
URL="http://localhost:$CLIENT_PORT"
if command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1 &
elif command -v open >/dev/null 2>&1; then open "$URL" >/dev/null 2>&1 &
fi

echo "[3/3] Frontend client starting on port $CLIENT_PORT..."
echo ""
echo "============================================"
echo " Portal is live!"
echo " Local  : http://localhost:$CLIENT_PORT"
[ -n "$LOCAL_IP" ] && echo " Network: http://$LOCAL_IP:$CLIENT_PORT"
echo "============================================"
echo " (Ctrl+C stops everything.)"
echo "============================================"
echo ""

# Kill all children on Ctrl+C / exit
cleanup() {
    echo ""
    echo "Stopping backends..."
    kill $SERVER_PID $PYBACKEND_PID 2>/dev/null || true
    exit 0
}
trap cleanup SIGINT SIGTERM EXIT

# Run Vite in THIS terminal so the user sees client logs
( cd "$SCRIPT_DIR/client" && npm run dev )
