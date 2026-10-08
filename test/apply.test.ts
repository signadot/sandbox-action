import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { apply, autoBind, install, parseApplied, type Runtime, remove, templateName, waitArgs } from "../src/apply";
import type { Env } from "../src/context";
import { captureStdout, type FakeResult, fakeExec, withInputs, withInputsAsync } from "./harness";

// The front doors, driven end to end against a fake CLI: which commands they
// run, in what order, with which bytes, and what they make of the answers. The
// spec itself is covered by the fixtures in spec.test.ts.

const cli = { path: "/opt/signadot", version: "v1.2.3" };
const prBuild: Env = {
  GITHUB_ACTIONS: "true",
  GITHUB_REPOSITORY: "acme/route",
  GITHUB_REF: "refs/pull/12/merge",
  GITHUB_SHA: "abc1234def5678901234567890abcdef12345678",
};
const forkInputs = { fork: "kind=Deployment,namespace=hotrod,name=route", cluster: "prod-eks" };
const rendered = "name: route-12\nspec:\n  cluster: prod-eks\n";
const applied = {
  name: "route-12",
  routingKey: "rk123",
  endpoints: [{ name: "frontend", routeType: "host", url: "https://frontend--route-12.preview.signadot.com" }],
};

// Outputs and the job summary reach the runner through files it names in the
// environment. @actions/core reads GITHUB_OUTPUT on every call but settles on
// GITHUB_STEP_SUMMARY once, so the summary file is shared by the whole suite.
let tmp = "";
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "apply-test-"));
  process.env.GITHUB_STEP_SUMMARY = path.join(tmp, "summary.md");
  fs.writeFileSync(process.env.GITHUB_STEP_SUMMARY, "");
});
after(() => {
  delete process.env.GITHUB_STEP_SUMMARY;
  delete process.env.GITHUB_OUTPUT;
  fs.rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  process.env.GITHUB_OUTPUT = path.join(tmp, "output");
  fs.writeFileSync(process.env.GITHUB_OUTPUT, "");
});

// outputs reads back what was set, in the heredoc form @actions/core writes.
function outputs(): Record<string, string> {
  const out: Record<string, string> = {};
  const file = process.env.GITHUB_OUTPUT;
  if (file === undefined) throw new Error("GITHUB_OUTPUT is not set");
  const text = fs.readFileSync(file, "utf8");
  const re = /^(.+?)<<(\S+)\n([\s\S]*?)\n\2$/gm;
  for (let m = re.exec(text); m; m = re.exec(text)) out[m[1]] = m[3];
  return out;
}

// fakeRuntime answers the render with `rendered`, and the apply with `apply`.
// Every -f file is read when the call is made, since what matters is the bytes
// the CLI was given.
function fakeRuntime(env: Env, applyResult: FakeResult, renderResult: FakeResult = { stdout: rendered }) {
  const files: string[] = [];
  const { exec, calls } = fakeExec((args) => {
    const f = args.indexOf("-f");
    if (f >= 0 && fs.existsSync(args[f + 1])) files.push(fs.readFileSync(args[f + 1], "utf8"));
    return args.includes("--dry-run=client") ? renderResult : applyResult;
  });
  const rt: Runtime = {
    env,
    exec,
    ensureCli: async () => cli,
    installCli: async (version) => ({ path: "/installed/signadot", version }),
  };
  return { rt, calls, files };
}

