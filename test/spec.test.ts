import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as yaml from "js-yaml";
import { detect } from "../src/context";
import type { Doc } from "../src/doc";
import { build, type EnvInput, envInput, readOptions, resolveImageTemplate, stampLabels } from "../src/spec";
import { fixtureDir, withInputs } from "./harness";

// The Action compiles inputs into a sandbox spec, so these fixtures are the
// Action's contract. Most of them are the CLI's own golden files, unchanged: the
// same case expressed as workflow inputs has to produce the same spec, and
// comparing against the bytes the Go produced is what says so.

const dir = fixtureDir("spec");

describe("build", () => {
  for (const name of fs.readdirSync(dir).sort()) {
    it(name, () => {
      const at = path.join(dir, name);
      const inputs = readJSON(path.join(at, "inputs.json"));
      const env = fs.existsSync(path.join(at, "env.json")) ? readJSON(path.join(at, "env.json")) : {};
      const expected = yaml.load(fs.readFileSync(path.join(at, "expected.yaml"), "utf8"));

      const got = withInputs(inputs, () => build(readOptions(), detect(env)));
      assert.deepEqual(got, expected);
    });
  }
});

describe("resolveImageTemplate", () => {
  const placeholders = { workload: "route", namespace: "hotrod", sha: "abc", pr: "", branch: "main" };

  it("fills in every placeholder it knows, as often as it appears", () => {
    const cases: [string, string][] = [
      ["acme/route:1", "acme/route:1"],
      ["acme/{workload}:{sha}", "acme/route:abc"],
      ["acme/{namespace}-{workload}:{branch}", "acme/hotrod-route:main"],
      ["acme/{workload}/{workload}:{sha}", "acme/route/route:abc"],
      // Only {name} with a leading letter is a placeholder; anything else in
      // braces is left for the registry to accept or not.
      ["acme/route:{1}", "acme/route:{1}"],
    ];
    for (const [tpl, want] of cases) assert.equal(resolveImageTemplate(tpl, placeholders), want, tpl);
  });

  it("treats a placeholder with no value in this run as unresolvable", () => {
    // {pr} on a push has nothing to say, and an image tagged with an empty
    // string is not one anybody built.
    assert.throws(
      () => resolveImageTemplate("acme/route:{pr}", placeholders, "route"),
      /^Error: fork 'route': unresolvable image placeholder\(s\): pr \(no value in this run\)\. Available: branch, namespace, sha, workload$/,
    );
  });

  it("does not resolve a placeholder from what every object inherits", () => {
    // {constructor} would otherwise resolve to the source of Object itself.
    for (const key of ["constructor", "toString", "hasOwnProperty"]) {
      assert.throws(
        () => resolveImageTemplate(`acme/route:{${key}}`, placeholders),
        new RegExp(`unresolvable image placeholder\\(s\\): ${key}\\.`),
      );
    }
  });
});

describe("the resources input", () => {
  const base = { name: "x", cluster: "c", fork: "kind=Deployment,namespace=hotrod,name=route" };
  const resourcesOf = (resources: string): unknown =>
    (withInputs({ ...base, resources }, () => build(readOptions(), detect({}))).spec as Doc).resources;

  it("passes a resource through as declared, and drops empty params", () => {
    assert.deepEqual(resourcesOf("- name: db\n  plugin: mariadb\n  params:\n    dbname: customer"), [
      { name: "db", plugin: "mariadb", params: { dbname: "customer" } },
    ]);
    assert.deepEqual(resourcesOf("- name: db\n  plugin: mariadb\n  params: {}"), [{ name: "db", plugin: "mariadb" }]);
    assert.deepEqual(resourcesOf("- name: db\n  plugin: mariadb\n  params:"), [{ name: "db", plugin: "mariadb" }]);
  });

  it("refuses an entry whose fields have the wrong shape", () => {
    // params written as a string used to be spread character by character into
    // {"0": "c", "1": "u", ...}, which the CLI then accepted.
    const cases: [string, RegExp][] = [
      ["- plugin: mariadb", /^Error: resources\[0\]: name is required$/],
      ["- name: db", /^Error: resource 'db': plugin is required$/],
      ["- name: [db]\n  plugin: mariadb", /^Error: resources\[0\]: name must be a string, got a list$/],
      ["- name: db\n  plugin: 7", /^Error: resource 'db': plugin must be a string, got a number$/],
      [
        "- name: db\n  plugin: mariadb\n  params: customer",
        /^Error: resource 'db': params must be a mapping, got a string$/,
      ],
      [
        "- name: db\n  plugin: mariadb\n  params: [customer]",
        /^Error: resource 'db': params must be a mapping, got a list$/,
      ],
    ];
    for (const [resources, want] of cases) assert.throws(() => resourcesOf(resources), want, resources);
  });
});

