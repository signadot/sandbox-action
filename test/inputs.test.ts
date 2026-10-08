import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { defaultName, detect, fitName, noContext } from "../src/context";
import { validate } from "../src/doc";
import { parseForkLine, parseForkList, parseKeyVals } from "../src/inputs";
import { build, envInput, readOptions, resolveImageTemplate } from "../src/spec";
import { fixtureDir, withInputs } from "./harness";

// The grammars that let a workflow express structure in a string, and the rules
// that decide what an input means when it collides with another one. What the
// inputs produce is covered by the fixtures in spec.test.ts.

describe("parseKeyVals", () => {
  it("keeps values verbatim and skips blanks and comments", () => {
    assert.deepEqual(parseKeyVals("A=1\n # comment\n\nB=has=equals\nC=\n  D = spaced \n", "env"), {
      A: "1",
      B: "has=equals",
      C: "",
      // The line is trimmed before the split, so only interior spacing survives.
      D: " spaced",
    });
  });

  it("rejects a line with no =", () => {
    assert.throws(() => parseKeyVals("novalue", "env"), /invalid KEY=VALUE/);
  });
});

describe("parseForkLine", () => {
  it("reads the three identity attributes in any order, and an image", () => {
    assert.deepEqual(parseForkLine("kind=Deployment,namespace=hotrod,name=route"), {
      kind: "Deployment",
      namespace: "hotrod",
      name: "route",
    });
    assert.deepEqual(parseForkLine(" name=route , kind=Rollout, namespace=web, image=acme/route:1 "), {
      kind: "Rollout",
      namespace: "web",
      name: "route",
      image: "acme/route:1",
    });
  });

  it("requires every fork to be fully named: nothing is defaulted", () => {
    assert.throws(() => parseForkLine("name=route"), /missing kind, namespace; every fork names all three/);
    assert.throws(() => parseForkLine("kind=Deployment,name=route"), /missing namespace/);
  });

  it("names the likely mistakes: a bare word, an unknown or repeated attribute", () => {
    // A bare workload name is the old grammar, and also what a missing newline
    // between two forks looks like; the message shows the shape wanted.
    assert.throws(
      () => parseForkLine("route"),
      /'route' is not key=value.*kind=Deployment,namespace=hotrod,name=route/,
    );
    assert.throws(
      () => parseForkLine("kind=Deployment,namespace=hotrod,name=route,imag=x"),
      /unknown attribute 'imag'/,
    );
    assert.throws(
      () => parseForkLine("kind=Deployment,namespace=a,namespace=b,name=route"),
      /'namespace' is given twice/,
    );
    assert.throws(() => parseForkLine("kind=,namespace=a,name=route"), /'kind' has no value/);
  });
});

describe("parseForkList", () => {
  it("takes one fork per line", () => {
    assert.deepEqual(
      parseForkList(
        "kind=Deployment,namespace=hotrod,name=route\n# a comment\nkind=Rollout,namespace=web,name=frontend",
      ),
      [
        { kind: "Deployment", namespace: "hotrod", name: "route" },
        { kind: "Rollout", namespace: "web", name: "frontend" },
      ],
    );
  });

  it("takes a JSON array, for a list a previous step computed", () => {
    // Objects carry the same four attributes; strings are the line grammar, so
    // a jq that emits either shape works.
    assert.deepEqual(
      parseForkList(
        '[{"kind":"Deployment","namespace":"hotrod","name":"route","image":"x:1"},"kind=Rollout,namespace=web,name=frontend"]',
      ),
      [
        { kind: "Deployment", namespace: "hotrod", name: "route", image: "x:1" },
        { kind: "Rollout", namespace: "web", name: "frontend" },
      ],
    );
    assert.throws(() => parseForkList('[{"name":"route"}]'), /fork\[0\]: missing kind, namespace/);
    assert.throws(() => parseForkList('[{"workload":"route"}]'), /fork\[0\]: unknown attribute 'workload'/);
    assert.throws(() => parseForkList("[1]"), /fork\[0\]: must be a \{kind, namespace, name\} object/);
    assert.throws(() => parseForkList("[oops"), /not a valid JSON array/);
  });
});

