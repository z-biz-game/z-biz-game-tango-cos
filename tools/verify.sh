#!/usr/bin/env bash
# One-shot verification: the node suites first, then a real browser against a real server,
# driven over CDP. Everything the script starts is in one process group and dies with it,
# including the Chrome it launched in a temp profile.
#
# Ports are 5191/9351 on purpose: sibling repos in this farm run their own verify against
# 5180/9340, and only ONE headless Chrome may bind a debug port on this machine at a time.
# Never add --use-gl=angle --use-angle=swiftshader: software raster saturates the cores and
# the process hangs without a CDP client. This game is plain 2D canvas; default headless is
# enough.
#
#   ./tools/verify.sh                        # node suites + @boot @play @routes @save @pointer
#   SKIP_UNIT=1 ./tools/verify.sh            # browser only (what ci.yml's browser job runs)
#   SCENARIOS="pointer" ./tools/verify.sh    # one suite while editing the view
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
CDP_PORT=${CDP_PORT:-9351}; if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$CDP_PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo ":$CDP_PORT is already LISTENING — a sibling gate or an orphan Chrome holds it; attaching there reads someone else's browser. Wait for it to finish, or rerun with CDP_PORT=<a free port>." >&2; lsof -nP -iTCP:"$CDP_PORT" -sTCP:LISTEN >&2 || true; exit 6; fi  # 一机一台：撞在同一个默认口上时不报错的是 Chrome，报错的是绿——先让路再开闸
WEB_PORT=${WEB_PORT:-5191}
BASE=${BASE_URL:-http://127.0.0.1:$WEB_PORT/}
SHOTS=${SHOTS_DIR:-/tmp/tango-shots}
CHROME=${CHROME_BIN:-}
if [ -z "$CHROME" ]; then
  for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
           "/Applications/Chromium.app/Contents/MacOS/Chromium" \
           google-chrome chromium chromium-browser; do
    if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then CHROME=$c; break; fi
  done
fi
[ -x "$CHROME" ] || { echo "no Chrome found; set CHROME_BIN" >&2; exit 2; }
mkdir -p "$SHOTS"

UDD=$(mktemp -d)
"$CHROME" --headless=new --remote-debugging-port=$CDP_PORT --user-data-dir=$UDD \
  --window-size=980,820 --no-first-run --no-default-browser-check about:blank >"$SHOTS/chrome.log" 2>&1 &
CPID=$!
node "$HERE/server.cjs" $WEB_PORT >"$SHOTS/server.log" 2>&1 &
SPID=$!
cleanup() {
  kill -9 $CPID $SPID 2>/dev/null
  wait $CPID 2>/dev/null
  wait $SPID 2>/dev/null
  rm -rf $UDD
}
trap cleanup EXIT
# Watchdog redirects its fds: a background subshell inherits the script's stdout, and if this
# ran inside a pipeline it would hold the write end open for the full timeout and stall the
# consumer long after the tests finished.
( sleep ${WD_TIMEOUT:-420}; cleanup ) </dev/null >/dev/null 2>&1 & WD=$!

# A fresh --user-data-dir binds DevTools noticeably later than a warm profile; wait on the
# endpoints, never on a guessed sleep. Both endpoints: devtools AND the web root.
for i in $(seq 1 60); do
  curl -fsS -m 1 "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS -m 2 "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1 || {
  echo "devtools never bound on :$CDP_PORT" >&2; exit 3; }
for i in $(seq 1 40); do
  curl -fsS -m 1 "$BASE" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS -m 2 "$BASE" >/dev/null 2>&1 || {
  echo "static server never answered on $BASE" >&2; exit 4; }

cd "$HERE"
FAILED=0

echo "=== node suites ==="
# SKIP_UNIT=1 for the browser job in CI: the suites are its own job there.
if [ -z "${SKIP_UNIT:-}" ]; then
  for f in test/*.test.mjs; do
    echo "--- $f"
    node "$f" || FAILED=1
  done
fi

export CDP_PORT
export BASE_URL=$BASE
node tools/playtest.mjs open "$BASE" | head -3
# js/data/lots.js is ~200 kB of measurement and the shell resolves a route before it reports a
# state, so wait on window.tango.state.id rather than on a timer.
BOOT=""
for i in $(seq 1 80); do
  BOOT=$(node tools/playtest.mjs eval "window.tango?window.tango.state.id:'nope'" nonav 2>/dev/null | tr -d '\n" ')
  case "$BOOT" in *nope*|"") sleep 0.5 ;; *) break ;; esac
done
echo "boot lot: $BOOT"
[ "$BOOT" = "nope" ] && { echo "window.tango never appeared at $BASE" >&2; exit 5; }
node tools/playtest.mjs shot "$SHOTS/boot.png" >/dev/null 2>&1

for s in ${SCENARIOS:-boot play routes save pointer}; do
  echo "=== @$s ==="
  node tools/playtest.mjs eval "@$s" nonav 2>&1 | python3 -c '
import sys, json
raw = sys.stdin.read()
start = raw.find("{")
if start < 0:
    print("NO RESULT", raw[-300:]); sys.exit(1)
depth = 0
for i in range(start, len(raw)):
    if raw[i] == "{": depth += 1
    elif raw[i] == "}":
        depth -= 1
        if depth == 0:
            try: d = json.loads(raw[start:i + 1])
            except Exception as e:
                print("BAD JSON", e, raw[start:start+200]); sys.exit(1)
            break
rows = d.get("rows", [])
print("rows:", len(rows), "fail:", d.get("fail"))
for r in rows:
    if not r["pass"]: print("  FAIL", r["test"], json.dumps(r["detail"], ensure_ascii=False)[:240])
sys.exit(1 if d.get("fail") else 0)
' || FAILED=1
done

# The win-state screenshot: drive one certified glance solve, then grab the board with the
# card up. (The suites above all end on reset or failure cards — none of them is the picture
# of a solved lot.)
echo "=== win shot ==="
node tools/playtest.mjs eval "(async () => {
  const t = window.tango;
  t.store.reset(); t.load('#/lot/glance-01');
  await new Promise((r) => setTimeout(r, 250));
  const r = t.autoPlay(3);
  await new Promise((r2) => setTimeout(r2, 350));
  return { won: t.state.won, guesses: t.state.guesses, stars: document.getElementById('stars').textContent };
})()" nonav | tail -5
node tools/playtest.mjs shot "$SHOTS/win.png" >/dev/null 2>&1

echo "=== console ==="
CONS=$(node tools/playtest.mjs logs)
echo "$CONS"
echo "$CONS" | grep -qE "\[(error|EXCEPTION|log:error)\]" && { echo "console has errors" >&2; FAILED=1; }

kill $WD 2>/dev/null
wait $WD 2>/dev/null
[ $FAILED -eq 0 ] && echo "=== ALL GREEN ===" || echo "=== FAILURES ABOVE ==="
exit $FAILED