describe("envInput", () => {
  const del = { delete: true } as const;

  it("reads each line into its scope", () => {
    const cases: [string, EnvInput][] = [
      ["", { shared: {}, byWorkload: {} }],
      ["# a comment\n\nA=1", { shared: { A: "1" }, byWorkload: {} }],
      // The last value for a key wins, within one scope.
      ["A=1\nA=2", { shared: { A: "2" }, byWorkload: {} }],
      ["route:A=1\nroute:A=2", { shared: {}, byWorkload: { route: { A: "2" } } }],
      // Everything after the first '=' is the value, colons and all.
      ["B=x=y\nroute:URL=http://a:1", { shared: { B: "x=y" }, byWorkload: { route: { URL: "http://a:1" } } }],
      // Space around the scope and the name goes; the value keeps its own.
      [" route : A = x ", { shared: {}, byWorkload: { route: { A: " x" } } }],
      ["X- \nroute: B -", { shared: { X: del }, byWorkload: { route: { B: del } } }],
      // Removing twice says the same thing twice.
      ["A-\nA-", { shared: { A: del }, byWorkload: {} }],
      // Only the first ':' before the '=' is the scope.
      ["a:b:C=1", { shared: {}, byWorkload: { a: { "b:C": "1" } } }],
      // A reference is kept as written until a fork compiles it.
      ["route:DB=${resource:db.host}", { shared: {}, byWorkload: { route: { DB: "${resource:db.host}" } } }],
      // Names are only names: neither of these may reach an object's prototype.
      ["__proto__=1", { shared: Object.fromEntries([["__proto__", "1"]]), byWorkload: {} }],
      ["__proto__:A=1", { shared: {}, byWorkload: Object.fromEntries([["__proto__", { A: "1" }]]) }],
    ];
    for (const [s, want] of cases) assert.deepEqual(envInput(s), want, JSON.stringify(s));
  });

  it("refuses a line it cannot place", () => {
    const cases: [string, RegExp][] = [
      ["A", /^Error: `env`: want KEY=VALUE, or NAME- to remove a variable, optionally prefixed workload:, got 'A'$/],
      ["-", /^Error: `env`: a bare '-' names no variable$/],
      ["route:-", /^Error: `env`: a bare '-' names no variable$/],
      [" :A=1", /^Error: `env`: ':A=1' has an empty workload before the ':'$/],
      // A conflict is a conflict whichever line comes first.
      ["A-\nA=1", /^Error: `env`: 'A' is both set and removed$/],
      ["route:A=1\nroute:A-", /^Error: `env` for 'route': 'A' is both set and removed$/],
    ];
    for (const [s, want] of cases) assert.throws(() => envInput(s), want, JSON.stringify(s));
  });
});

