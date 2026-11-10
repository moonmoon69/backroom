#!/bin/sh
# Installs Backroom, or updates a copy of it, to the newest release: a tag v<version> on its repository.
#
#   curl -fsSL https://raw.githubusercontent.com/moonmoon69/backroom/main/install.sh | sh
#   sh install.sh [folder]
#
# The folder is the argument, else BACKROOM_DIR, else ~/backroom. With no copy there, it clones BACKROOM_REPO (the
# GitHub repository by default) at its newest release, or on its default branch while it has none. With a copy there,
# it fetches the copy's own origin and moves the copy to the newest release; a prerelease counts only for a copy that
# runs one. Either way it then installs the packages (npm ci) and builds the page (npm run build:web).
#
# It never touches a copy with work of its own: uncommitted changes, or commits the newest release does not contain.
# When the packages or the page fail after the copy was moved, it puts the copy back on the commit it was on, with that
# commit's packages and the page it served, and says why. Backroom's Update runs this same script on its own folder.
#
# The whole script is one function, called on its last line, so a download cut short runs nothing, and a copy that
# replaces this file while it runs does not change what runs.

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

# The newest release tag of a repository (a URL or a remote's name), or nothing; "pre" counts prereleases too. git's
# version order with "-" as a suffix puts v1.0.0-beta.2 after v1.0.0-beta.1 and before v1.0.0.
newest_tag() {
  if [ "$2" = pre ]; then pattern='^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; else pattern='^v[0-9]+\.[0-9]+\.[0-9]+$'; fi
  refs=$(git -c versionsort.suffix=- ls-remote --tags --refs --sort=-v:refname "$1" 'v*') || return 1
  printf '%s\n' "$refs" | sed 's|.*refs/tags/||' | { grep -E "$pattern" || true; } | head -n 1
}

install() {
  if [ -e "$dir" ] && [ -n "$(ls -A "$dir")" ]; then fail "$dir is not empty and is not a git checkout: name a new or empty folder."; fi
  tag=$(newest_tag "$repo" release) || fail "could not read the releases of $repo."
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
  say "Backroom $(version) is installed in $dir. Start it with: cd $dir && npm start"
}

version() { node -p 'require("./package.json").version'; }

update() {
  cd "$dir"
  [ "$(git rev-parse --show-toplevel)" = "$(pwd -P)" ] || fail "$dir is inside another git checkout, not a copy of Backroom."
  [ -z "$(git status --porcelain)" ] || fail "$dir has uncommitted changes; nothing was changed. Commit or remove them first."
  case $(version) in *-*) channel=pre ;; *) channel=release ;; esac
  git fetch --quiet --tags origin || fail "could not fetch from $dir's origin; nothing was changed."
  tag=$(newest_tag origin "$channel") || fail "could not read the releases of $dir's origin; nothing was changed."
  [ -n "$tag" ] || fail "$dir's origin has no release yet; nothing was changed."
  git merge-base --is-ancestor HEAD "refs/tags/$tag" || fail "$dir has commits that $tag does not contain; nothing was changed."
  from=$(git describe --tags --exact-match HEAD 2>/dev/null || git rev-parse --short HEAD)
  from_commit=$(git rev-parse HEAD)
  from_branch=$(git symbolic-ref --quiet --short HEAD || true)
  saved=$(mktemp -d)
  trap 'rm -rf "$saved"' EXIT
  [ ! -d web/dist ] || cp -R web/dist "$saved/dist"
  git -c advice.detachedHead=false checkout --quiet --detach "refs/tags/$tag"
  say "Moved $dir from $from to $tag."
  # From here a failure, or a stop (Update's timeout sends TERM), puts the copy back.
  trap 'put_back "the update was stopped"' INT TERM
  npm ci || put_back "npm ci"
  npm run build:web || put_back "the page's build"
  trap - INT TERM
  say "Backroom $(version) is installed in $dir. Restart it to run the new version: stop it and run npm start in $dir again, or restart the service that runs it."
}

# Back to the commit the copy was on, with that commit's packages and the page it served; then stop, naming what failed.
put_back() {
  trap - INT TERM
  say "$1 failed on $tag; putting $dir back on $from." >&2
  if [ -n "$from_branch" ]; then git checkout --quiet --force "$from_branch"; else git -c advice.detachedHead=false checkout --quiet --force --detach "$from_commit"; fi
  npm ci || fail "$1 failed on $tag, and npm ci failed on $from too: $dir is on $from; run npm ci and npm run build:web there."
  if [ -d "$saved/dist" ]; then
    rm -rf web/dist && cp -R "$saved/dist" web/dist
  else
    npm run build:web || fail "$1 failed on $tag, and the page's build failed on $from too: $dir is on $from; run npm run build:web there."
  fi
  fail "$1 failed on $tag; $dir is back on $from as it was."
}

main "$@"
