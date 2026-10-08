import * as fs from "node:fs";
import * as core from "@actions/core";
import {
  type Auth,
  type CLI,
  defaultRunner,
  ensureCli,
  exitReason,
  failure,
  installCli,
  type Runner,
  run,
  tempFile,
  tryRun,
} from "./cli";
import { type CIContext, checkNameInput, detect, type Env, noDerivedName, suppliedName } from "./context";
import { type Doc, isDoc, parseDoc, toYAML, validate } from "./doc";
import { boolInput, input, lines } from "./inputs";
import { chooseRoute, overlay, type Route } from "./route";
import { build, type Options, readOptions } from "./spec";
import { warnIgnored } from "./warn";

// The Action builds the spec, the CLI validates and applies it. Rendering happens
// in two steps the way `kubectl` users expect: produce the spec, publish it as an
// output, then apply the very file that was published. A spec that cannot be built
// or validated fails before any credential is used.

interface AppliedSandbox {
  name?: string;
  routingKey?: string;
  endpoints?: { name?: string; routeType?: string; url?: string }[];
}

// Runtime is everything the front doors take from outside the process besides
// their inputs: the environment, a way to run the CLI, and a way to get one. The
// entry points use the real ones; tests pass their own.
export interface Runtime extends Runner {
  ensureCli: (version: string) => Promise<CLI>;
  installCli: (version: string) => Promise<CLI>;
}

export function defaultRuntime(): Runtime {
  const runner = defaultRunner();
  return { ...runner, ensureCli: (version) => ensureCli(version, runner.env), installCli };
}

// apply is the root action and, with templateRequired, from-template: the same
// work, except that from-template will not run without a template.
export async function apply(rt: Runtime = defaultRuntime(), { templateRequired = false } = {}): Promise<void> {
  const auth = readAuth();
  const route = chooseRoute(templateRequired);
  warnIgnored(route);

  const ctx = detect(rt.env);
  const opts = readOptions(route);
  const cli = await rt.ensureCli(input("cli-version"));

  const doc =
    route === "inputs" ? build(opts, ctx) : overlay(await ownDocument(route, cli, auth, opts, ctx, rt), opts, ctx);

  validate(doc);
  // validate() has just checked the name is a string.
  const name = doc.name as string;

  // Round-trip through the CLI so that what gets published is what the CLI itself
  // makes of the document — its strict decode is the check that the spec is one
  // the API will accept, and its output is the canonical form. The document is
  // finished by now, so --no-template keeps the CLI from expanding @{...} in it a
  // second time: a value that merely contains one, such as an embedded Spring
  // property or a PR title, is a value, and the bindings are long gone.
  const rendered = await run(
    cli,
    auth,
    ["sandbox", "apply", "-f", tempFile("sandbox.yaml", toYAML(doc)), "--dry-run=client", "--no-template"],
    rt,
  );
  core.setOutput("rendered-spec", rendered);
  // The name is known before anything is applied, so a later `if: always()`
  // step can find the sandbox whatever happens from here.
  core.setOutput("sandbox-name", name);

  if (boolInput("dry-run", false)) {
    core.info("dry-run: the spec was built and validated, and not applied");
    await core.summary.addHeading("Signadot sandbox (dry run)", 2).addCodeBlock(rendered, "yaml").write();
    return;
  }

  requireAuth(auth);
  core.setOutput("dashboard-url", dashboardURL(name, rt.env));

  // The CLI prints the sandbox it applied even when the wait for readiness then
  // fails, so the outputs are set from that before the failure is reported: a
  // cleanup step that runs on failure needs them most.
  const r = await tryRun(
    cli,
    auth,
    ["sandbox", "apply", "-f", tempFile("applied.yaml", rendered), "--no-template", "-o", "json", ...waitArgs()],
    rt,
  );
  const sb = parseApplied(r.stdout);
  if (sb) await report(sb, rt.env);
  if (r.code !== 0) {
    if (sb) {
      throw new Error(
        `sandbox '${sb.name ?? name}' was applied but did not become ready (${exitReason(r)}); ` +
          `see ${dashboardURL(name, rt.env)}`,
      );
    }
    // The CLI prints `null` when the apply succeeded but every attempt to read
    // the sandbox back during the wait failed. That is not an apply that failed,
    // and saying it was would send the reader looking in the wrong place.
    if (r.stdout.trim() === "null") {
      throw new Error(
        `sandbox '${name}' was applied but its readiness could not be determined (${exitReason(r)}); ` +
          `see ${dashboardURL(name, rt.env)}`,
      );
    }
    throw new Error(`signadot sandbox apply failed with ${exitReason(r)}`);
  }
  if (!sb) throw new Error(`could not parse the CLI's JSON output:\n${r.stdout}`);
}

