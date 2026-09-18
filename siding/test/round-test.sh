#!/usr/bin/env bash
# Level 2, step 4: three signers on one box making blocks through the round over public relays;
# one signer down keeps the chain going, two down halts it, one back resumes it.
#   bash test/round-test.sh
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd); T=$(mktemp -d); RELAYS=${RELAYS:-wss://nos.lol,wss://relay.primal.net,wss://nostr.mom}; PIDS=()
step() { echo; echo "=== $*"; }; fail() { echo "FAILED: $*"; kill "${PIDS[@]}" 2>/dev/null || true; exit 1; }
cleanup() { kill "${PIDS[@]}" 2>/dev/null || true; rm -rf "$T"; }; trap cleanup EXIT
run() { node "$HERE/bin/siding.mjs" "$@" 2>&1 | grep -v Experimental; }
tip() { curl -s "http://127.0.0.1:$1/tip" | python3 -c "import json,sys; print(json.load(sys.stdin)['height'])" 2>/dev/null || echo -1; }
step "three signer keys"
for i in 1 2 3; do run key --create --chain "$HERE/chain.json" --key-file "$T/k$i" | python3 -c "import json,sys; print(json.load(sys.stdin)['pubkey'])" > "$T/p$i"; done
PUBS=$(cat "$T/p1" "$T/p2" "$T/p3" | tr "\n" "," | sed "s/,$//"); echo "  signers: $(cut -c1-8 "$T/p1")… $(cut -c1-8 "$T/p2")… $(cut -c1-8 "$T/p3")…"
step "a 2-of-3 document, genesis sealed by keys 1 and 2"
run new --name roundtest --prefix rt --signers "$PUBS" --threshold 2 --key-files "$T/k1,$T/k2" --out "$T/chain.json" --dir "$T/g" | grep -E '"chain"|"threshold"|"genesisHash"' | sed 's/^/  /'
step "three producers, 5-second blocks, proposing after 8 s when it is another's turn"
for i in 1 2 3; do mkdir -p "$T/d$i"; cp "$T/g/blocks.dat" "$T/g/blocks.json" "$T/d$i/"; node "$HERE/bin/siding.mjs" produce --chain "$T/chain.json" --dir "$T/d$i" --key-file "$T/k$i" --port $((3460 + i)) --interval 5 --tx-interval 5 --propose-after 8 --relay "$RELAYS" > "$T/p$i.log" 2>&1 & PIDS+=($!); done
sleep 6; for i in 1 2 3; do grep -q "level 2: signer" "$T/p$i.log" || { cat "$T/p$i.log"; fail "producer $i did not start as a signer"; }; done
step "mining until height 4 (up to 120 s)"
deadline=$((SECONDS + 120)); h=0; while [ $SECONDS -lt $deadline ]; do h=$(tip 3461); [ "$h" -ge 4 ] && break; sleep 2; done
[ "$h" -ge 4 ] || { tail -n 8 "$T/p1.log" "$T/p2.log"; fail "no block 4 in 120 s"; }
grep -E "sealed by|from .* \(sealed" "$T/p1.log" | tail -n 3 | sed 's/^/  /'
h2=$(tip 3462); h3=$(tip 3463); echo "  tips: 1=$h 2=$h2 3=$h3"; [ "$h2" -ge 3 ] && [ "$h3" -ge 3 ] || fail "the other signers did not follow"
step "proposals came from more than one signer (rotation)"
p=$(grep -h "round: proposed" "$T"/p*.log | wc -l); s=$(grep -h "round: signed" "$T"/p*.log | wc -l); echo "  $p proposals, $s partial signatures"
n1=$(grep -c "round: proposed" "$T/p1.log" || true); n2=$(grep -c "round: proposed" "$T/p2.log" || true); n3=$(grep -c "round: proposed" "$T/p3.log" || true); echo "  by signer: $n1 $n2 $n3"; [ $(( (n1>0) + (n2>0) + (n3>0) )) -ge 2 ] || fail "only one signer ever proposed"
step "signer 3 down: 2 of 3 keep going"
kill "${PIDS[2]}"; sleep 1; h0=$(tip 3461); deadline=$((SECONDS + 60)); while [ $SECONDS -lt $deadline ]; do h=$(tip 3461); [ "$h" -ge $((h0 + 2)) ] && break; sleep 2; done
[ "$h" -ge $((h0 + 2)) ] || fail "the chain did not advance with 2 of 3 (from $h0 to $h in 60 s)"; echo "  advanced $h0 -> $h"
step "signer 2 down too: 1 of 3 halts"
kill "${PIDS[1]}"; sleep 1; h0=$(tip 3461); sleep 30; h=$(tip 3461); [ "$h" -eq "$h0" ] || fail "the chain advanced with one signer ($h0 -> $h)"; echo "  held at $h0 for 30 s"
grep -q "dropping it" "$T/p1.log" && echo "  (signer 1's lone proposal was dropped)" || true
step "signer 2 back: the chain resumes"
node "$HERE/bin/siding.mjs" produce --chain "$T/chain.json" --dir "$T/d2" --key-file "$T/k2" --port 3462 --interval 5 --tx-interval 5 --propose-after 8 --relay "$RELAYS" > "$T/p2b.log" 2>&1 & PIDS+=($!)
deadline=$((SECONDS + 60)); while [ $SECONDS -lt $deadline ]; do h=$(tip 3461); [ "$h" -ge $((h0 + 2)) ] && break; sleep 2; done
[ "$h" -ge $((h0 + 2)) ] || { tail -n 6 "$T/p1.log" "$T/p2b.log"; fail "the chain did not resume ($h0 -> $h)"; }; echo "  resumed $h0 -> $h"
echo; echo "=== passed: 2-of-3 blocks through the round, rotation, one signer down tolerated, two halts, one back resumes"
