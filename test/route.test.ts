import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detect } from "../src/context";
import { type Doc, validate } from "../src/doc";
import { chooseRoute, overlay } from "../src/route";
import { type Options, readOptions } from "../src/spec";
import { withInputs } from "./harness";

// Whose document is it, and what does the Action add to one it did not write?
// This is the transition from the flat inputs to a template of your own, so the
// precedence here is the part of the interface that has to be predictable.

const prBuild = {
  GITHUB_ACTIONS: "true",
  GITHUB_REPOSITORY: "acme/hotrod",
  GITHUB_REF: "refs/pull/42/merge",
  GITHUB_SHA: "abc1234def5678901234567890abcdef12345678",
};

// The Action stamps no label of its own besides the lifecycle pair.
const created = {};
const correlated = {
  "signadot/github-repo": "acme/hotrod",
  "signadot/github-pull-request": "42",
};

describe("chooseRoute", () => {
  it("takes the route from whichever document the workflow supplied", () => {
    assert.equal(withInputs({ fork: "kind=Deployment,namespace=n,name=route" }, chooseRoute), "inputs");
    assert.equal(withInputs({}, chooseRoute), "inputs");
    assert.equal(withInputs({ "template-file": ".signadot/sandbox.yaml" }, chooseRoute), "template");
    assert.equal(withInputs({ spec: "name: x" }, chooseRoute), "spec");
  });

  it("refuses two answers to the same question", () => {
    assert.throws(() => withInputs({ "template-file": "f", spec: "name: x" }, chooseRoute), /mutually exclusive/);
    // from-template declares template-file required, which the runner does not
    // enforce, so it is checked here rather than falling through to `fork`.
    assert.throws(() => withInputs({}, () => chooseRoute(true)), /^Error: `template-file` is required/);
    assert.equal(
      withInputs({ "template-file": "f" }, () => chooseRoute(true)),
      "template",
    );
    assert.throws(
      () => withInputs({ "template-file": "f", fork: "kind=Deployment,namespace=n,name=route" }, chooseRoute),
      /`fork` says which workloads to fork, but `template-file` already does/,
    );
    assert.throws(
      () => withInputs({ spec: "name: x", fork: "kind=Deployment,namespace=n,name=route" }, chooseRoute),
      /`spec` already does/,
    );
  });
});