describe("apply", () => {
  it("renders through the CLI, then applies exactly what it rendered", async () => {
    const { rt, calls, files } = fakeRuntime(
      { ...prBuild, SIGNADOT_DASHBOARD_URL: "https://dash.example.com/" },
      { stdout: JSON.stringify(applied) },
    );
    await withInputsAsync({ ...forkInputs, "api-key": "sk-test" }, () => apply(rt));

    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].args.slice(0, 2), ["sandbox", "apply"]);
    assert.deepEqual(calls[0].args.slice(-2), ["--dry-run=client", "--no-template"]);
    assert.match(files[0], /^name: route-12$/m);
    assert.deepEqual(calls[1].args.slice(-3), ["-o", "json", "--wait"]);
    assert.ok(!calls[1].args.some((a) => a.startsWith("--dry-run")));
    assert.equal(files[1], rendered);

    const out = outputs();
    assert.equal(out["rendered-spec"], rendered);
    assert.equal(out["sandbox-name"], "route-12");
    assert.equal(out["routing-key"], "rk123");
    assert.equal(out["preview-url"], applied.endpoints[0].url);
    assert.deepEqual(JSON.parse(out["preview-urls"]), { frontend: applied.endpoints[0].url });
    // The CLI's own override moves the dashboard link too.
    assert.equal(out["dashboard-url"], "https://dash.example.com/sandbox/name/route-12");
  });

  it("does not expand @{...} again once the document is finished", async () => {
    const { rt, calls, files } = fakeRuntime(prBuild, { stdout: JSON.stringify(applied) });
    await withInputsAsync(
      { ...forkInputs, env: "LOGIN_URL=@{/login}", description: "PR title with @{weird} text", "api-key": "sk-test" },
      () => apply(rt),
    );
    // Both passes read a finished document, so neither may template it.
    assert.ok(calls[0].args.includes("--no-template"), calls[0].args.join(" "));
    assert.ok(calls[1].args.includes("--no-template"), calls[1].args.join(" "));
    assert.match(files[0], /@\{\/login\}/);
    assert.match(files[0], /@\{weird\}/);
  });

  it("passes @{var} in a spec input through literally", async () => {
    const { rt, calls, files } = fakeRuntime(prBuild, { code: 99 });
    await withInputsAsync({ spec: "name: x\nspec:\n  cluster: c\n  description: '@{var}'\n", "dry-run": "true" }, () =>
      apply(rt),
    );
    assert.equal(calls.length, 1);
    assert.ok(calls[0].args.includes("--no-template"));
    assert.match(files[0], /description: '@\{var\}'/);
  });

  it("on a dry run, renders and stops without needing a key", async () => {
    const { rt, calls } = fakeRuntime(prBuild, { code: 99 });
    await withInputsAsync({ ...forkInputs, "dry-run": "true" }, () => apply(rt));
    assert.equal(calls.length, 1);
    assert.equal(outputs()["sandbox-name"], "route-12");
  });

  it("asks for the key after the render and before anything is applied", async () => {
    const { rt, calls } = fakeRuntime(prBuild, { code: 99 });
    await assert.rejects(
      withInputsAsync(forkInputs, () => apply(rt)),
      /`api-key` is required/,
    );
    assert.equal(calls.length, 1);
  });

  it("sets the outputs of a sandbox that was applied but did not become ready", async () => {
    const { rt } = fakeRuntime(prBuild, {
      code: 1,
      stdout: JSON.stringify(applied),
      stderr: "Error: timed out waiting for sandbox to be ready\n",
    });
    await assert.rejects(
      withInputsAsync({ ...forkInputs, "api-key": "sk-test" }, () => apply(rt)),
      (e: Error) => {
        assert.match(e.message, /sandbox 'route-12' was applied but did not become ready/);
        assert.match(e.message, /exit code 1: timed out waiting/);
        assert.match(e.message, /app\.signadot\.com\/sandbox\/name\/route-12/);
        return true;
      },
    );
    // A cleanup step that runs on failure needs these most.
    assert.equal(outputs()["sandbox-name"], "route-12");
    assert.equal(outputs()["routing-key"], "rk123");
  });

  it("does not call an apply that printed null a failed apply", async () => {
    // What the CLI prints when every read of the sandbox during the wait failed.
    const { rt } = fakeRuntime(prBuild, { code: 1, stdout: "null\n", stderr: "Error: context deadline exceeded\n" });
    await assert.rejects(
      withInputsAsync({ ...forkInputs, "api-key": "sk-test" }, () => apply(rt)),
      /^Error: sandbox 'route-12' was applied but its readiness could not be determined \(exit code 1: context deadline exceeded\); see https:\/\/app\.signadot\.com\/sandbox\/name\/route-12$/,
    );
    assert.equal(outputs()["sandbox-name"], "route-12");
  });

  it("says why an apply that printed nothing failed", async () => {
    const { rt } = fakeRuntime(prBuild, { code: 1, stderr: "Error: unauthorized\n" });
    await assert.rejects(
      withInputsAsync({ ...forkInputs, "api-key": "sk-test" }, () => apply(rt)),
      /^Error: signadot sandbox apply failed with exit code 1: unauthorized$/,
    );
  });

  it("reports output it cannot parse rather than setting empty outputs", async () => {
    const { rt } = fakeRuntime(prBuild, { stdout: "not json" });
    await assert.rejects(
      withInputsAsync({ ...forkInputs, "api-key": "sk-test" }, () => apply(rt)),
      /could not parse the CLI's JSON output:\nnot json/,
    );
  });

  it("fails on a CLI too old to render, before anything is applied", async () => {
    const { rt, calls } = fakeRuntime(prBuild, { code: 99 }, { code: 1, stderr: "Error: unknown flag: --dry-run\n" });
    await assert.rejects(
      withInputsAsync({ ...forkInputs, "api-key": "sk-test" }, () => apply(rt)),
      /signadot v1\.2\.3 does not support `sandbox apply --dry-run`/,
    );
    assert.equal(calls.length, 1);
  });

  it("does not parse shape inputs a document has made irrelevant", async () => {
    const template = path.join(tmp, "owns-shape.yaml");
    fs.writeFileSync(template, "name: '@{name}'\nspec:\n  cluster: '@{cluster}'\n");
    const { rt } = fakeRuntime(prBuild, { code: 99 }, { stdout: rendered });
    // Each of these fails the step on the inputs route.
    const leftovers = { env: "DEBUG_TOOLBAR-  # a comment", endpoints: "frontend", resources: "- plugn: x" };
    const out = await captureStdout(() =>
      withInputsAsync({ ...leftovers, "template-file": template, cluster: "prod-eks", "dry-run": "true" }, () =>
        apply(rt),
      ),
    );
    assert.match(out, /::warning::ignoring \[env, resources, endpoints\]/);
  });

  it("says which line a template without a cluster or a name is missing", async () => {
    const template = path.join(tmp, "incomplete.yaml");
    fs.writeFileSync(template, "spec: {}\n");
    const cases: [string, RegExp][] = [
      ["Error: sandbox spec must specify cluster\n", /has no cluster\. Add `cluster: '@\{cluster\}'` under `spec:`/],
      [
        "Error: missing name or spec fields\n",
        /needs a top-level `name:` and a `spec:`\. For the name, add `name: '@\{name\}'`/,
      ],
    ];
    for (const [stderr, want] of cases) {
      const { rt } = fakeRuntime(prBuild, { code: 99 }, { code: 1, stderr });
      await assert.rejects(
        withInputsAsync({ "template-file": template, cluster: "prod-eks", "dry-run": "true" }, () => apply(rt)),
        want,
      );
    }
  });

  it("says why @{name} in a template was left unbound", async () => {
    const template = path.join(tmp, "unbound.yaml");
    fs.writeFileSync(template, "name: '@{name}'\nspec:\n  cluster: '@{cluster}'\n");
    const unbound = { code: 1, stderr: "Error: unexpanded variable: name\n" };
    const cases: [Env, RegExp][] = [
      [{}, /nothing bound it: there is no CI context to derive one from\. Set the `name` input/],
      [
        { ...prBuild, GITHUB_REPOSITORY: "acme/___" },
        /nothing bound it: the repository name 'acme\/___' has no letters or digits to derive one from/,
      ],
    ];
    for (const [env, want] of cases) {
      const { rt } = fakeRuntime(env, { code: 99 }, unbound);
      await assert.rejects(
        withInputsAsync({ "template-file": template, cluster: "c", "dry-run": "true" }, () => apply(rt)),
        want,
      );
      const del = fakeRuntime(env, unbound);
      await assert.rejects(
        withInputsAsync({ "api-key": "sk-test", "template-file": template }, () => remove(del.rt)),
        want,
      );
    }
  });

  it("requires a template when it is from-template", async () => {
    const { rt, calls } = fakeRuntime(prBuild, {});
    await assert.rejects(
      withInputsAsync({ ...forkInputs, "dry-run": "true" }, () => apply(rt, { templateRequired: true })),
      /^Error: `template-file` is required/,
    );
    assert.equal(calls.length, 0);
  });

  it("binds name and cluster into a template, leaving a binding the caller made", async () => {
    const template = path.join(tmp, "sandbox.yaml");
    fs.writeFileSync(template, 'name: "@{name}"\nspec:\n  cluster: "@{cluster}"\n');
    const { rt, calls } = fakeRuntime(prBuild, { code: 99 }, { stdout: rendered });
    await withInputsAsync(
      { "template-file": template, set: "name=mine\nteam=payments", cluster: "prod-eks", "dry-run": "true" },
      () => apply(rt),
    );
    // The template is rendered, then the overlaid result is rendered again.
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].args, [
      "sandbox",
      "apply",
      "-f",
      template,
      "--dry-run=client",
      "--set",
      "name=mine",
      "--set",
      "team=payments",
      "--set",
      "cluster=prod-eks",
    ]);
    // Only the template is templated; the overlaid result is a finished document.
    assert.ok(calls[1].args.includes("--no-template"));
  });
});

