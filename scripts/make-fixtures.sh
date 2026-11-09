#!/bin/bash
# Builds the gate repositories in $1 (default ~/git-commit-graph-work/fx). Real clones need the network once.
# usage: scripts/make-fixtures.sh [dir] [--no-clone]
set -euo pipefail
FX="${1:-$HOME/git-commit-graph-work/fx}"
NOCLONE="${2:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$FX"
cd "$FX"
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL="$FX/gitconfig"
printf '[user]\n\tname = Gate User\n\temail = gate@example.com\n[init]\n\tdefaultBranch = main\n[protocol "file"]\n\tallow = always\n[advice]\n\tdetachedHead = false\n' > "$GIT_CONFIG_GLOBAL"
t=1700000000
c() { t=$((t+60)); mkdir -p "$(dirname "$1")"; printf '%s\n' "$2" >> "$1"; git add -- "$1"; GIT_AUTHOR_DATE="$t +0000" GIT_COMMITTER_DATE="$t +0000" git commit -q -m "$3"; }

# 1. big: 200,000 commits on 30 lanes with merges and tags, made with git fast-import (real git objects)
if [ ! -d big200k ]; then
  git init -q big200k
  node "$HERE/gen-fastimport.js" 200000 30 | (cd big200k && git fast-import --quiet)
  (cd big200k && git checkout -q main && git gc -q --auto && git commit-graph write --reachable 2>/dev/null || true)
fi

# 2. real repositories (network once)
if [ -z "$NOCLONE" ]; then
  [ -d express ] || git clone -q https://github.com/expressjs/express.git express
  [ -d express-shallow ] || git clone -q --depth 50 "file://$FX/express" express-shallow
fi

# 3. many branches (monorepo style): 80 feature branches off main, some merged
if [ ! -d monorepo ]; then
  git init -q monorepo; cd monorepo
  for i in $(seq 1 40); do c "packages/core/f$i.txt" "core $i" "core: change $i"; done
  for b in $(seq 1 80); do
    git checkout -q -b "feature/team-$((b % 8))/task-$b" main~$((b % 30))
    c "packages/p$b/a.txt" "work $b" "p$b: first change"
    c "packages/p$b/a.txt" "more $b" "p$b: second change"
    git checkout -q main
    if [ $((b % 5)) -eq 0 ]; then t=$((t+60)); GIT_AUTHOR_DATE="$t +0000" GIT_COMMITTER_DATE="$t +0000" git merge -q --no-ff -m "Merge feature/team-$((b % 8))/task-$b" "feature/team-$((b % 8))/task-$b"; fi
  done
  git tag -a v2.0.0 -m "Release 2.0.0"
  cd "$FX"
fi

# 4. submodules
if [ ! -d with-submodules ]; then
  git init -q sublib; (cd sublib && c lib.txt "lib v1" "lib: first" && c lib.txt "lib v2" "lib: second")
  git init -q with-submodules; cd with-submodules
  c README.md "app" "app: first"
  git -c protocol.file.allow=always submodule -q add "$FX/sublib" vendor/sublib
  t=$((t+60)); GIT_AUTHOR_DATE="$t +0000" GIT_COMMITTER_DATE="$t +0000" git commit -q -m "Add submodule vendor/sublib"
  c app.txt "x" "app: second"
  cd "$FX"
fi

# 5. signed commits (SSH signing with a throwaway key made here)
if [ ! -d signed ]; then
  rm -f "$FX/signkey" "$FX/signkey.pub"
  ssh-keygen -q -t ed25519 -N '' -f "$FX/signkey" -C gate
  git init -q signed; cd signed
  git config gpg.format ssh; git config user.signingkey "$FX/signkey.pub"; git config commit.gpgsign true
  for i in 1 2 3 4; do c s.txt "$i" "signed commit $i"; done
  git config commit.gpgsign false
  cd "$FX"
fi

