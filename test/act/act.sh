#!/usr/bin/env bash
# Run the Action under `act`, which executes the workflow in a container the way
# a GitHub runner does — the closest local equivalent to the real thing.
#
#   pnpm run act                         # all the dry-run examples
#   pnpm run act -- -j single-fork       # one job
#   pnpm run act -- -W path/to.yml       # your own workflow
#
# Any arguments are passed through to act, so its own flags work as usual.
#
# The Action installs the CLI release it defaults to, as it does on a runner. To
# try it against an unreleased CLI change instead, set SIGNADOT_CLI_SRC to a CLI
# checkout: it is built for the container's platform and mounted in, and the
# Action uses it in place of a release.

set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT="$PWD"

# act runs linux containers. On Apple Silicon that is linux/arm64 unless you ask
# for amd64, in which case pass --container-architecture linux/amd64 and set
# ARCH here to match.
ARCH="${ARCH:-$(uname -m)}"
case "$ARCH" in
  arm64 | aarch64) GOARCH=arm64 ;;
  x86_64 | amd64) GOARCH=amd64 ;;
  *)
    echo "unsupported architecture $ARCH" >&2
    exit 1
    ;;
esac

CLI_ARGS=()
if [ -n "${SIGNADOT_CLI_SRC:-}" ]; then
  if [ ! -d "$SIGNADOT_CLI_SRC" ]; then
    echo "no signadot CLI checkout at $SIGNADOT_CLI_SRC" >&2
    exit 1
  fi
  echo "› building the signadot CLI for linux/$GOARCH from $SIGNADOT_CLI_SRC"
  mkdir -p bin
  (cd "$SIGNADOT_CLI_SRC" && GOOS=linux GOARCH="$GOARCH" GOWORK=off \
    go build -o "$ROOT/bin/signadot" ./cmd/signadot)
  # act's checkout honours .gitignore, so the CLI just built would not reach the
  # container on its own. Mounting bin/ is narrower than act's --bind, which
  # would expose the whole working tree to writes from the container.
  # SIGNADOT_CLI_PATH points the Action at it, in place of installing a release.
  CLI_ARGS=(--container-options "-v $PWD/bin:$PWD/bin" --env "SIGNADOT_CLI_PATH=$PWD/bin")
fi

echo "› building dist/"
pnpm run --silent build

# GITHUB_REPOSITORY otherwise defaults to nektos/act, which would show up in the
# rendered spec, so it is pinned to the event payload. GITHUB_SHA is always this
# repository's HEAD: act (0.2.89) ignores --env GITHUB_SHA and the event's
# head.sha, so image templates with {sha} render the local commit. The pin below
# is kept for the day act honours it.
exec act pull_request \
  -W test/act/dry-run.yml \
  -e test/act/pull-request.json \
  -P ubuntu-latest=catthehacker/ubuntu:act-latest \
  "${CLI_ARGS[@]}" \
  --env "GITHUB_REPOSITORY=${GITHUB_REPOSITORY:-signadot/hotrod}" \
  --env "GITHUB_SHA=${GITHUB_SHA:-abc1234def5678901234567890abcdef12345678}" \
  "$@"