describe("the API key", () => {
  it("reaches the CLI through its environment, never its argv", async () => {
    const key = "sk-very-secret-key";
    const { rt, calls } = fakeRuntime(prBuild, { stdout: JSON.stringify(applied) });
    await withInputsAsync({ ...forkInputs, "api-key": key, org: "acme" }, () => apply(rt));
    for (const c of calls) {
      assert.ok(!c.args.some((a) => a.includes(key)), c.args.join(" "));
      assert.equal(c.env.SIGNADOT_API_KEY, key);
      assert.equal(c.env.SIGNADOT_ORG, "acme");
    }
  });
});

describe("remove", () => {
  const run = (inputs: Record<string, string>) => {
    const { rt, calls } = fakeRuntime({}, {});
    return withInputsAsync({ "api-key": "sk-test", ...inputs }, () => remove(rt)).then(() => calls);
  };

  it("deletes by name and reports it", async () => {
    const calls = await run({ name: "route-12", force: "true" });
    assert.deepEqual(calls[0].args, ["sandbox", "delete", "route-12", "--force", "--wait"]);
    assert.equal(outputs()["sandbox-name"], "route-12");
  });

  it("warns that set means nothing to a delete by name", async () => {
    const out = await captureStdout(() => run({ name: "route-12", set: "a=1" }));
    assert.match(out, /::warning::ignoring `set`: it binds `template-file`, and this delete is by `name`/);
  });

  it("refuses a name that apply would have refused, rather than rewriting it", async () => {
    await assert.rejects(run({ name: "Hotrod_PR_42" }), /the `name` input 'Hotrod_PR_42' has 'H'/);
  });

  it("deletes by template, passing its bindings", async () => {
    const template = path.join(tmp, "literal.yaml");
    fs.writeFileSync(template, "name: route-preview\nspec:\n  cluster: '@{cluster}'\n");
    const calls = await run({ "template-file": template, set: "a=1", wait: "false" });
    assert.deepEqual(calls[0].args, ["sandbox", "delete", "-f", template, "--set", "a=1", "--wait=false"]);
    assert.equal(outputs()["sandbox-name"], "route-preview");
  });

  it("binds @{name} to the name apply derived, and reports it", async () => {
    const template = path.join(tmp, "derived.yaml");
    fs.writeFileSync(template, "name: '@{name}'\nspec:\n  cluster: '@{cluster}'\n");
    const { rt, calls } = fakeRuntime(prBuild, {});
    await withInputsAsync({ "api-key": "sk-test", "template-file": template }, () => remove(rt));
    assert.deepEqual(calls[0].args, ["sandbox", "delete", "-f", template, "--set", "name=route-12", "--wait"]);
    assert.equal(outputs()["sandbox-name"], "route-12");
  });

  it("leaves a name the caller bound alone, and reports that one", async () => {
    const template = path.join(tmp, "bound.yaml");
    fs.writeFileSync(template, 'name: "@{name}" # bound in set\n');
    const { rt, calls } = fakeRuntime(prBuild, {});
    await withInputsAsync({ "api-key": "sk-test", "template-file": template, set: "name=mine" }, () => remove(rt));
    assert.deepEqual(calls[0].args, ["sandbox", "delete", "-f", template, "--set", "name=mine", "--wait"]);
    assert.equal(outputs()["sandbox-name"], "mine");
  });

  it("reads a name however a template writes it, and refuses what it cannot read", () => {
    const cases: [string, string[], string][] = [
      // The CLI trims spaces inside the braces, so this is still the name.
      ["name: '@{ name }'\n", [], "route-12"],
      ['name: "@{name }"\n', ["name=mine"], "mine"],
      ["name: 'it''s'\n", [], "it's"],
      ['"name": literal\n', [], "literal"],
      // A JSON template: its placeholders are inside strings, so it parses.
      ['{\n  "spec": {"forks": [{"name": "x"}]},\n  "name": "json-name"\n}\n', [], "json-name"],
      ['{"name": "@{name}", "spec": {"cluster": "@{cluster}"}}', [], "route-12"],
      // A block scalar continues below the line, so the line alone is not the name.
      ["name: >-\n  folded\n", [], ""],
      ["name: |\n  literal\n", [], ""],
      ["name: &anchor x\n", [], ""],
    ];
    for (const [template, bindings, want] of cases) {
      assert.equal(templateName(template, bindings, "route-12"), want, template);
    }
  });

  it("does not guess at a name built from several variables", () => {
    assert.equal(templateName("name: '@{team}-@{name}'\n", [], "route-12"), "");
    assert.equal(templateName("spec: {}\n", [], "route-12"), "");
    // Only the top-level name counts, not a fork's.
    assert.equal(templateName("spec:\n  forks:\n  - name: x\nname: top\n", [], ""), "top");
  });

  it("needs exactly one of name and template-file, and a key", async () => {
    await assert.rejects(run({}), /one of `name` or `template-file` is required/);
    await assert.rejects(run({ name: "a", "template-file": "b" }), /mutually exclusive/);
    await assert.rejects(run({ name: "a", "api-key": "" }), /`api-key` is required/);
  });
});