describe("envInput", () => {
  it("scopes a line to one fork with a workload: prefix", () => {
    assert.deepEqual(
      envInput("LOG_LEVEL=debug\nroute:LOG_LEVEL=trace\nroute:URL=http://x:8080/\nfrontend:TRACING-\nDEBUG-"),
      {
        shared: { LOG_LEVEL: "debug", DEBUG: { delete: true } },
        byWorkload: {
          // The value keeps its own colons: the scope ends at the first '='.
          route: { LOG_LEVEL: "trace", URL: "http://x:8080/" },
          frontend: { TRACING: { delete: true } },
        },
      },
    );
  });

  it("refuses an empty scope and a variable both set and removed in one scope", () => {
    assert.throws(() => envInput(":A=1"), /empty workload before the ':'/);
    assert.throws(() => envInput("route:A=1\nroute:A-"), /`env` for 'route': 'A' is both set and removed/);
    // Set for everyone and removed for one fork is not a conflict: the fork's
    // removal wins for that fork, like any per-fork value.
    assert.deepEqual(envInput("A=1\nroute:A-"), { shared: { A: "1" }, byWorkload: { route: { A: { delete: true } } } });
  });
});

describe("resolveImageTemplate", () => {
  it("names every placeholder it cannot resolve", () => {
    // An unresolved placeholder would otherwise reach the cluster as a literal
    // and fail to pull, long after this job went green.
    assert.throws(
      () => resolveImageTemplate("acme/{workload}:{tag}", { workload: "route" }),
      /unresolvable image placeholder\(s\): tag/,
    );
  });

  it("does not offer {short-sha}, and says what is available instead", () => {
    // Image tags are usually a full sha, so there is no short-sha
    // placeholder; a workflow that wants one computes it in a step.
    assert.throws(
      () => buildFrom({ cluster: "c", fork: route, image: "acme/{workload}:{short-sha}" }),
      /unresolvable image placeholder\(s\): short-sha\. Available: namespace, pr, sha, workload/,
    );
  });
});

const route = "kind=Deployment,namespace=hotrod,name=route";
const frontend = "kind=Rollout,namespace=web,name=frontend";

