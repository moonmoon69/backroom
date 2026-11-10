#!/bin/sh
# Installs Backroom, or updates a copy of it, to the newest release: a tag v<major>.<minor>.<patch> on its repository,
# three plain numbers with no leading zero and at most nine digits each. No other tag is a release.
#
#   curl -fsSL https://raw.githubusercontent.com/moonmoon69/backroom/main/install.sh | sh
#   sh install.sh [folder]
#
# The folder is the argument, else BACKROOM_DIR, else ~/backroom. With no copy there, it clones BACKROOM_REPO (the
# GitHub repository by default) at its newest release, or on its default branch while it has none. With a copy there,
# it fetches the copy's own origin and moves the copy to the newest release. Either way it then installs the packages
# (npm ci) and builds the page (npm run build:web).
#
# It never touches a folder that is not a copy of Backroom (by the name in its package.json), nor a copy with work of
# its own: uncommitted changes, or commits the newest release does not contain. When the packages or the page fail after
# the copy was moved, or the script is stopped (INT or TERM), it puts the copy back on the commit it was on: the page it
# served first, then the commit, then that commit's packages. Should that npm ci fail too, the copy is on its old commit
# with its old page, and the script names the command that finishes it. Backroom's Update runs this same script on its
# own folder.
#
# The whole script is one function, called on its last line, so a download cut short never runs a part of the script,
# and a copy that replaces this file while it runs does not change what runs.

main() {
  set -eu
  export GIT_TERMINAL_PROMPT=0
  command -v git >/dev/null 2>&1 || fail "git is needed; install git, then run this again."
  command -v node >/dev/null 2>&1 || fail "Node 24 or newer is needed; install it, then run this again."
  command -v npm >/dev/null 2>&1 || fail "npm is needed; it comes with Node."
  node_major=$(node -p 'process.versions.node.split(".")[0]')
  [ "$node_major" -ge 24 ] || fail "Node 24 or newer is needed; this node is $(node --version)."
  repo=${BACKROOM_REPO:-https://github.com/moonmoon69/backroom.git}
  dir=${1:-${BACKROOM_DIR:-$HOME/backroom}}
  if [ -e "$dir/.git" ]; then update; else install; fi
}

say() { printf '%s\n' "$*"; }
fail() {
  printf 'install.sh: %s\n' "$*" >&2
  exit 1
}

# A path as the shell reads it back in a printed command: as it is when it is plain, else in single quotes.
quoted() {
  case $1 in
    '' | *[!A-Za-z0-9_./+-]*) printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")" ;;
    *) printf '%s' "$1" ;;
  esac
}

# The newest release tag of a repository (a URL or a remote's name), or nothing. git's version order sorts the three
# numbers as numbers (v0.10.0 after v0.9.0). A number with a leading zero or more than nine digits makes no release:
# git and Backroom's row (src/app/backroomUpdate.ts) would order those differently.
newest_tag() {
  number='(0|[1-9][0-9]{0,8})'
  refs=$(git ls-remote --tags --refs --sort=-v:refname "$1" 'v*') || return 1
  printf '%s\n' "$refs" | sed 's|.*refs/tags/||' | { grep -E "^v$number\.$number\.$number\$" || true; } | head -n 1
}

install() {
  if [ -e "$dir" ] && [ -n "$(ls -A "$dir")" ]; then fail "$dir is not empty and is not a git checkout: name a new or empty folder."; fi
  tag=$(newest_tag "$repo") || fail "could not read the releases of $repo."
  if [ -n "$tag" ]; then
    git -c advice.detachedHead=false clone --quiet --branch "$tag" "$repo" "$dir"
    say "Cloned $repo at $tag into $dir."
  else
    git clone --quiet "$repo" "$dir"
    say "Cloned $repo into $dir. It has no release yet, so the copy is on its default branch."
  fi
  cd "$dir"
  npm ci || fail "npm ci failed in $dir; fix the cause, then run this again."
  npm run build:web || fail "the page's build failed in $dir; fix the cause, then run this again."
  say "Backroom $(version) is installed in $dir."
  say "Start it with: cd $(quoted "$dir") && npm start"
  # The address the service listens on: ROOMS_PORT, else its default (src/config.ts).
  say "Then open http://127.0.0.1:${ROOMS_PORT:-4400}"
}

version() { node -p 'require("./package.json").version'; }

update() {
  cd "$dir"
  [ "$(git rev-parse --show-toplevel)" = "$(pwd -P)" ] || fail "$dir is inside another git checkout, not a copy of Backroom."
  [ "$(node -p 'require("./package.json").name' 2>/dev/null)" = backroom ] || fail "$dir is not a copy of Backroom: its package.json does not name backroom. Nothing was changed."
  [ -z "$(git status --porcelain)" ] || fail "$dir has uncommitted changes; nothing was changed. Commit or remove them first."
  git fetch --quiet --tags origin || fail "could not fetch from $dir's origin; nothing was changed."
  tag=$(newest_tag origin) || fail "could not read the releases of $dir's origin; nothing was changed."
  [ -n "$tag" ] || fail "$dir's origin has no release yet; nothing was changed."
  git merge-base --is-ancestor HEAD "refs/tags/$tag" || fail "$dir has commits that $tag does not contain; nothing was changed."
  from=$(git describe --tags --exact-match HEAD 2>/dev/null || git rev-parse --short HEAD)
  from_commit=$(git rev-parse HEAD)
  from_branch=$(git symbolic-ref --quiet --short HEAD || true)
  saved=$(mktemp -d)
  trap 'rm -rf "$saved"' EXIT
  [ ! -d web/dist ] || cp -R web/dist "$saved/dist"
  # From here, before the copy moves, a failure or a stop (Update's timeout sends TERM) puts the copy back.
  trap 'put_back "the update was stopped"' INT TERM
  git -c advice.detachedHead=false checkout --quiet --detach "refs/tags/$tag" || put_back "the checkout failed"
  say "Moved $dir from $from to $tag."
  npm ci || put_back "npm ci failed"
  npm run build:web || put_back "the page's build failed"
  trap - INT TERM
  say "Backroom $(version) is installed in $dir. Restart it to run the new version: stop it, then start it again with: cd $(quoted "$dir") && npm start (or restart the service that runs it)."
}

# Back to the commit the copy was on, page first, then the commit and its packages; then stop, naming what failed. It
# runs to its end: a second INT or TERM is ignored.
put_back() {
  trap '' INT TERM
  say "$1 on $tag; putting $dir back on $from." >&2
  # The page first, so the page served is the one the copy served before, whatever fails after this.
  if [ -d "$saved/dist" ]; then rm -rf web/dist && cp -R "$saved/dist" web/dist; fi
  if [ -n "$from_branch" ]; then git checkout --quiet --force "$from_branch"; else git -c advice.detachedHead=false checkout --quiet --force --detach "$from_commit"; fi \
    || fail "$1 on $tag, and checking out $from failed too. Finish it with: cd $(quoted "$dir") && git checkout --force $from_commit && npm ci && npm run build:web"
  npm ci || fail "$1 on $tag, and npm ci failed on $from too: $dir is on $from with the page it served, but its packages are not installed. Finish it with: cd $(quoted "$dir") && npm ci"
  if [ ! -d "$saved/dist" ]; then
    npm run build:web || fail "$1 on $tag, and the page's build failed on $from too: $dir is on $from. Finish it with: cd $(quoted "$dir") && npm run build:web"
  fi
  fail "$1 on $tag; $dir is back on $from as it was."
}

main "$@"