describe("overlay", () => {
  it("derives identity and lifecycle for a document that has neither", () => {
    const doc = overlayOn({ spec: { cluster: "from-template" } }, {});
    // `<repo>-<n>`: no owner, no `pr` token.
    assert.equal(doc.name, "hotrod-42");
    assert.deepEqual(spec(doc).labels, { ...created, ...correlated });
    // No implicit TTL: a sandbox outlives the job that made it by design, and
    // choosing an expiry here would quietly delete work someone is reviewing.
    assert.equal(spec(doc).ttl, undefined);
  });

  it("lets the document keep the name it chose, and the name input override it", () => {
    assert.equal(overlayOn({ name: "chosen-by-hand" }, {}).name, "chosen-by-hand");
    assert.equal(overlayOn({ name: "chosen-by-hand" }, { name: "from-workflow" }).name, "from-workflow");
    // Only names we synthesise are normalised, so adopting the Action cannot
    // silently retarget a sandbox that already exists.
    assert.equal(overlayOn({ name: "Mixed/Case" }, {}).name, "Mixed/Case");
    // The input is not rewritten either: it is checked, and refused as written.
    assert.throws(() => overlayOn({}, { name: "Mixed/Case" }), /the `name` input 'Mixed\/Case' has 'M'/);
  });

  it("needs a name from somewhere", () => {
    // Outside CI there is nothing to derive one from, and a sandbox with an
    // invented name could not be found again by the next run.
    const opts = withInputs({}, readOptions);
    assert.throws(
      () => overlay({ spec: { cluster: "c" } }, opts, detect({})),
      /^Error: sandbox name is required, and there is no CI context to derive one from: set the `name` input, or put a name in your document$/,
    );
    // On GitHub, but with a repository name a sandbox name can use none of.
    const empty = detect({ GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "acme/___", GITHUB_REF: "refs/pull/1/merge" });
    assert.throws(
      () => overlay({ spec: { cluster: "c" } }, opts, empty),
      /sandbox name is required, and the repository name 'acme\/___' has no letters or digits to derive one from/,
    );
    assert.equal(overlay({ name: "mine", spec: { cluster: "c" } }, opts, detect({})).name, "mine");
  });

  it("takes the cluster from the workflow and defers on description and ttl", () => {
    const doc = overlayOn(
      { spec: { cluster: "from-template", description: "from template", ttl: { duration: "1h" } } },
      { cluster: "from-workflow", description: "from workflow", ttl: "2d" },
    );
    // Which cluster a workflow targets is the workflow's business; a description
    // and a TTL written into a document were chosen deliberately.
    assert.equal(spec(doc).cluster, "from-workflow");
    assert.equal(spec(doc).description, "from template");
    assert.deepEqual(spec(doc).ttl, { duration: "1h" });
  });

  it("fills in a description and ttl the document left out", () => {
    const doc = overlayOn({ spec: { cluster: "c" } }, { description: "from workflow", ttl: "2d" });
    assert.equal(spec(doc).description, "from workflow");
    assert.deepEqual(spec(doc).ttl, { duration: "2d" });
    // The offset travels with the ttl, and defers with it: a document's own ttl
    // is taken whole rather than having an offset grafted on.
    const offset = overlayOn({ spec: { cluster: "c" } }, { ttl: "2d", "ttl-offset-from": "updatedAt" });
    assert.deepEqual(spec(offset).ttl, { duration: "2d", offsetFrom: "updatedAt" });
    const own = overlayOn(
      { spec: { cluster: "c", ttl: { duration: "1h" } } },
      { ttl: "2d", "ttl-offset-from": "updatedAt" },
    );
    assert.deepEqual(spec(own).ttl, { duration: "1h" });
  });

  it("merges labels key by key, and the document wins on a collision", () => {
    const doc = overlayOn(
      { spec: { cluster: "c", labels: { team: "from-template" } } },
      { labels: "team=from-workflow\ntier=api" },
    );
    assert.deepEqual(spec(doc).labels, {
      team: "from-template",
      tier: "api",
      ...created,
      ...correlated,
    });
  });

  it("adds no labels of its own when opted out, and refuses a reserved key the API refuses", () => {
    const doc = overlayOn({ spec: { cluster: "c" } }, { "lifecycle-labels": "false" });
    assert.deepEqual(spec(doc).labels ?? {}, {});
    assert.throws(
      () => validate(overlayOn({ spec: { cluster: "c", labels: { "signadot/created-by": "me" } } }, {})),
      /label 'signadot\/created-by': the signadot\/ prefix is reserved/,
    );
  });

  it("leaves the correlation labels alone once the document sets either of them", () => {
    // They are a pair the API accepts only whole, so completing a half-set one
    // would produce a pair saying something the author did not.
    const doc = overlayOn({ spec: { cluster: "c", labels: { "signadot/github-repo": "acme/hotrod" } } }, {});
    assert.deepEqual(spec(doc).labels, { "signadot/github-repo": "acme/hotrod", ...created });
  });

  it("fails when a document correlates the sandbox to a different pull request", () => {
    // Teardown follows the labels, so a mismatch would have the GitHub App
    // delete this sandbox when some other pull request closes, and nothing in
    // the job would show it. The message names both sides and the way out.
    assert.throws(
      () =>
        overlayOn(
          {
            spec: {
              cluster: "c",
              labels: {
                "signadot/github-repo": "acme/monorepo",
                "signadot/github-pull-request": "12",
              },
            },
          },
          {},
        ),
      /your document correlates this sandbox to acme\/monorepo#12, but this run is acme\/hotrod#42.*`lifecycle-labels: false`/,
    );
    assert.throws(
      () =>
        overlayOn(
          { spec: { cluster: "c" } },
          { labels: "signadot/github-repo=acme/monorepo\nsignadot/github-pull-request=12" },
        ),
      /the `labels` input correlates this sandbox to acme\/monorepo#12/,
    );
  });

  it("accepts a document that names the pull request being built", () => {
    // Restating what we would have derived is not a mistake.
    const doc = overlayOn({ spec: { cluster: "c", labels: { ...correlated } } }, {});
    assert.deepEqual(spec(doc).labels, { ...created, ...correlated });
  });

  it("lets lifecycle-labels: false say a mismatch is deliberate", () => {
    const doc = overlayOn(
      {
        spec: {
          cluster: "c",
          labels: {
            "signadot/github-repo": "acme/monorepo",
            "signadot/github-pull-request": "12",
          },
        },
      },
      { "lifecycle-labels": "false" },
    );
    assert.deepEqual(spec(doc).labels, {
      "signadot/github-repo": "acme/monorepo",
      "signadot/github-pull-request": "12",
      ...created,
    });
  });

  it("fills in a description and ttl the template left empty", () => {
    // A template line such as `ttl: @{ttl}` bound to nothing renders as null.
    // That is the document leaving the field out, not choosing to have none, so
    // the workflow's value applies rather than being pruned away with the null.
    const doc = overlayOn(
      { spec: { cluster: "c", description: null, ttl: null } },
      { description: "from workflow", ttl: "2d" },
    );
    assert.equal(spec(doc).description, "from workflow");
    assert.deepEqual(spec(doc).ttl, { duration: "2d" });
  });

  it("refuses a document whose fields have the wrong shape, rather than replacing them", () => {
    // Each of these used to be dropped in favour of what the Action derives, so
    // a list under `spec` became a sandbox with no forks, and a numeric name a
    // sandbox under a different one, with nothing in the job to say so.
    const cases: [Doc, RegExp][] = [
      [{ name: "x", spec: [{ cluster: "c" }] }, /your document's spec must be a mapping, got a list/],
      [{ name: "x", spec: "cluster: c" }, /your document's spec must be a mapping, got a string/],
      [
        { name: "x", spec: { cluster: "c", labels: ["team=a"] } },
        /your document's spec\.labels must be a mapping, got a list/,
      ],
      [{ name: 2024, spec: { cluster: "c" } }, /your document's name must be a string, got a number/],
    ];
    for (const [doc, want] of cases) assert.throws(() => overlayOn(doc, {}), want);
  });

  it("treats a null spec, name or labels as absent", () => {
    // What a template renders for a key whose placeholder was bound to nothing.
    assert.deepEqual(overlayOn({ name: null, spec: null }, { cluster: "c" }), {
      name: "hotrod-42",
      spec: { cluster: "c", labels: { ...created, ...correlated } },
    });
    const doc = overlayOn({ spec: { cluster: "c", labels: null } }, {});
    assert.deepEqual(spec(doc).labels, { ...created, ...correlated });
  });

  it("treats a null label as absent", () => {
    // A template line such as `signadot/github-pull-request: @{pr}` bound to
    // nothing renders as null. It used to count as the document stating the
    // label, so the pair was neither derived nor accepted: the step failed
    // saying the sandbox was correlated to "null#null".
    const doc = overlayOn(
      {
        spec: {
          cluster: "c",
          labels: { team: null, "signadot/github-repo": null, "signadot/github-pull-request": null },
        },
      },
      {},
    );
    assert.deepEqual(spec(doc).labels, { ...created, ...correlated });
    const unclaimed = overlayOn({ spec: { cluster: "c", labels: { team: null } } }, {});
    assert.deepEqual(spec(unclaimed).labels, { ...created, ...correlated });
  });

  it("drops the nulls a template leaves behind", () => {
    const doc = overlayOn({ spec: { cluster: "c", local: null } }, {});
    assert.equal("local" in spec(doc), false);
  });
});

function overlayOn(doc: Doc, inputs: Record<string, string>): Doc {
  const opts: Options = withInputs(inputs, readOptions);
  return overlay(doc, opts, detect(prBuild));
}

function spec(doc: Doc): Record<string, unknown> {
  return doc.spec as Record<string, unknown>;
}
