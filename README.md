# Signadot Sandbox Action

Create an ephemeral [Signadot](https://signadot.com) sandbox — a preview environment
for your Kubernetes microservices — for every pull request, with zero spec authoring
in the common case.

The Action turns your workflow inputs into a complete sandbox spec — deriving the
sandbox name, resolving images, merging env, and stamping the labels the Signadot
GitHub App uses for teardown — and applies it.

**One rule covers most of the interface: one document owns the shape of the sandbox.**
That shape starts as the inputs below and can move into a file you own, whenever you
want it to. When it moves, the inputs that describe the sandbox stop applying and the
Action says so; the inputs that describe how CI behaves keep working untouched. Adopting
a template is not a second mode to learn — it hands over one responsibility.

Three things the rule will not tell you, so they are worth reading once:

`cluster` belongs to the workflow even though a cluster is part of the sandbox. Set the
input and it overrides a document that names one, because which cluster a workflow
targets is the workflow's business.

Identity and lifecycle are the Action's to *supply*, because a file committed to your
repository cannot know which pull request it is being rendered for. Supplying is not
overriding, though. Name a sandbox in your document and that name wins; set either
correlation label and the pair is yours to keep right — but a pair that names a
different pull request fails the step rather than quietly pointing teardown elsewhere.

Shape inputs are not all treated alike when a document is present: `fork` fails the
step, and the other four are ignored with a warning. [Why](#the-shape-of-the-sandbox).

The spec is assembled here and applied by `signadot sandbox apply`, which validates
it against the API's own schema before anything is submitted. So a spec this Action
produces is a spec the CLI accepts, and the document it shows you is the document it
applies, byte for byte.

## Status

`0.1.0`, the first release. The interface may still change between `0.x` releases,
so pin an exact version. Every example here uses `signadot/sandbox-action@v0.1.0`, and
there is deliberately no moving `@v0` or `@v1` tag: while the interface can still
change, moving to a new version should be a change you make, not one that happens to
you.

To pin to a commit rather than a tag — which organisations that require actions to be
SHA-pinned have to do — use the full SHA of the commit the release points at, with the
version as a trailing comment:

```yaml
- uses: signadot/sandbox-action@<full-commit-sha> # v0.1.0
```

The SHA is on the [release page](https://github.com/signadot/sandbox-action/releases/tag/v0.1.0),
or from `gh api repos/signadot/sandbox-action/commits/v0.1.0 --jq .sha`. Dependabot and
Renovate update the SHA and the comment together when a new release is out.

The Action needs `signadot` CLI **v1.9.0 or later**, and by default runs the release
it was tested with, **v1.9.0**: pinning the Action pins the CLI too, so a CLI release <!-- cli-pin -->
cannot change what your workflow does. Which CLI it runs, most explicit first:

| You set | It runs |
|---|---|
| `SIGNADOT_CLI_PATH` (a directory or the binary) | exactly that CLI |
| `cli-version: latest` | a `signadot` already on `PATH`, so a preceding `install-cli` step wins; otherwise the latest release |
| `cli-version: vX.Y.Z` | that release, installed and checksum-verified unless an earlier step already did; a `signadot` on `PATH` is ignored |
| nothing (the default) | the same, for v1.9.0 <!-- cli-pin --> |

Set `cli-version` to take a newer CLI before the next Action release, or `latest` to
track CLI releases as they ship. With `latest`, a self-hosted runner's own `signadot`
is the one that runs, and the Action says so if it is too old. A pinned release is
downloaded from github.com, so a runner that cannot reach it needs `latest` with its
own `signadot` on `PATH`, or `SIGNADOT_CLI_PATH`.

## Quick start

```yaml
- uses: signadot/sandbox-action@v0.1.0
  id: sbx
  with:
    api-key: ${{ secrets.SIGNADOT_API_KEY }}
    org: acme
    cluster: stage-eks
    fork: kind=Deployment,namespace=hotrod,name=route
    image: ghcr.io/acme/route:${{ github.sha }}

- run: |
    curl -H "baggage: sd-routing-key=${{ steps.sbx.outputs.routing-key }}" \
      https://hotrod.internal/dispatch
```

There is no `name` here because the Action derives one from the pull request:
`<repo>-<n>`, so `hotrod-42`. It is stable across pushes, so every push updates the
same sandbox in place and the built-in labels have it deleted when the pull request
closes. A repository
name that is not already a slug, such as `foo.bar`, is hash-tagged so it cannot collide
with `foo-bar`, and one too long for the API's 30-character limit is shortened and
hash-tagged too; the number is always whole at the end. A sandbox name has to start with
a letter, so a repository whose name starts with a digit gets an `r` in front:
`acme/123app` derives `r123app-5`.

**Prefer the derived name.** It is valid for any repository, and it is what the
built-in labels and the `delete` sub-action expect. If you want your own house style,
set `name`, and build it from parts you control rather than from the repository name:

```yaml
    name: pr-${{ github.event.number }}               # pr-42
    name: checkout-pr-${{ github.event.number }}      # a fixed prefix you chose
```

The input is used exactly as written — never slugified or shortened, so a cleanup step
given the same `name` deletes the same sandbox — and the step fails unless it is at
most 30 characters of lowercase letters, digits and `-`, starting with a letter, with
no `--` and no `-` at the end. That rules out interpolating
`${{ github.event.repository.name }}`: a repository called `HotRod`, `my_service` or
anything longer than about 24 characters would fail the step. Uppercase is refused even
though the API takes it: the API folds a name to lowercase when it creates a sandbox,
but a delete looks the name up as given, so `Hotrod-42` would create `hotrod-42` and
then not find it. Requiring lowercase keeps create and delete agreeing.

A fork line always names all three of `kind`, `namespace` and `name`. There is no
default kind and no shared namespace to remember: the line is the whole answer, and
the same three fields the spec itself carries, so a fork in the step reads the same as
a fork in a `signadot sandbox get`.

## Multiple forks without YAML

The `fork` input scales from one to many: one workload per line. When every fork's
image follows one convention, say it once with `image` and a placeholder that varies
per fork; otherwise put `image=` on each line.

```yaml
# uniform image convention — one image, resolved per workload
- uses: signadot/sandbox-action@v0.1.0
  with:
    api-key: ${{ secrets.SIGNADOT_API_KEY }}
    org: acme
    cluster: stage-eks
    image: ghcr.io/acme/{workload}:${{ github.sha }}
    fork: |
      kind=Deployment,namespace=hotrod,name=route
      kind=Deployment,namespace=hotrod,name=frontend
```

```yaml
# per-fork images, still no YAML objects
- uses: signadot/sandbox-action@v0.1.0
  with:
    api-key: ${{ secrets.SIGNADOT_API_KEY }}
    org: acme
    cluster: stage-eks
    fork: |
      kind=Deployment,namespace=hotrod,name=route,image=ghcr.io/acme/route:${{ github.sha }}
      kind=Deployment,namespace=web,name=frontend,image=ghcr.io/acme/frontend:${{ github.sha }}
```

`image` is the image every fork runs. Its placeholders are `{workload}`, `{namespace}`,
`{sha}`, `{branch}` and `{pr}`; with more than one fork it has to use `{workload}` or
`{namespace}`, or every fork would run the same image, and the Action refuses it rather
than guess. `{sha}` is `GITHUB_SHA`, the commit the run checked out. On `pull_request`
that is the test merge commit; on `pull_request_target` it is the latest commit on the
base branch, not the pull request's, so tag images there from
`${{ github.event.pull_request.head.sha }}` in the `image` input instead. An `image=` on a fork line wins over `image` for that fork.

`env` applies to every fork, and a `workload:` prefix scopes a line to one of them,
winning key by key. `NAME-` removes a variable the baseline workload has.

```yaml
    env: |
      LOG_LEVEL=debug
      DEBUG_TOOLBAR-
      route:FEATURE_FLAGS=new-eta
```

Here `LOG_LEVEL` is set on every fork, `DEBUG_TOOLBAR` is removed from every fork, and
`FEATURE_FLAGS` is set on the `route` fork only. A line's value is everything after the
first `=`, including any `#`: inside a `|` block, `# ...` is text, not a YAML comment, so
`LOG_LEVEL=debug  # every fork` sets the value `debug  # every fork`. Only a line that
starts with `#` is skipped.

## Multi-fork with an image convention and a resource

```yaml
- uses: signadot/sandbox-action@v0.1.0
  with:
    api-key: ${{ secrets.SIGNADOT_API_KEY }}
    org: acme
    cluster: stage-eks
    ttl: 2d
    ttl-offset-from: updatedAt      # the clock restarts on every push
    image: ghcr.io/acme/{workload}:${{ github.sha }}
    fork: |
      kind=Deployment,namespace=hotrod,name=customer
      kind=Deployment,namespace=hotrod,name=route
    resources: |
      - name: customerdb
        plugin: hotrod-mariadb
        params: { dbname: customer }
    env: |
      customer:DB_HOST=${resource:customerdb.provision.host}
      customer:DB_PASS=${resource:customerdb.provision.root-password}
    endpoints: |
      frontend=http://frontend.hotrod.svc:8080
```

A `${resource:name.key}` value becomes the spec's `valueFrom.resource`, filled in by
the Signadot Operator once the plugin's create workflow has exported its outputs. The
resource name is everything before the first dot and the output key is everything
after it — output keys are usually prefixed by the step that produced them, as in
`provision.host`, so they carry dots of their own. The reference has to be the whole
value; `$${` is how a value says it means a literal `${`.

`endpoints` are the preview URLs the sandbox exposes, one `name=URL` per line. Targets
are in-cluster addresses, so they can point at workloads this sandbox does not fork.

That is the whole flat surface: five shape inputs — `fork`, `image`, `env`, `endpoints`,
`resources` — none of which is a YAML object except `resources`, which is a list the
API defines. Everything else a spec can say is a document you own, below.

## Monorepo: dynamic fork list

`fork` also takes a JSON array, for a list a previous step computed. Each element is
a `{kind, namespace, name}` object, with an optional `image`.

```yaml
- id: filter
  uses: dorny/paths-filter@v3
  with:
    filters: |
      route: ['services/route/**']
      frontend: ['services/frontend/**']

- id: mkforks
  run: |
    echo "list=$(jq -cn --argjson ch '${{ steps.filter.outputs.changes }}' \
      '[$ch[] | {kind: "Deployment", namespace: "hotrod", name: .}]')" >> "$GITHUB_OUTPUT"

- uses: signadot/sandbox-action@v0.1.0
  if: steps.filter.outputs.changes != '[]'
  with:
    api-key: ${{ secrets.SIGNADOT_API_KEY }}
    org: acme
    cluster: stage-eks
    image: ghcr.io/acme/{workload}:${{ github.sha }}
    fork: ${{ steps.mkforks.outputs.list }}
```

Only changed services get forked; the rest routes to baseline — with zero
repo-side Signadot YAML.

## Bringing your own template

If you already keep a sandbox spec in your repository — or the inputs above stop being
enough — pass it as `template-file`. It is an input on the same action, not a different
one, so nothing else about the step changes:

```yaml
- uses: signadot/sandbox-action@v0.1.0
  with:
    api-key: ${{ secrets.SIGNADOT_API_KEY }}
    cluster: stage-eks                        # unchanged
    template-file: .signadot/sandbox.yaml    # replaces the fork inputs
    set: |
      image=ghcr.io/acme/route:${{ github.sha }}
```

The template is rendered by the CLI, with the same `@{var}` language as
`signadot sandbox apply -f FILE --set var=value`, including `@{embed: file}` and typed
embeds like `@{forks[yaml]}`. Your document owns the shape of the sandbox; the Action
stamps the built-in labels, waits, and produces the same outputs.

**One templating engine per route, and the input names say which.** `template-file`
is a *template*: a file in your repository, with `@{var}` placeholders the CLI binds
from `set`. `spec` is a *spec*: a document already reified when the Action reads it,
so if anything in it varies per run, that is the workflow's `${{ }}` doing the work
before the Action ever sees it. `@{var}` in a `spec` input is not rendered: it reaches
the sandbox as the literal text you wrote. `set` with a `spec` input is ignored with a
warning. A raw spec with no variables is a valid
template, so a file that has never had a placeholder still goes through `template-file`.

### How the Action adds anything to a document it did not write

Not by editing your file, and not by requiring placeholders in it. Rendering and
applying are two separate CLI calls, and the Action works on the document in between:

1. `signadot sandbox apply` renders it with your `set` bindings and prints the
   resulting spec, without applying it. Nothing is applied and no credentials are
   needed.
2. The Action parses that output, sets what belongs to the workflow on the parsed
   document — the built-in labels, `cluster`, `description`, `ttl` — and validates
   the result.
3. That document is what gets applied, byte for byte, and what `rendered-spec` shows.
   It is not rendered again: an `@{` that survives the first render — in a `set` value,
   say, or an embedded file that uses its own `@{...}` syntax — is applied as written.

So a template needs to know nothing about this Action. Given a file that sets its own
name and no labels at all, a pull-request run applies:

```yaml
name: acme-preview
spec:
  cluster: stage-eks
  forks:
  - customizations:
      images:
      - image: ghcr.io/acme/route:abc1234
    forkOf:
      kind: Deployment
      name: route
      namespace: hotrod
  labels:                                    # ← added after rendering
    signadot/github-pull-request: "991"
    signadot/github-repo: acme/checkout
```

Which is what makes teardown on PR close work for a template that predates the Action.

**The name is the exception, and it is worth being precise about.** The Action derives
a name only when nothing else supplies one. A name written in your document wins over
the derived one, because adopting this Action must not silently retarget the sandbox
your workflow has been updating:

| Your template says | Applied name |
|---|---|
| `name: acme-preview` | `acme-preview` — yours, untouched |
| `name: '@{name}'` | `checkout-991` — derived, bound for you |
| anything, plus a `name:` input | the input, which beats both |

Two variables the Action binds for you, because the workflow knows them and a
committed file should not: `@{name}` and `@{cluster}`. Bind either yourself in `set`
and yours is used instead.

**A template has to contain both lines**, or a literal value in their place:

```yaml
name: '@{name}'
spec:
  cluster: '@{cluster}'
```

The CLI will not render a template without a name and a cluster, so the Action never
gets to add them afterwards. Leave either out and the step fails, saying which line to
add.

Labels merge key by key with yours winning, and the `signadot/*` pair is stamped only
if neither key is already present — see [Labels](#labels) for why it is all-or-nothing.

`signadot/sandbox-action/from-template@v0.1.0` is an alias for this, for discoverability.
It takes the same inputs and does the same thing.

### Going the other way

There is no generator from inputs to a template. The flat inputs and a spec share
their vocabulary — a fork line is the three `forkOf` fields, `image` is
`customizations.images`, `env` is `customizations.env`, `endpoints` is
`defaultRouteGroup.endpoints` — so the translation is a transcription, and
`rendered-spec` from a `dry-run: true` step is that transcription done for you.
Commit it, replace the shape inputs with `template-file`, and you are on the other route
with a document that produces the sandbox you already had. Before you commit it, change
its `name:` to `name: '@{name}'` and its `cluster:` to `cluster: '@{cluster}'`, and drop
the `signadot/*` labels: the rendered spec carries this run's values, and every later
run should get its own.

## Sub-actions

| Action | Use it for |
|---|---|
| `signadot/sandbox-action@v0.1.0` | Create or update a sandbox, from inputs or from your own document |
| `signadot/sandbox-action/from-template@v0.1.0` | Alias for the above with `template-file` |
| `signadot/sandbox-action/delete@v0.1.0` | Delete a sandbox explicitly |
| `signadot/sandbox-action/install-cli@v0.1.0` | Put the `signadot` CLI on `PATH` |

### Installing the CLI

The sandbox actions install the CLI themselves when they need it, so this is only for
workflows that want to run `signadot` commands directly. It installs the same pinned
release the sandbox actions run, so a job that uses both ends up with one CLI; set
`version` to install another, or `latest`.

```yaml
- uses: signadot/sandbox-action/install-cli@v0.1.0
- run: signadot smart-test run --sandbox ${{ steps.sbx.outputs.sandbox-name }}
```

## Lifecycle

There is no `delete-on` input. Deletion is three independent mechanisms, and picking
between them is a workflow decision rather than a spec one.

| Layer | What it does | How to use it |
|---|---|---|
| **PR close** | The Signadot GitHub App deletes the sandbox when the pull request closes | Automatic, via the built-in labels. Turn it off with `lifecycle-labels: false` |
| **TTL** | The server deletes the sandbox after a fixed duration | The `ttl` input. Unset by default; a useful backstop for abandoned branches |
| **Explicit** | You delete it at a moment only your workflow knows | The `delete` sub-action, with your own `if:` |

```yaml
- name: Tear down at the end of the job
  if: always()
  uses: signadot/sandbox-action/delete@v0.1.0
  with:
    api-key: ${{ secrets.SIGNADOT_API_KEY }}
    name: ${{ steps.sbx.outputs.sandbox-name }}
```

`sandbox-name` is set before the apply, so that step has a name to delete even when
the apply itself failed or the wait for Ready timed out — the cases where a sandbox
most needs cleaning up.

The `delete` sub-action also takes `template-file`, in which case it reads only the
name — so variables the template uses elsewhere do not have to be bound at cleanup
time. `@{name}` is bound to the name derived from the pull request unless `set` binds
it, so `name: '@{name}'` deletes the sandbox a create step without a `name` input made.
**If the create step set `name`, delete by `name`**, with the same value, or with its
`sandbox-name` output: `delete` does not take `name` together with `template-file`, so
the template route would bind the derived name and delete a different sandbox, or
none. `sandbox-name` is then the template's literal name, or the name bound to
`@{name}`; a name built any other way, such as `'@{team}-@{name}'`, leaves the output
unset, with a warning.

### No GitHub App installed?

The PR-close layer is the [Signadot GitHub App](https://www.signadot.com/docs/guides/integrate-ci/github),
reading the `signadot/github-repo` and `signadot/github-pull-request` labels the
Action stamps. If the App is not installed for your organisation, those labels are
accepted and do nothing: the sandbox is created normally and nothing ever deletes it.
The Action cannot tell you this at the time — there is no API that says whether the
App is installed for a repository — so the failure mode is a sandbox that outlives
its pull request, not an error in the job.

If you are not going to install the App, say so, and pick another layer:

```yaml
with:
  lifecycle-labels: false   # nothing is going to read them
  ttl: 2d                   # the server deletes it instead
```

or keep `ttl` out and use the `delete` sub-action above with your own `if:`. Either
way the decision is written in the workflow, where the next person can see it.

### Pull requests only, for now

This release supports `pull_request` workflows. The name is derived from the pull
request, and so are the two labels the GitHub App reads to delete the sandbox when that
pull request closes. `pull_request_target` carries the number too, and so does
`issue_comment` on a pull request — but there only the number carries over. GitHub runs
a comment workflow against the default branch, so `{sha}` is the default branch's head
rather than the pull request's, and `{branch}` has no value at all: an `image` that uses
either names the wrong image or fails the step. On `issue_comment`, pass the image
explicitly, built from the pull request's own head.

`workflow_run` and `merge_group` runs get no pull request number: the Action does not
read it from their payloads. So they get no stable name and no lifecycle labels, and
behave like the branch push below: a new sandbox every run, and nothing that deletes it.
Set `name` and a `ttl` yourself, or delete the sandbox in the workflow.

Run it on a plain branch push and it will not stop you, but you should know what you
get. The name falls back to `<repo>-<short-sha>`, which changes on every
commit, so each push creates a new sandbox instead of updating one. And with no pull
request number there are no correlation labels, so nothing deletes any of them. If you
do this anyway, set a short `ttl` and treat deletion as your own job. Proper branch
support, with a name that is stable across pushes, is on the roadmap.

## Inputs

Which inputs apply depends on who owns the shape of the sandbox. **Always** means the
input works the same on every route; **ignored** means the Action warns and carries on,
rather than dropping it quietly.

### Always

| Input | Description | Default |
|---|---|---|
| `api-key` | Signadot API key (**required**) | |
| `org` | Signadot org name (required by apply unless set in config/env) | |
| `cluster` | Cluster name in Signadot. Required unless your document sets one, and wins if both do. A template has to say `cluster: '@{cluster}'` or name one literally | |
| `name` | Sandbox name, in your own house style, usually from the workflow's context. Used as written, and refused unless it is at most 30 of `a-z`, `0-9`, `-`, starting with a letter. Prefer the derived name; `pr-${{ github.event.number }}` is valid for any repository. Wins over a name in your document | derived: `<repo>-<n>` |
| `description` | Free-text description shown alongside the sandbox | |
| `ttl` | How long the sandbox lives, e.g. `2d` or `90m` | unset |
| `ttl-offset-from` | What the ttl counts from: `createdAt`, or `updatedAt` to restart the clock on every apply. Only with `ttl` | the API's default, `createdAt` |
| `labels` | Multiline `KEY=VALUE` sandbox labels | |
| `lifecycle-labels` | Stamp the `signadot/github-*` pair the GitHub App reads. A pair naming a different pull request fails the step; `false` says that is deliberate | `true` |
| `wait` | Wait for Ready | `true` |
| `wait-timeout` | How long to wait for Ready | `10m` |
| `dry-run` | Render and validate only; do not apply | `false` |
| `cli-version` | Signadot CLI release to run, e.g. `v1.9.0`, or `latest`. A pinned version always runs; with `latest`, a `signadot` on `PATH` is used if there is one. `SIGNADOT_CLI_PATH` overrides both | `v1.9.0`, the release this version of the Action was tested with <!-- cli-pin --> |

### The shape of the sandbox

These describe the sandbox itself, so they belong to whichever document owns it —
which is why none of them combine with `template-file` or `spec`.

`fork` **fails the step** when a document is also given. It answers exactly the
question a document has already answered, and there is no reading of "fork this, and
also use that template" that most people would agree on.

| Input | Description |
|---|---|
| `fork` | Workloads to fork, one per line, each fully named: `kind=Deployment,namespace=hotrod,name=route`, with an optional `image=` that wins over `image` for that fork. Or a JSON array of `{kind, namespace, name, image?}` objects |

The rest are additions to a fork list, so with no fork list to apply to they are
**ignored with a warning** naming each one — a leftover `env:` should not fail a
workflow that has otherwise moved on.

| Input | Description |
|---|---|
| `image` | The image every fork runs, e.g. `ghcr.io/acme/{workload}:{sha}`. Placeholders: `{workload}`, `{namespace}`, `{sha}` (`GITHUB_SHA`: the base branch's commit on `pull_request_target`), `{branch}`, `{pr}`. With more than one fork it must vary per fork, through `{workload}` or `{namespace}` |
| `env` | Multiline `KEY=VALUE` applied to every fork (the value is everything after the first `=`, `#` included); `workload:KEY=VALUE` applied to that fork only, winning key by key; `NAME-` removes a variable the baseline has; `${resource:name.key}` references a resource output (name before the first dot, key after it) |
| `endpoints` | Multiline `name=URL` preview endpoints. Targets are in-cluster addresses, so these can point at workloads the sandbox does not fork |
| `resources` | YAML/JSON list of `{name, plugin, params}` |

### Your own document

| Input | Description | Route |
|---|---|---|
| `template-file` | Path to a `@{var}` spec template in your repository. It must contain `name: '@{name}'` and `cluster: '@{cluster}'`, or literal values; the Action binds both | template |
| `set` | Multiline `var=value` bindings for the template. Ignored, with a warning, when there is no template | template |
| `spec` | Full inline sandbox spec, for a document the workflow builds itself | spec |

### Precedence, where an input and a document both speak

| Field | Who wins | Why |
|---|---|---|
| `name` | the `name` input, then your document, then the derived name | overriding the name is the only reason to set that input |
| `cluster` | the `cluster` input, then your document | which cluster a workflow targets is the workflow's business, not a committed file's |
| `description`, `ttl` | your document, then the input | a value written into a document was chosen deliberately; the input fills a gap |
| `labels` | merged key by key, your document winning | so the built-in labels can be added without displacing your own |

## Outputs

| Output | Description |
|---|---|
| `sandbox-name` | Created/updated sandbox name. Set before the apply, so a cleanup step running `if: always()` has it even when this step failed |
| `dashboard-url` | The sandbox in the Signadot dashboard |
| `routing-key` | For header-based request routing |
| `preview-urls` | JSON map of endpoint name → URL |
| `preview-url` | Convenience value when there is exactly one endpoint |
| `rendered-spec` | The sandbox spec that was applied |

There is deliberately no `created` output. `sandbox apply` is an upsert that returns
`200` either way, so nothing in the response distinguishes a create from an update.

To target a control plane other than `api.signadot.com` — staging, say — set
`SIGNADOT_API_URL` in the job or step `env:`. The Action passes its environment
through to the CLI, which already reads that variable. It is not an input because
setting it at job level covers every `signadot` invocation in the job, not just this
step, which is what you almost always want.

## Labels

The Action stamps two labels under the reserved `signadot/` prefix, and nothing else:

| Label | Value | When |
|---|---|---|
| `signadot/github-repo` | `owner/repo` | `lifecycle-labels: true` (the default) on a pull request |
| `signadot/github-pull-request` | the PR number | same |

These are the only keys the API accepts under the prefix, so any other `signadot/*`
label in a `labels` input or in your document is refused before anything is submitted.

The `github-*` pair is what the Signadot GitHub App uses to comment on the PR and to
delete the sandbox when it closes. Set `lifecycle-labels: false` only if you want to
opt out of that integration.

The API takes them as a pair and rejects a spec carrying one without the other, so they
are stamped as a set or not at all: a run with no pull request gets neither, and if
either key is already set — by your `labels` input or by your own document — both are
left to you, provided they name this pull request. Completing a half-set pair would
produce a sandbox correlated to your repository and someone else's pull request, which
is worse than leaving it alone.

The API also reserves the whole `signadot/` prefix, accepting no other key under it.
The Action checks that itself, so a bad key is reported by name before anything is
submitted.

### If your document already has labels

Ordinary labels merge, key by key, and **your document always wins** — nothing you
wrote is overwritten or dropped. The `labels` input fills gaps rather than replacing:

```yaml
# in your template          + labels: team=platform, tier=api
labels:                     = labels:
  team: payments                team: payments      # yours
                                tier: api           # from the input
                                signadot/...        # stamped
```

The `signadot/*` pair is the interesting case, because the Action has to decide between
your intent and the run's facts:

| Your document's labels | What happens |
|---|---|
| no `signadot/*` keys | both stamped from the run |
| both keys, naming this pull request | kept; nothing to say |
| both keys, naming a **different** pull request | **error**, before anything is submitted — see below |
| **one** key only | **error**, naming the missing one |
| any other `signadot/*` key | **error**, naming the key and the ones that are allowed |

The mismatch case fails the step rather than warning, because its consequence is
invisible in the job: teardown and PR comments follow the labels, so the sandbox would
be cleaned up when *that* pull request closes rather than yours. Nearly always it is a
copied template. When it is what you mean — a workflow in one repository creating a
sandbox for a pull request in another — say so:

```
Error: your document correlates this sandbox to acme/monorepo#12, but this run is
acme/checkout#991. The Signadot GitHub App would comment on and delete against the
pull request the labels name rather than this one. Remove them to have them derived,
or set `lifecycle-labels: false` if this is deliberate.
```

`lifecycle-labels: false` opts out of the built-in pair entirely, so the Action
neither stamps nor checks yours, and adds no labels at all.

This applies identically whether the labels are literal in your template or bound
through `@{var}` — the check runs on the rendered document, so a variable that resolves
to the wrong repository is caught the same way a hard-coded one is.

## Usage reporting

Every `signadot` command the Action runs tells the Signadot API which integration
made the request, in one request header:

```
signadot-client-context: integration=sandbox-action,integration-version=0.1.0
```

That is all it sends: the name and version of this Action. It adds nothing to your
sandboxes, and it is how Signadot counts which versions of the Action are in use. It needs a
CLI that supports it. With an older CLI, the Action runs the command again without the
header, so reporting can never fail your job; the log then says the run was not counted.

## Escape-hatch ladder

The Action is never a capability ceiling.

| Rung | Input | You own | Still handled for you |
|---|---|---|---|
| 0 | `fork` and the four shape inputs | nothing | everything |
| 1 | `template-file` + `set` | the spec | var binding, identity, labels, validation, apply, wait, outputs |
| 2 | `spec` | the whole document | identity, labels, validation, apply, wait, outputs |
| 3 | `install-cli` | everything | CLI install |

There is nothing between rungs 0 and 1: a step is either flat inputs or a document. What
the flat inputs cannot say, a document says, and the document is validated against the
API's own schema, so anything `signadot sandbox apply` accepts works here — a fork
with its own name, several images in one fork, a Kubernetes patch on the forked
workload, `local:` workloads, `connection:`, fields added to the API since this Action
was last released. `dry-run` and `rendered-spec` are the bridge: run the flat inputs
once and the spec they render is the document to start from.

What does not change with the rung is that the Action still offers identity and
lifecycle. On rungs 1 and 2 it stamps the built-in labels and honours the `name`,
`cluster`, `description` and `ttl` inputs, by overlaying them on your document once it
is rendered instead of asking anything of the document itself. Which side wins varies
by field, and that is the precedence table above. The one to remember is that a name
in your document beats the derived one, so nothing gets retargeted.

No rung invents a TTL. A sandbox outlives the job that created it by design — that
is what makes preview URLs useful — so bounding its life is a decision for the
workflow, not a default. Deletion is the GitHub App's job unless you say otherwise.

## Architecture

The Action builds the spec; the CLI validates and applies it.

```
action.yml, from-template/, delete/, install-cli/   front doors
        │
    dist/*/index.js
        ├── inputs route    src/spec.ts        inputs   → spec
        ├── template route  signadot apply     template → spec, then src/route.ts overlays
        └── spec route      src/route.ts       your document, overlaid
        │
    signadot sandbox apply (render only)        validate, canonicalise → rendered-spec
        │
    signadot sandbox apply -f <that spec>       apply exactly those bytes
```

Validating and applying are two CLI calls rather than one. The first is the schema
check — a strict decode against the API's own models — and its output becomes the
`rendered-spec` output and where a `dry-run` job stops. The second applies exactly
those bytes. What the workflow saw is therefore what was applied, and a spec that
cannot be built or validated fails before a credential is used.

### The default case: no template, and none embedded

The natural guess is that a templateless Action must have a spec template hidden inside
it, filled in from your inputs. It does not. There is no template file in the bundle and
no text substitution anywhere on this path — the only YAML the Action ships is the four
`action.yml` files that declare its inputs to GitHub.

Instead `src/spec.ts` builds the document as data:

1. `readOptions()` reads the `INPUT_*` variables into one typed object, parsing each
   input's grammar — `fork` lines (or a JSON array) into `{kind, namespace, name,
   image?}`, `env` into shared and per-workload `KEY=VALUE` sets, `endpoints` into
   `name=URL` pairs, `resources` as the one YAML blob.
2. `build()` constructs the spec as a tree of plain objects: it resolves the name from
   the CI context, requires a cluster, stamps the labels, then maps each fork through
   `buildFork()`, which resolves `image` (the fork's own `image=` first, then the
   shared input with its placeholders), merges shared and scoped env with the scoped
   winning key by key, and resolves `${resource:name.key}` references against the
   declared resources.
3. `toYAML()` serialises it, and the CLI takes it from there.

So the spec is assembled, never rendered. Nothing is interpolated into a document
skeleton, which is why a fork list of any length is unremarkable — it is a `map` over an
array, not a template trying to express a loop.

**The `@{var}` engine is not involved in this path at all.** It belongs to the CLI, and
it only comes into play when you bring your own `template-file`, which the CLI renders
before the Action overlays identity onto the result. The two routes share no rendering
machinery; they converge at the CLI's render-only apply, and that shared validation seam is what
makes them interchangeable.

The alternative — a built-in template inside the CLI, with the Action passing it
values — is the mechanism this section exists to say is *not* in use.

The Action's own code: input grammars (`src/inputs.ts`), the compile from inputs to a
spec (`src/spec.ts`), CI context and naming (`src/context.ts`), document mechanics and
local validation (`src/doc.ts`), route choice and the identity overlay
(`src/route.ts`), and driving the CLI (`src/cli.ts`, `src/apply.ts`).

`src/spec.ts` and `src/context.ts` began as ports of the CLI's `internal/render`, and
the fixtures in `test/testdata/spec/` began as its golden files. If that logic moves
back into the CLI later — for a CircleCI orb, say, which would otherwise have to
reimplement it — those fixtures are what says the move preserved behaviour.

## Testing

```sh
pnpm install
pnpm test                    # input grammars, the compile, precedence
pnpm run run-local           # whole Action, no Docker, sub-second
pnpm run act                 # whole Action, in a container, via act
pnpm run all                 # typecheck + lint + test + build
```

`test/testdata/spec/` holds the golden fixtures: workflow inputs, a runner
environment, and the spec they have to produce.

**The whole Action, quickly.** `test/local/run-local.mjs` sets up the `INPUT_*`/`GITHUB_*`
environment and a fake pull-request event the way a runner does, then reports the
outputs and step summary. No Docker, so it is fast enough to sit in an edit loop:

```sh
pnpm run run-local                              # dry run with test/local/inputs.json
pnpm run run-local -- --inputs my-inputs.json   # dry run with your own inputs
pnpm run run-local -- --command delete          # exercise the delete sub-action
pnpm run run-local -- --skip-build              # reuse the dist/ already built
SIGNADOT_API_KEY=... pnpm run run-local -- --live
```

It asks for `cli-version: latest` unless your inputs say otherwise, so it runs whichever
`signadot` is on `PATH`: put the build you want to test there, or point
`SIGNADOT_CLI_PATH` at it.

**The whole Action, faithfully.** [`act`](https://github.com/nektos/act) runs a real
workflow file in a container, so `uses: ./`, input defaults and step outputs all
behave as they do on a runner. `test/act/act.sh` builds `dist/` and passes act the flags it
needs; the Action installs the CLI release inside the container. Set
`SIGNADOT_CLI_SRC` to a CLI checkout to try an unreleased CLI change instead: it is
built for the container's platform and used in place of the release.

```sh
brew install act            # needs Docker running
pnpm run act                 # every example in test/act/dry-run.yml
pnpm run act -- -j single-fork
SIGNADOT_CLI_SRC=~/src/cli pnpm run act    # against a CLI built from a checkout
```

The examples live in `test/act/dry-run.yml`, outside `.github/workflows/` so they do
not clutter the Actions tab, with a pull-request payload in `test/act/pull-request.json`.
Each job renders a spec and prints it. To try your own inputs, edit that file or point
the script at another one with `pnpm run act -- -W path/to/workflow.yml`.

Three things the script handles that are easy to trip over: act's checkout honours
`.gitignore`, so a CLI built into `bin/` has to be mounted into the container rather
than copied; it must be built for the container's platform, not the host's; and
`GITHUB_REPOSITORY` defaults to `nektos/act`, which would otherwise show up in the
sandbox name and the labels. `GITHUB_SHA` cannot be pinned: act ignores both `--env
GITHUB_SHA` and the event's `head.sha` and always uses the checkout's HEAD, so a
`{sha}` image tag renders this repository's commit.

**In GitHub**, [`e2e.yml`](.github/workflows/e2e.yml) runs the Action as a consumer
would (`uses: ./`): a dry-run job asserts facts about the rendered document with
`test/e2e/assert-rendered.mjs`, and a manually triggered job creates and deletes a
real sandbox. Both let the Action install the CLI release, as it does for everyone
else. [`ci.yml`](.github/workflows/ci.yml) typechecks,
lints, runs the unit tests and checks `dist/` is in sync with `src/`.

## Development

```sh
pnpm install
pnpm run all
```

`dist/` is committed because GitHub runs the bundled JavaScript directly. Rebuild it
with every change to `src/`; CI refuses a commit whose bundle does not match its
source.

To move the Action to a newer CLI release, change `DEFAULT_CLI` in `src/cli.ts`, the
matching `default:` in `action.yml`, `from-template/action.yml`, `delete/action.yml`
and `install-cli/action.yml`, and the README lines carrying a `cli-pin` HTML comment;
`pnpm test` fails while any of them disagree. The e2e workflow then runs against the new
release, and the change ships with the next Action release.

## Contributing

Bug reports and small, focused pull requests for known issues are welcome; for
anything larger, open an issue first. See [CONTRIBUTING.md](CONTRIBUTING.md). Report security problems to
security@signadot.com, as described in [SECURITY.md](SECURITY.md).

## License

[Apache License 2.0](LICENSE)
