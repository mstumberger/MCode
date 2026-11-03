#!/usr/bin/env bash
# MCode BotDev - zagon dev builda (rebrand zliven v ta branch) z vsemi
# nastavitvami (STT/TTS iz .env.local, izoliran profil, ločen od
# produkcijske aplikacije).
# rebrand worktree (zcode-worktrees/mcode-rebrand) je bil odstranjen po zlivanju
# PR #2; koda teče direktno iz glavnega checkouta.
set -u
REPO=/home/virus/SystemInterface/ZCode
CODE=$REPO
LOG=/tmp/zcode-botdev.log

# 1. Počisti morebitno starejšo dev instanco (izključno dev procese;
#    produkcijska aplikacija /opt/ZCode se ne dotika).
pkill -f "dev-desktop-e[n]v.mjs" 2>/dev/null
pkill -f "packages/desktop/scripts/dev.m[j]s" 2>/dev/null
pkill -f "electron/dist/electron [.]" 2>/dev/null
pkill -f "concurrently -k -n tsu[p]" 2>/dev/null
sleep 3
for p in $(pgrep -f zcode-host-local 2>/dev/null); do
  if tr '\0' '\n' < "/proc/$p/environ" 2>/dev/null \
    | grep -q "^ZCODE_DATA_BASE_DIR=$REPO/.dev-profile$"; then
    kill "$p" 2>/dev/null
  fi
done
sleep 2

# 2. Zagon rebrand builda; env in profili ostanejo na glavnem checkoutu.
cd "$CODE" || exit 1
set -a
. "$REPO/.env.local"
set +a
export PATH="$HOME/.local/opt/node-v24.14.0-linux-x64/bin:$HOME/.local/bin:$PATH"
export DISPLAY="${DISPLAY:-:0}"
# Dev electron iz node_modules nima SUID chrome-sandbox; ob zagonu iz namizja
# (brez systemd user session okolja sej) Ubuntu AppArmor blokira user namespace
# sandbox. Za dev build je sandbox izklopljen; produkcijska /opt/ZCode ni prizadeta.
export ELECTRON_DISABLE_SANDBOX=1

ZCODE_DESKTOP_APPLICATION_NAME="MCode BotDev" \
ZCODE_DESKTOP_USER_DATA_DIR="$REPO/.dev-user-data" \
ZCODE_DESKTOP_SESSION_DATA_DIR="$REPO/.dev-user-data/session" \
ZCODE_DATA_BASE_DIR="$REPO/.dev-profile" \
ZCODE_DESKTOP_HOME_DIR="$REPO/.dev-profile" \
nohup pnpm dev:desktop > "$LOG" 2>&1 &
disown

# rebrand: obvestilo in naslov nosita MCode; ikona je regenerirana M ikona
# iz rebrand builda (ne ve /opt/ZCode z Z žigom).
notify-send -i "$CODE/packages/desktop/build/icon.png" "MCode BotDev" \
  "Zagon zagnan — okno bo gor v ~3 minutah. Log: $LOG" 2>/dev/null
exit 0
