#!/usr/bin/env bash
# Claude Code statusLine command: persists the statusLine stdin JSON (incl. rate_limits, if the
# build provides it) to store/statusline-latest.json (atomic), prints a short status line.
# No tokens are read or written; only the JSON Claude Code itself passes in.
#
# RATELIMITFEED1122: also writes store/.claude-rate-limits.json in the shape
# scripts/usage-collect.py's statusline fallback expects ({"written_at", "rate_limits"} --
# see scripts/statusline-ratelimit.sh, the earlier script that wrote that file). This
# script replaced that one as the configured statusLine command (.claude/settings.local.json)
# without taking over its second output, so the collector's "statusline" source had nothing
# to read since -- every run fell through to the token-count estimate. Measured 2026-11-22:
# ~/.claude/.credentials.json's own access token went empty around 2026-10-24 too (a second,
# independent cause), so the "authoritative" source had already stopped working by the time
# this mismatch would have mattered; fixing only this still leaves "authoritative" to restore
# separately before @/claude.ai/new#settings/usage-style absolute numbers are trustworthy, but
# the statusline fallback is this script's own job, written by every running session's
# periodic render -- that part is fixed here.
set -u
OUT="/MARVEEN/marveen/store/statusline-latest.json"
tmp="$(mktemp "${OUT}.XXXXXX")" || exit 0
cat > "$tmp"
chmod 600 "$tmp"
mv -f "$tmp" "$OUT"
RL_OUT="/MARVEEN/marveen/store/.claude-rate-limits.json" python3 -I - "$OUT" <<'PY' 2>/dev/null || echo "toni-shark"
import json,sys,os,time
d=json.load(open(sys.argv[1])); r=d.get('rate_limits') or {}
if r:
    rl_out = os.environ.get('RL_OUT')
    tmp2 = rl_out + '.tmp'
    try:
        with open(tmp2, 'w') as f:
            json.dump({'written_at': int(time.time()), 'session_id': d.get('session_id'), 'cwd': d.get('cwd'), 'rate_limits': r}, f)
        os.replace(tmp2, rl_out)
    except Exception:
        pass
f=(r.get('five_hour') or {}).get('used_percentage'); w=(r.get('seven_day') or {}).get('used_percentage')
print('5h %s%% | 7d %s%%'%(f,w) if f is not None or w is not None else 'toni-shark')
PY
