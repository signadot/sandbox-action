# Changelog

Each entry below is the body of the matching GitHub release. Releases are immutable
once published, so an entry is final before its tag is cut.

## v0.1.0

The first release of the Signadot Sandbox Action: a [Signadot](https://www.signadot.com)
sandbox for every pull request, from a few lines of workflow YAML.

```yaml
- uses: signadot/sandbox-action@v0.1.0
  id: sbx
  with:
    api-key: ${{ secrets.SIGNADOT_API_KEY }}
    org: acme
    cluster: prod-eks
    fork: kind=Deployment,namespace=hotrod,name=route
    image: ghcr.io/acme/route:${{ github.sha }}
```

To pin to a commit instead, use the SHA this release points at, shown on the
release page: `uses: signadot/sandbox-action@<full-commit-sha> # v0.1.0`.

### What's in it

- **Sandboxes from inputs, no YAML required.** Describe forks, images, env vars,
  endpoints and resources as step inputs. An `image` convention such as
  `ghcr.io/acme/{workload}:${{ github.sha }}` names the image for every fork in one
  line.
- **Or bring your own spec.** Use `template-file` with `@{var}` placeholders, bound
  through `set`, or an inline `spec`. The Action fills in only what your document
  leaves out.
- **A stable name per pull request.** The name is derived as `<repo>-<n>`, so every
  push updates the same sandbox in place.
- **Cleanup.** Built-in labels let the Signadot GitHub App delete the sandbox when the
  pull request closes. Add `ttl` as a backstop, or use the `delete` sub-action when
  your workflow decides.
- **Outputs to test against.** `routing-key`, `preview-url`/`preview-urls`,
  `dashboard-url` and `sandbox-name`. The step waits for the sandbox to be Ready by
  default.
- **`dry-run: true`.** Renders and validates the spec without an API key, and returns
  it as the `rendered-spec` output.
- **Sub-actions.**
  - `signadot/sandbox-action/delete`: delete a sandbox.
  - `signadot/sandbox-action/from-template`: the main action with `template-file`
    required.
  - `signadot/sandbox-action/install-cli`: install a checksum-verified `signadot` CLI.

### Requirements

- `signadot` CLI **v1.9.0 or later**. The Action runs the release it was tested with,
  v1.9.0, installed and checksum-verified unless an earlier step already did. Set
  `cli-version` to another release, or to `latest` to use a `signadot` already on
  `PATH` (or, failing that, the latest release). `SIGNADOT_CLI_PATH` overrides both.
- **Self-hosted runners:** the pinned release is downloaded from github.com. A runner
  that cannot reach it needs `cli-version: latest` with its own `signadot` on `PATH`,
  or `SIGNADOT_CLI_PATH`. `install-cli` pins the same release; `version: latest` tracks
  CLI releases instead.
- `pull_request` workflows. Other triggers work, but get no stable name and no
  automatic cleanup. See
  [Pull requests only, for now](https://github.com/signadot/sandbox-action#pull-requests-only-for-now).

### Versioning

While the Action is `0.x` its interface may change between releases, so pin an exact
version (`@v0.1.0`) or a commit. There is deliberately no moving `@v0` or `@v1` tag.

### Usage reporting

Each request the Action makes to the Signadot API carries one header,
`signadot-client-context: integration=sandbox-action,integration-version=0.1.0`. It
tells Signadot which version of the Action is in use and sends nothing else. See
[Usage reporting](https://github.com/signadot/sandbox-action#usage-reporting).

See the [README](https://github.com/signadot/sandbox-action#readme) for the full input
reference, more examples and the lifecycle options.