export function parseApplied(out: string): AppliedSandbox | undefined {
  if (out.trim() === "") return undefined;
  try {
    return JSON.parse(out) as AppliedSandbox;
  } catch {
    return undefined;
  }
}

// dashboardURL is where the sandbox is in the Signadot dashboard, built the way
// the CLI builds it. SIGNADOT_DASHBOARD_URL is the CLI's own override, so a job
// pointed at another control plane sets one variable for both.
function dashboardURL(name: string, env: Env): string {
  const base = (env.SIGNADOT_DASHBOARD_URL ?? "https://app.signadot.com").replace(/\/+$/, "");
  return `${base}/sandbox/name/${encodeURIComponent(name)}`;
}

// ownDocument reads the caller's own document. A template goes to the CLI, which
// binds its @{var} placeholders exactly as it does outside CI.
async function ownDocument(
  route: Route,
  cli: CLI,
  auth: Auth,
  opts: Options,
  ctx: CIContext,
  runner: Runner,
): Promise<Doc> {
  if (route === "spec") return parseDoc(input("spec"), "the `spec` input");

  const file = input("template-file");
  if (!fs.existsSync(file)) {
    throw new Error(`template-file '${file}' does not exist (relative to ${process.cwd()})`);
  }
  const args = ["sandbox", "apply", "-f", file, "--dry-run=client"];
  const bindings = lines(input("set"));
  for (const s of bindings) args.push("--set", s);

  // Two variables the Action can fill in, because they are the two the workflow
  // knows and a committed file does not.
  autoBind(args, bindings, "name", suppliedName(opts.name, ctx));
  autoBind(args, bindings, "cluster", opts.cluster);

  const r = await tryRun(cli, auth, args, runner);
  if (r.code !== 0) throw incompleteTemplate(file, r.stderr, ctx) ?? failure(cli, args, r);
  return parseDoc(r.stdout, `the rendered template '${file}'`);
}

// unboundName explains a template whose @{name} the CLI found nothing bound to.
// The Action binds it whenever it has a name, so an unbound one means it had
// none, and why is the useful part.
function unboundName(file: string, stderr: string, ctx: CIContext): Error | undefined {
  if (!/unexpanded variable: name(?![\w-])/.test(stderr)) return undefined;
  return new Error(
    `template-file '${file}' uses @{name}, and nothing bound it: ${noDerivedName(ctx)}. ` +
      "Set the `name` input, or bind `name=` in `set`",
  );
}

// incompleteTemplate explains the two checks the CLI makes on a template before
// it will render one. The Action would supply the name and the cluster afterwards,
// but never gets the chance, so the template has to carry both; the fix is a
// line in it, and the message says which.
export function incompleteTemplate(file: string, stderr: string, ctx: CIContext): Error | undefined {
  const unbound = unboundName(file, stderr, ctx);
  if (unbound) return unbound;
  if (stderr.includes("sandbox spec must specify cluster")) {
    return new Error(
      `template-file '${file}' has no cluster. Add \`cluster: '@{cluster}'\` under \`spec:\`, and the ` +
        "Action binds it from the `cluster` input; or write the cluster there literally",
    );
  }
  if (stderr.includes("missing name or spec fields")) {
    return new Error(
      `template-file '${file}' needs a top-level \`name:\` and a \`spec:\`. For the name, add ` +
        "`name: '@{name}'`, and the Action binds the derived name or the `name` input; or write a name literally",
    );
  }
  return undefined;
}

