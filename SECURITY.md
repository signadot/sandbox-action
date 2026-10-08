# Security policy

## Reporting a vulnerability

Please email **security@signadot.com** rather than opening a public issue or pull
request. Include what you found, how to reproduce it, and the version of the
Action (`signadot/sandbox-action@vX.Y.Z`) and of the `signadot` CLI involved. We aim
to acknowledge reports within three working days.

Vulnerabilities in the Signadot platform itself, rather than in this Action, go to
the same address.

## Supported versions

Fixes are made on `main` and released as a new version. While the Action is `0.x`,
only the latest release receives fixes; pin an exact version and upgrade to pick
them up.

## How the Action handles secrets

- **`api-key`** reaches the `signadot` CLI only through the `SIGNADOT_API_KEY`
  environment variable of the process it starts, never on the command line, so it
  cannot appear in a process listing or in the `Running: signadot …` log lines. It
  is registered with the runner as a secret before anything else runs, so the
  runner masks it if it ever reaches a log.
- **`dry-run: true`** needs no API key at all.
- **The CLI the Action installs** is downloaded from the
  [signadot/cli](https://github.com/signadot/cli) GitHub releases and verified
  against the release's `checksums.txt` before it runs.
- **Usage reporting** sends one request header to the Signadot API,
  `signadot-client-context`, carrying only this Action's name and version.

## For maintainers: workflows in this repository

- The `e2e` workflow's dry-run job needs no secrets, so it runs on pull requests
  from forks.
- The live job, which creates a real sandbox, uses `SIGNADOT_API_KEY` and runs only
  when triggered by hand (`workflow_dispatch`), never on a pull request.