describe("the fork inputs", () => {
  const base = { cluster: "stage-eks" };

  it("writes each fork exactly as its line says, and applies env to every fork", () => {
    const doc = buildFrom({ ...base, fork: `${route}\n${frontend}`, env: "LOG_LEVEL=debug" });
    assert.deepEqual(
      forksOf(doc).map((f) => f.forkOf),
      [
        { kind: "Deployment", name: "route", namespace: "hotrod" },
        { kind: "Rollout", name: "frontend", namespace: "web" },
      ],
    );
    for (const fork of forksOf(doc)) {
      assert.deepEqual(fork.customizations.env, [{ name: "LOG_LEVEL", value: "debug" }]);
    }
  });

  it("derives every image from one `image` with a per-fork placeholder", () => {
    const doc = buildFrom({ ...base, fork: `${route}\n${frontend}`, image: "ghcr.io/acme/{workload}:{sha}" });
    assert.deepEqual(
      forksOf(doc).map((f) => f.customizations.images?.[0].image),
      [
        "ghcr.io/acme/route:abc1234def5678901234567890abcdef12345678",
        "ghcr.io/acme/frontend:abc1234def5678901234567890abcdef12345678",
      ],
    );
  });

  it("lets a fork line override the shared image, and a lone fork use it plainly", () => {
    const doc = buildFrom({
      ...base,
      fork: `${route}\n${frontend},image=ghcr.io/acme/frontend:pinned`,
      image: "ghcr.io/acme/{workload}:1",
    });
    assert.deepEqual(
      forksOf(doc).map((f) => f.customizations.images?.[0].image),
      ["ghcr.io/acme/route:1", "ghcr.io/acme/frontend:pinned"],
    );
    const one = buildFrom({ ...base, fork: route, image: "ghcr.io/acme/route:1" });
    assert.equal(forksOf(one)[0].customizations.images?.[0].image, "ghcr.io/acme/route:1");
  });

  it("refuses one image for several forks unless it says how they differ", () => {
    // Almost always one fork's image applied to all of them by accident, so say
    // so rather than run the same image everywhere.
    assert.throws(
      () => buildFrom({ ...base, fork: `${route}\n${frontend}`, image: "ghcr.io/acme/route:1" }),
      /would run on 2 forks unchanged: use \{workload\} or \{namespace\} in it, or image= on each fork line/,
    );
    // Once only one fork still relies on it, it is that fork's image.
    const doc = buildFrom({ ...base, fork: `${route}\n${frontend},image=f:1`, image: "ghcr.io/acme/route:1" });
    assert.equal(forksOf(doc)[0].customizations.images?.[0].image, "ghcr.io/acme/route:1");
  });

  it("scopes env to one fork with workload:, and checks the workload is forked", () => {
    const doc = buildFrom({
      ...base,
      fork: `${route}\n${frontend}`,
      env: "LOG_LEVEL=debug\nroute:LOG_LEVEL=trace\nfrontend:FLAG=1",
    });
    const [r, f] = forksOf(doc);
    assert.deepEqual(r.customizations.env, [{ name: "LOG_LEVEL", value: "trace" }]);
    assert.deepEqual(f.customizations.env, [
      { name: "FLAG", value: "1" },
      { name: "LOG_LEVEL", value: "debug" },
    ]);
    assert.throws(
      () => buildFrom({ ...base, fork: route, env: "frontend:FLAG=1" }),
      /'frontend:' names a workload that is not being forked \(forking: route\)/,
    );
  });

  it("requires a cluster and at least one fork", () => {
    assert.throws(() => buildFrom({ fork: route }), /`cluster` is required/);
    assert.throws(() => buildFrom({ ...base }), /at least one workload to fork is required: set `fork`/);
  });

  it("removes a variable with NAME-, and refuses to both set and remove one", () => {
    const doc = buildFrom({ ...base, fork: route, env: "A=1\nB-\n" });
    assert.deepEqual(forksOf(doc)[0].customizations.env, [
      { name: "A", value: "1" },
      { name: "B", operation: "delete" },
    ]);
    assert.throws(() => buildFrom({ ...base, fork: route, env: "A=1\nA-" }), /'A' is both set and removed/);
    assert.throws(() => buildFrom({ ...base, fork: route, env: "novalue" }), /want KEY=VALUE, or NAME-/);
    // A fork's own removal wins over the shared value, key by key, like any
    // other per-fork env.
    const own = buildFrom({ ...base, fork: route, env: "A=1\nroute:A-" });
    assert.deepEqual(forksOf(own)[0].customizations.env, [{ name: "A", operation: "delete" }]);
  });

  it("needs a ttl before it can say what the ttl counts from", () => {
    assert.throws(
      () => buildFrom({ ...base, fork: route, "ttl-offset-from": "updatedAt" }),
      /`ttl-offset-from` needs a `ttl`/,
    );
    assert.throws(
      () => buildFrom({ ...base, fork: route, ttl: "2d", "ttl-offset-from": "lastApply" }),
      /must be one of createdAt, updatedAt/,
    );
  });

  it("rejects a resource reference to a resource nobody declared", () => {
    // It would otherwise fail in the cluster, where the message cannot say this.
    assert.throws(
      () => buildFrom({ ...base, fork: route, env: "DB=${resource:nope.host}" }),
      /names an undeclared resource 'nope'/,
    );
  });

  it("exposes preview URLs from name=URL lines, and needs the URL", () => {
    const doc = buildFrom({
      ...base,
      fork: route,
      endpoints: "frontend=http://frontend.web.svc:8080\napi=http://route.hotrod.svc",
    });
    assert.deepEqual((doc.spec as { defaultRouteGroup: unknown }).defaultRouteGroup, {
      endpoints: [
        { name: "frontend", target: "http://frontend.web.svc:8080" },
        { name: "api", target: "http://route.hotrod.svc" },
      ],
    });
    assert.throws(() => buildFrom({ ...base, fork: route, endpoints: "frontend=" }), /'frontend' has no URL/);
    assert.throws(() => buildFrom({ ...base, fork: route, endpoints: "frontend" }), /`endpoints`: invalid KEY=VALUE/);
  });

  it("reports where a malformed blob went wrong, and refuses a field it does not model", () => {
    assert.throws(() => buildFrom({ ...base, fork: route, resources: "- name: [db\n" }), /not valid YAML/);
    assert.throws(() => buildFrom({ ...base, fork: route, resources: "name: db" }), /must be a list/);
    assert.throws(
      () => buildFrom({ ...base, fork: route, resources: "- name: db\n  plugin: p\n  param: {}" }),
      /resources\[0\]: unknown field 'param'/,
    );
  });

  it("stamps no signadot/ label but the lifecycle pair, and refuses one in the labels input", () => {
    const doc = buildFrom({ ...base, fork: route });
    const own = Object.keys(labelsOf(doc)).filter((k) => k.startsWith("signadot/"));
    assert.deepEqual(own.sort(), ["signadot/github-pull-request", "signadot/github-repo"]);
    // The API allows only the GitHub pair under the reserved prefix. A
    // created-by label was once planned; usage is tracked another way now.
    assert.throws(
      () => validate(buildFrom({ ...base, fork: route, labels: "signadot/created-by=me" })),
      /label 'signadot\/created-by': the signadot\/ prefix is reserved/,
    );
  });
});

