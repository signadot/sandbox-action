# Contributing to the Signadot Sandbox Action

Thanks for your interest. Bug reports, documentation fixes and small, focused pull
requests for known issues are welcome.

For anything larger, such as a new input, a change to how a spec is built, or support
for another trigger, please **open an issue first** so we can agree on the approach
before you write the code. The Action's inputs are something people write into their
workflows, so we change them carefully.

To report a security problem, follow [SECURITY.md](SECURITY.md) instead of opening an
issue.

## Reporting a bug

Open an issue with:

- the version of the Action (`signadot/sandbox-action@vX.Y.Z`) and of the `signadot`
  CLI it ran (the step log says which);
- the step's `with:` inputs, with the API key and anything private removed;
- what happened, including the error, and what you expected.

A `dry-run: true` step needs no API key and prints the spec the Action would apply in
its `rendered-spec` output. It is often the quickest way to show the problem. Redact
anything sensitive in it before you paste it, such as env var values.

## Development setup

You need Node.js 24 and [pnpm](https://pnpm.io) 10.

```sh
git clone https://github.com/signadot/sandbox-action.git
cd sandbox-action
pnpm install
pnpm run all     # typecheck, lint and format check, tests, build
```

The code is TypeScript in `src/`. It is bundled with `ncc` into `dist/`, which GitHub
Actions runs directly, so **`dist/` is committed**. After changing anything in `src/`,
run `pnpm run build` and commit the rebuilt `dist/` with your change. CI fails if
`dist/` does not match the source.

Formatting and linting use [Biome](https://biomejs.dev): `pnpm run format` fixes what
it can, and `pnpm run lint` checks.

## Tests

```sh
pnpm test                     # unit tests
pnpm run run-local            # the whole Action, no Docker
pnpm run act                  # the whole Action in a container, with act
```

- Every change in behaviour needs a test. Bug fixes should come with a test that
  fails without the fix.
- `test/testdata/spec/` holds golden fixtures: workflow inputs, a CI environment and
  the spec the Action must produce. Do not change an expected spec to make a test
  pass unless the change in output is the point of your pull request, and say so in
  its description.
- `run-local` and `act` render specs without credentials. To try a real apply, see
  [Testing](README.md#testing) in the README.

## Pull requests

- Keep each pull request to one change, with commits that each make sense on their
  own.
- Describe what changes for someone using the Action, and why.
- Update the README and the `action.yml` input descriptions when behaviour changes.
- `pnpm run all` must pass, and `dist/` must be rebuilt.

A maintainer will review it. We may ask for changes, or decline changes that don't
fit the Action's direction, which is part of why larger changes start as an issue.

## Releases

Releases are cut by maintainers as exact version tags (`v0.1.0`, `v0.2.0`, …).
While the Action is `0.x` there are no moving major tags, so users pin an exact
version and upgrade deliberately.

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE), the same as the rest of the project.