describe("stampLabels", () => {
  const repo = "signadot/github-repo";
  const pr = "signadot/github-pull-request";
  // Nothing but the lifecycle pair is stamped.
  const created = {};
  const pair = { [repo]: "acme/hotrod", [pr]: "42" };
  const prBuild = detect({
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "acme/hotrod",
    GITHUB_REF: "refs/pull/42/merge",
  });
  const pushBuild = detect({ GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "acme/hotrod", GITHUB_SHA: "abc1234" });

  it("adds the lifecycle pair only whole", () => {
    const cases: [string, Record<string, string>, boolean, ReturnType<typeof detect>, Doc, Record<string, string>][] = [
      ["a pull request", { team: "a" }, true, prBuild, {}, { team: "a", ...created, ...pair }],
      ["opted out", { team: "a" }, false, prBuild, {}, { team: "a", ...created }],
      // With no pull request there is nothing to correlate to.
      ["a push", {}, true, pushBuild, {}, created],
      ["no CI", {}, true, detect({}), {}, created],
      // Restating the pair is not a mistake.
      ["the pair restated in the inputs", pair, true, prBuild, {}, { ...pair, ...created }],
      // The document's own labels are merged over these by the caller, so the
      // pair is not repeated here; a YAML number for the pull request is the
      // same pull request.
      ["the pair restated in the document", {}, true, prBuild, { [repo]: "acme/hotrod", [pr]: 42 }, created],
      // Half a pair is left as half: completing it would say something the
      // caller did not, and validate refuses it with a message about the pair.
      [
        "half the pair in the inputs",
        { [repo]: "acme/hotrod" },
        true,
        prBuild,
        {},
        { [repo]: "acme/hotrod", ...created },
      ],
      ["half the pair in the document", {}, true, prBuild, { [pr]: "42" }, created],
    ];
    for (const [what, labels, lifecycleLabels, ctx, claimed, want] of cases) {
      assert.deepEqual(stampLabels({ labels, lifecycleLabels }, ctx, claimed), want, what);
    }
  });

  it("refuses labels that correlate the sandbox to another pull request", () => {
    const cases: [Record<string, string>, Doc, RegExp][] = [
      [
        { [repo]: "acme/other", [pr]: "7" },
        {},
        /^Error: the `labels` input correlates this sandbox to acme\/other#7, but this run is acme\/hotrod#42\./,
      ],
      [{}, { [repo]: "acme/other", [pr]: "7" }, /^Error: your document correlates this sandbox to acme\/other#7,/],
      // The document is named whenever it states either key, and the half nobody
      // stated shows as '?'.
      [{ [repo]: "acme/hotrod" }, { [pr]: "7" }, /^Error: your document correlates this sandbox to acme\/hotrod#7,/],
      [{ [pr]: "7" }, {}, /^Error: the `labels` input correlates this sandbox to \?#7,/],
    ];
    for (const [labels, claimed, want] of cases) {
      assert.throws(
        () => stampLabels({ labels, lifecycleLabels: true }, prBuild, claimed),
        want,
        JSON.stringify({ labels, claimed }),
      );
      // Opting out is how a workflow says it means it.
      assert.deepEqual(stampLabels({ labels, lifecycleLabels: false }, prBuild, claimed), { ...labels, ...created });
    }
  });
});

describe("resource references in env", () => {
  const base = {
    name: "x",
    cluster: "c",
    fork: "kind=Deployment,namespace=hotrod,name=route",
    resources: "- name: db\n  plugin: mariadb",
  };
  const envOf = (env: string): unknown =>
    (
      (withInputs({ ...base, env }, () => build(readOptions(), detect({}))).spec as { forks: Doc[] }).forks[0]
        .customizations as Doc
    ).env;

  it("compiles a whole-value reference, and leaves anything else a literal", () => {
    const cases: [string, unknown][] = [
      ["DB=${resource:db.host}", [{ name: "DB", valueFrom: { resource: { name: "db", outputKey: "host" } } }]],
      // Everything after the first '.' is the output key.
      ["DB=${resource:db.a.b}", [{ name: "DB", valueFrom: { resource: { name: "db", outputKey: "a.b" } } }]],
      // Only a reference that is the whole value is one; the API has no way to
      // splice an output into a longer string.
      ["URL=http://${resource:db.host}", [{ name: "URL", value: "http://${resource:db.host}" }]],
      ["LIT=$${resource:db.host}", [{ name: "LIT", value: "${resource:db.host}" }]],
      ["EMPTY=", [{ name: "EMPTY" }]],
    ];
    for (const [env, want] of cases) assert.deepEqual(envOf(env), want, env);
  });

  it("refuses a reference it cannot resolve, naming the fork and the variable", () => {
    const cases: [string, RegExp][] = [
      ["DB=${resource:db}", /^Error: fork 'route': env 'DB': resource reference 'db' must be of the form name\.key$/],
      ["DB=${resource:.host}", /resource reference '\.host' must be of the form name\.key$/],
      ["DB=${resource:db.}", /resource reference 'db\.' must be of the form name\.key$/],
      [
        "DB=${resource:cache.url}",
        /^Error: fork 'route': env 'DB': resource reference 'cache\.url' names an undeclared resource 'cache'$/,
      ],
    ];
    for (const [env, want] of cases) assert.throws(() => envOf(env), want, env);
  });
});

function readJSON(file: string): Record<string, string> {
  const doc = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, string>;
  delete doc._comment;
  return doc;
}