describe("install", () => {
  it("installs the version asked for, whatever is already on PATH", async () => {
    const { rt } = fakeRuntime({}, {});
    // The CLI on PATH is what ensureCli would have returned.
    rt.ensureCli = async () => {
      throw new Error("install-cli must not settle for the CLI on PATH");
    };
    await withInputsAsync({ version: "v1.4.0" }, () => install(rt));
    assert.equal(outputs()["cli-path"], "/installed/signadot");
    assert.equal(outputs().version, "v1.4.0");
  });
});

describe("waitArgs", () => {
  it("waits by default, with the timeout when one is given", () => {
    assert.deepEqual(withInputs({}, waitArgs), ["--wait"]);
    assert.deepEqual(withInputs({ "wait-timeout": "10m" }, waitArgs), ["--wait", "--wait-timeout", "10m"]);
    assert.deepEqual(withInputs({ wait: "false", "wait-timeout": "10m" }, waitArgs), ["--wait=false"]);
    assert.throws(() => withInputs({ wait: "maybe" }, waitArgs), /must be true or false/);
  });
});

describe("autoBind", () => {
  it("binds a value the caller has not, and nothing when there is no value", () => {
    const args: string[] = [];
    autoBind(args, ["team=payments"], "name", "route-12");
    autoBind(args, [], "cluster", "");
    assert.deepEqual(args, ["--set", "name=route-12"]);
  });

  it("leaves a binding the caller made, however it is spaced", () => {
    const args: string[] = [];
    autoBind(args, ["name =mine"], "name", "route-12");
    // A variable whose name merely starts with the same letters is another one.
    autoBind(args, ["namespace=hotrod"], "name", "route-12");
    assert.deepEqual(args, ["--set", "name=route-12"]);
  });
});

describe("parseApplied", () => {
  it("reads the sandbox, and nothing out of empty or garbled output", () => {
    assert.deepEqual(parseApplied(JSON.stringify(applied)), applied);
    assert.equal(parseApplied(""), undefined);
    assert.equal(parseApplied("  \n"), undefined);
    assert.equal(parseApplied('{"name":'), undefined);
  });
});