describe("action.yml", () => {
  it("carries no expression syntax, which the runner refuses in metadata", () => {
    // A `${{ }}` in an input description looks like documentation and parses as
    // an error: the runner rejects the whole action with "expressions are not
    // allowed here" before any step runs. act reports the same.
    const file = path.join(fixtureDir(), "..", "..", "action.yml");
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), /\$\{\{/);
  });
});

describe("detect", () => {
  it("reads the provider from its own marker variable", () => {
    const c = detect({ GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "Acme-Corp/Hot.Rod" });
    assert.equal(c.provider, "github");
    assert.equal(c.repoSlug, "hot-rod");
    assert.deepEqual(detect({}), noContext());
  });
});

describe("the derived name", () => {
  const pr = (repo: string, n: string) =>
    defaultName(detect({ GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: repo, GITHUB_REF: `refs/pull/${n}/merge` }));

  it("is <repo>-<n> on a pull request and <repo>-<short-sha> on a push", () => {
    assert.equal(pr("acme/hotrod", "42"), "hotrod-42");
    const push = detect({
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: "acme/hotrod",
      GITHUB_SHA: "abc1234def5678901234567890abcdef12345678",
    });
    assert.equal(defaultName(push), "hotrod-abc1234");
  });

  it("shortens the repository, never the number, to fit the API limit", () => {
    const name = pr("acme/application-orchestration-service", "139");
    assert.ok(name.length <= 30, name);
    assert.match(name, /^application-orchest-[0-9a-f]{6}-139$/);
    // The hash is of the repository, so two long repositories that share a
    // prefix stay distinct, and one repository always gets the same name.
    const other = pr("acme/application-orchestration-worker", "139");
    assert.notEqual(name, other);
    assert.equal(name, pr("acme/application-orchestration-service", "139"));
    // A longer number costs the repository, not the number.
    assert.match(fitName("application-orchestration-service", "12345"), /^application-orche-[0-9a-f]{6}-12345$/);
  });
});

interface Fork {
  forkOf: { kind: string; name: string; namespace: string };
  customizations: { env?: unknown[]; images?: { image: string }[] };
}

// A pull request build, so that the name and the built-in labels come from
// somewhere and each test only has to say what it is actually about.
const prBuild = {
  GITHUB_ACTIONS: "true",
  GITHUB_REPOSITORY: "acme/hotrod",
  GITHUB_REF: "refs/pull/1/merge",
  GITHUB_SHA: "abc1234def5678901234567890abcdef12345678",
};

function buildFrom(inputs: Record<string, string>): Record<string, unknown> {
  return withInputs(inputs, () => build(readOptions(), detect(prBuild))) as Record<string, unknown>;
}

function forksOf(doc: Record<string, unknown>): Fork[] {
  return (doc.spec as { forks: Fork[] }).forks;
}

function labelsOf(doc: Record<string, unknown>): Record<string, string> {
  return (doc.spec as { labels: Record<string, string> }).labels;
}