# 6. octopus merge with 10 parents
if [ ! -d octopus ]; then
  git init -q octopus; cd octopus
  c base.txt base "base"
  for i in $(seq 1 9); do git checkout -q -b "leg-$i" main; c "leg$i.txt" "$i" "leg $i"; done
  git checkout -q main; c main.txt m "main moves"
  t=$((t+60)); GIT_AUTHOR_DATE="$t +0000" GIT_COMMITTER_DATE="$t +0000" git merge -q -m "Octopus merge of 9 legs" leg-1 leg-2 leg-3 leg-4 leg-5 leg-6 leg-7 leg-8 leg-9
  cd "$FX"
fi

# 7. linear repos for the write actions (squash, rebase, reset); a pristine copy is kept for the CLI comparison
if [ ! -d actions ]; then
  git init -q actions; cd actions
  for i in $(seq 1 8); do c "f$i.txt" "$i" "step $i"; done
  git checkout -q -b topic main~3; c topic.txt t1 "topic 1"; c topic.txt t2 "topic 2"
  git checkout -q main
  cd "$FX"; cp -R actions actions-cli
fi

# 8. detached HEAD
if [ ! -d detached ]; then
  git init -q detached; cd detached; for i in 1 2 3 4; do c d.txt "$i" "detached $i"; done; git checkout -q --detach HEAD~2; cd "$FX"
fi

# 9. a rebase stopped on a conflict
if [ ! -d mid-rebase ]; then
  git init -q mid-rebase; cd mid-rebase
  c x.txt base "base"; git checkout -q -b topic; c x.txt topic "topic change"; git checkout -q main; c x.txt main "main change"; git checkout -q topic
  git rebase main >/dev/null 2>&1 || true
  cd "$FX"
fi

# 10. hostile: hooks, fsmonitor, textconv, external diff and pager that would write a marker file
if [ ! -d hostile-hooks ]; then
  git init -q hostile-hooks; cd hostile-hooks
  c a.secret one "first"; c a.secret two "second"
  printf '*.secret diff=evil\n' > .gitattributes
  mkdir -p .git/evilhooks
  for h in post-checkout pre-commit reference-transaction post-index-change post-rewrite commit-msg; do
    printf '#!/bin/sh\necho %s >> "%s/PWNED"\n' "$h" "$FX" > ".git/evilhooks/$h"; chmod +x ".git/evilhooks/$h"
  done
  git config core.hooksPath "$FX/hostile-hooks/.git/evilhooks"
  git config core.fsmonitor "touch '$FX/PWNED'"
  git config diff.evil.textconv "touch '$FX/PWNED'; cat"
  git config diff.external "touch '$FX/PWNED'"
  git config core.pager "touch '$FX/PWNED'; cat"
  echo dirty >> a.secret
  cd "$FX"; rm -f "$FX/PWNED"
fi

# 11. hostile: corrupt pack
if [ ! -d corrupt-pack ]; then
  git init -q corrupt-pack; cd corrupt-pack; for i in $(seq 1 40); do c "f.txt" "line $i" "commit $i"; done; git gc -q
  p=$(ls .git/objects/pack/*.pack); chmod 644 "$p"
  python3 - "$p" <<'PY'
import sys
p = sys.argv[1]; b = bytearray(open(p, 'rb').read())
for i in range(200, len(b) - 40, 7): b[i] ^= 0xff
open(p, 'wb').write(bytes(b))
PY
  cd "$FX"
fi

# 12. branch names with Unicode and slashes
if [ ! -d unicode-branches ]; then
  git init -q unicode-branches; cd unicode-branches
  c u.txt base "Grundlage: Größe ändern"
  for b in "feature/ü-ñ/日本語" "fix/emoji-✨" "release/2026.11/rc-1" "user/zoë/π"; do git checkout -q -b "$b" main; c "u.txt" "$b" "work on $b"; done
  git checkout -q main; git tag "tag/ü-1"
  cd "$FX"
fi

# 13. empty repository
[ -d empty ] || git init -q empty

du -sh "$FX"