// autoBind supplies a binding on the caller's behalf. A template that does not
// ask for the variable ignores it, but one the caller has already bound must be
// left alone: the CLI reads a second binding as a conflict, not an override.
export function autoBind(args: string[], bindings: string[], name: string, value: string): void {
  if (value === "") return;
  if (bindings.some((b) => new RegExp(`^${name}\\s*=`).test(b))) return;
  args.push("--set", `${name}=${value}`);
}

export async function remove(rt: Runtime = defaultRuntime()): Promise<void> {
  const auth = readAuth();
  requireAuth(auth);
  const cli = await rt.ensureCli(input("cli-version"));

  const name = input("name");
  const template = input("template-file");
  if (name !== "" && template !== "") {
    throw new Error("`name` and `template-file` are mutually exclusive");
  }

  const args = ["sandbox", "delete"];
  let deleted = "";
  let ctx: CIContext | undefined;
  if (name !== "") {
    // Checked exactly as apply checks it, so both see the same name.
    deleted = checkNameInput(name);
    args.push(deleted);
    // set binds a template, and a delete by name has none. Saying so is cheaper
    // than the afternoon spent wondering why a binding had no effect.
    if (input("set") !== "") core.warning("ignoring `set`: it binds `template-file`, and this delete is by `name`");
  } else if (template !== "") {
    if (!fs.existsSync(template)) {
      throw new Error(`template-file '${template}' does not exist (relative to ${process.cwd()})`);
    }
    // The CLI reads only the name from a spec passed to delete, so variables the
    // template uses elsewhere need not be bound at cleanup time. The name itself
    // is bound as apply binds it, so `name: '@{name}'` resolves to the sandbox
    // that apply created.
    args.push("-f", template);
    const bindings = lines(input("set"));
    for (const s of bindings) args.push("--set", s);
    ctx = detect(rt.env);
    const derived = suppliedName("", ctx);
    autoBind(args, bindings, "name", derived);
    deleted = templateName(fs.readFileSync(template, "utf8"), bindings, derived);
  } else {
    throw new Error("one of `name` or `template-file` is required");
  }
  if (boolInput("force", false)) args.push("--force");
  args.push(...waitArgs());

  const r = await tryRun(cli, auth, args, rt);
  if (r.code !== 0) throw (ctx && unboundName(template, r.stderr, ctx)) ?? failure(cli, args, r);
  if (deleted !== "") core.setOutput("sandbox-name", deleted);
}

// templateName works out which sandbox a delete by template removed, for the
// `sandbox-name` output. The CLI does not say, and a YAML template cannot simply
// be parsed: an unquoted @{...} elsewhere in it is not valid YAML. So its
// top-level `name:` line is read on its own; a JSON template, whose placeholders
// sit inside strings, is parsed. A literal is the name; `@{name}`, with or
// without spaces inside the braces as the CLI allows, is whatever was bound to
// it; anything else — a name built from several variables, or one this line
// cannot hold, like a `|` or `>` block scalar — is left to the CLI, and the
// output unset with a warning saying why.
export function templateName(template: string, bindings: string[], derived: string): string {
  const raw = templateNameValue(template);
  if (raw !== undefined && raw !== "" && !raw.includes("@{")) return raw;
  if (raw !== undefined && /^@\{\s*name\s*\}$/.test(raw)) {
    const bound = bindings.find((b) => /^name\s*=/.test(b));
    const value = bound === undefined ? derived : bound.slice(bound.indexOf("=") + 1);
    if (value !== "") return value;
  }
  core.warning(
    "`sandbox-name` is not set: the template's name is neither a literal on its own line nor exactly " +
      "'@{name}', so the Action cannot tell which sandbox the CLI deleted",
  );
  return "";
}

// templateNameValue is the template's top-level name as written, unquoted, or
// undefined when it is not one this can read.
function templateNameValue(template: string): string | undefined {
  if (template.trimStart().startsWith("{")) {
    try {
      const doc = JSON.parse(template) as unknown;
      return isDoc(doc) && typeof doc.name === "string" ? doc.name : undefined;
    } catch {
      // Not JSON after all: a YAML flow mapping, say. Read it as YAML.
    }
  }
  const m = /^(["']?)name\1:[ \t]*(.*?)(?:[ \t]+#.*)?[ \t]*$/m.exec(template);
  if (!m) return undefined;
  const value = m[2];
  // A block scalar (|, >) continues on the lines below, and an anchor, tag,
  // alias or flow collection is not a plain name: none is readable from here.
  if (/^[|>&!*[{]/.test(value)) return undefined;
  const single = /^'(.*)'$/.exec(value);
  if (single) return single[1].replace(/''/g, "'");
  const double = /^"(.*)"$/.exec(value);
  if (double) return double[1];
  return value;
}

// install always installs the version it was asked for. Its job is to put that
// version on PATH, so a signadot already there — an old one on a self-hosted
// runner, or one an earlier step pinned differently — must not stand in for it.
export async function install(rt: Runtime = defaultRuntime()): Promise<void> {
  const cli = await rt.installCli(input("version"));
  core.setOutput("cli-path", cli.path);
  core.setOutput("version", cli.version);
}

export function waitArgs(): string[] {
  if (!boolInput("wait", true)) return ["--wait=false"];
  const timeout = input("wait-timeout");
  return timeout === "" ? ["--wait"] : ["--wait", "--wait-timeout", timeout];
}

function readAuth(): Auth {
  const auth: Auth = { apiKey: input("api-key"), org: input("org") };
  // Mask before the key can reach a log line, including ours.
  if (auth.apiKey !== "") core.setSecret(auth.apiKey);
  return auth;
}

function requireAuth(auth: Auth): void {
  if (auth.apiKey === "") {
    throw new Error("`api-key` is required: pass ${{ secrets.SIGNADOT_API_KEY }}");
  }
}

async function report(sb: AppliedSandbox, env: Env): Promise<void> {
  if (sb.name) core.setOutput("sandbox-name", sb.name);
  core.setOutput("routing-key", sb.routingKey ?? "");

  const previews: Record<string, string> = {};
  for (const ep of sb.endpoints ?? []) {
    if (ep.name && ep.url) previews[ep.name] = ep.url;
  }
  core.setOutput("preview-urls", JSON.stringify(previews));
  const urls = Object.values(previews);
  if (urls.length === 1) core.setOutput("preview-url", urls[0]);

  const summary = core.summary.addHeading(`Signadot sandbox: ${sb.name ?? ""}`, 2);
  if (sb.name) summary.addRaw(`Dashboard: ${dashboardURL(sb.name, env)}`, true);
  if (sb.routingKey) {
    summary.addRaw(`Routing key: \`${sb.routingKey}\``, true);
  }
  const endpoints = sb.endpoints ?? [];
  if (endpoints.length > 0) {
    summary.addTable([
      [
        { data: "Endpoint", header: true },
        { data: "Type", header: true },
        { data: "URL", header: true },
      ],
      ...endpoints.map((ep) => [ep.name ?? "", ep.routeType ?? "", ep.url ?? ""]),
    ]);
  }
  await summary.write();
}

// runAction is the shared entry point: every front door reports failure the same
// way, so a workflow log never shows a raw stack trace.
export async function runAction(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    core.setFailed((e as Error).message);
  }
}
