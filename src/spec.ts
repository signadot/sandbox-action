import {
  type CIContext,
  imagePlaceholders,
  LABEL_GITHUB_PR,
  LABEL_GITHUB_REPO,
  perForkPlaceholders,
  providerLabels,
  resolveName,
} from "./context";
import { type Doc, isDoc, kindOf, loadYAML, spec as specOf } from "./doc";
import { boolInput, type ForkAttrs, input, lines, parseForkList, parseKeyVals } from "./inputs";
import type { Route } from "./route";

// Turning "fork these workloads with these images" into a sandbox spec. This is
// the part a template cannot do: the fork list has a length that comes from the
// input, and images, env and labels are computed rather than written down.
//
// The rules here are the Action's contract, so they are worth stating in one
// place: every fork is fully named on its own line; one `image` names every
// fork's image through {placeholders} unless a line says image= itself; `env`
// applies to every fork, except lines prefixed `workload:` which apply to one;
// and nothing invents a TTL.

// An env entry is a value, or an instruction to remove the variable from the
// forked workload (`NAME-` in the inputs). A value may be a ${resource:name.key}
// reference, which is resolved when the fork is compiled.
export type EnvValue = string | { delete: true };

// The `env` input, split by scope: `KEY=VALUE` goes to every fork, and
// `workload:KEY=VALUE` to the fork(s) of that name, winning key by key.
export interface EnvInput {
  shared: Record<string, EnvValue>;
  byWorkload: Record<string, Record<string, EnvValue>>;
}

// Params are passed through as the YAML wrote them, and checked by the CLI. The
// CLI's decoder takes string values only: a number or a boolean is refused
// ("cannot unmarshal number into ... resources.params of type string"), so a
// value that looks like one has to be quoted ('5432'). CLIs before cli#375 also
// refused a quoted value under a param called `port`; that is fixed there.
export interface ResourceInput {
  name: string;
  plugin: string;
  params?: Doc;
}

// Options are what the flat inputs mean, gathered so that building a spec is a
// pure function of them and the CI context.
export interface Options {
  name: string;
  cluster: string;
  description: string;
  ttl: string;
  ttlOffsetFrom: string;
  labels: Record<string, string>;
  lifecycleLabels: boolean;
  image: string;
  forks: ForkAttrs[];
  env: EnvInput;
  resources: ResourceInput[];
  endpoints: { name: string; target: string }[];
}

// readOptions collects the inputs. Blob inputs are parsed only enough to place
// them; what is inside them is checked when the spec is built or, for anything
// the Action does not model, by the CLI against the API's own schema.
//
// The shape inputs are read only on the route that uses them. When a document
// owns the shape they are ignored with a warning naming each one, and a
// leftover `env:` that no longer parses must not fail a workflow that has moved
// on from it.
export function readOptions(route: Route = "inputs"): Options {
  const shape = route === "inputs";
  const ttl = input("ttl");
  const ttlOffsetFrom = input("ttl-offset-from");
  if (ttlOffsetFrom !== "") {
    if (ttl === "") throw new Error("`ttl-offset-from` needs a `ttl` to count from");
    if (!ttlOffsets.includes(ttlOffsetFrom)) {
      throw new Error(`\`ttl-offset-from\` must be one of ${ttlOffsets.join(", ")}, got '${ttlOffsetFrom}'`);
    }
  }

  const labels = keyVals("labels");

  return {
    name: input("name"),
    cluster: input("cluster"),
    description: input("description"),
    ttl,
    ttlOffsetFrom,
    labels,
    lifecycleLabels: boolInput("lifecycle-labels", true),
    image: shape ? input("image") : "",
    forks: shape ? parseForkList(input("fork")) : [],
    env: shape ? envInput(input("env")) : { shared: {}, byWorkload: {} },
    resources: shape ? resourceList(input("resources")) : [],
    endpoints: shape
      ? Object.entries(keyVals("endpoints")).map(([name, target]) => {
          if (target === "") throw new Error(`\`endpoints\`: '${name}' has no URL`);
          return { name, target };
        })
      : [],
  };
}

// build compiles the options into a sandbox document.
export function build(opts: Options, ctx: CIContext): Doc {
  if (opts.forks.length === 0) {
    throw new Error("at least one workload to fork is required: set `fork`");
  }

  const declared = new Set(opts.resources.map((r) => r.name));
  const doc: Doc = { name: resolveName("", opts.name, ctx) };
  const sp = specOf(doc);
  sp.cluster = requireCluster(opts.cluster);
  if (opts.description !== "") sp.description = opts.description;
  const ttl = ttlOf(opts);
  if (ttl) sp.ttl = ttl;

  sp.labels = stampLabels(opts, ctx);

  if (opts.resources.length > 0) {
    sp.resources = opts.resources.map((r) => {
      const out: Doc = { name: r.name, plugin: r.plugin };
      if (r.params && Object.keys(r.params).length > 0) out.params = { ...r.params };
      return out;
    });
  }

  checkSharedImage(opts);
  const named = new Set(opts.forks.map((f) => f.name));
  for (const workload of Object.keys(opts.env.byWorkload)) {
    if (!named.has(workload)) {
      throw new Error(
        `\`env\`: '${workload}:' names a workload that is not being forked ` + `(forking: ${[...named].join(", ")})`,
      );
    }
  }
  sp.forks = opts.forks.map((f) => buildFork(f, opts, ctx, declared));

  if (opts.endpoints.length > 0) {
    sp.defaultRouteGroup = {
      endpoints: opts.endpoints.map((e) => ({ name: e.name, target: e.target })),
    };
  }

  return doc;
}

const ttlOffsets = ["createdAt", "updatedAt"];

// ttlOf is the `ttl` and `ttl-offset-from` inputs as the API's ttl object. The
// offset is only written when asked for: the API defaults it to createdAt, and a
// spec should not carry a default it did not choose.
export function ttlOf(opts: Pick<Options, "ttl" | "ttlOffsetFrom">): Doc | undefined {
  if (opts.ttl === "") return undefined;
  const ttl: Doc = { duration: opts.ttl };
  if (opts.ttlOffsetFrom !== "") ttl.offsetFrom = opts.ttlOffsetFrom;
  return ttl;
}

// stampLabels adds the Action's labels to the caller's own: the lifecycle pair,
// which the GitHub App reads. It goes on as a pair or not at all: the
// API wants both keys or neither, so filling in the half the caller left out
// would produce a pair that says something they did not — a sandbox correlated
// to their repository and our pull request.
//
// `claimed` is the labels the caller's document already carries, which is why the
// check cannot look at the inputs alone.
export function stampLabels(
  opts: Pick<Options, "labels" | "lifecycleLabels">,
  ctx: CIContext,
  claimed: Record<string, unknown> = {},
): Record<string, string> {
  const labels = { ...opts.labels };
  if (!opts.lifecycleLabels) return labels;
  const provider = providerLabels(ctx);
  if (!provider) return labels;
  if (!Object.keys(provider).some((k) => k in labels || k in claimed)) {
    Object.assign(labels, provider);
    return labels;
  }
  refuseMiscorrelated(provider, labels, claimed);
  return labels;
}

// refuseMiscorrelated fails the step when the caller has correlated the sandbox
// to a different pull request than the one being built. The labels are what the
// Signadot GitHub App reads to comment and to delete on close, so a mismatch
// points teardown at the wrong pull request, and nothing in the job would show
// it. A workflow that means it — one repository creating a sandbox for another's
// pull request — says so with `lifecycle-labels: false`.
function refuseMiscorrelated(
  provider: Record<string, string>,
  labels: Record<string, string>,
  claimed: Record<string, unknown>,
): void {
  const stated = (k: string): string | undefined =>
    k in claimed ? String(claimed[k]) : k in labels ? labels[k] : undefined;

  const disagrees = Object.keys(provider).some((k) => {
    const v = stated(k);
    return v !== undefined && v !== provider[k];
  });
  if (!disagrees) return;

  const where = Object.keys(provider).some((k) => k in claimed) ? "your document" : "the `labels` input";
  throw new Error(
    `${where} correlates this sandbox to ` +
      `${stated(LABEL_GITHUB_REPO) ?? "?"}#${stated(LABEL_GITHUB_PR) ?? "?"}, ` +
      `but this run is ${provider[LABEL_GITHUB_REPO]}#${provider[LABEL_GITHUB_PR]}. ` +
      "The Signadot GitHub App would comment on and delete against the pull request " +
      "the labels name rather than this one. Remove them to have them derived, or set " +
      "`lifecycle-labels: false` if this is deliberate.",
  );
}

// checkSharedImage refuses an `image` that would give several forks the same
// image. With one fork it is that fork's image; with several it has to say how
// they differ, or the intent was almost certainly one fork's image applied to
// all of them by accident.
function checkSharedImage(opts: Options): void {
  if (opts.image === "") return;
  const sharing = opts.forks.filter((f) => f.image === undefined);
  if (sharing.length < 2) return;
  if (perForkPlaceholders.some((p) => opts.image.includes(`{${p}}`))) return;
  throw new Error(
    `\`image\` '${opts.image}' would run on ${sharing.length} forks unchanged: use ` +
      `{${perForkPlaceholders.join("} or {")}} in it, or image= on each fork line`,
  );
}

function buildFork(f: ForkAttrs, opts: Options, ctx: CIContext, declared: Set<string>): Doc {
  const customizations: Doc = {};
  const image = resolveImage(f, opts.image, ctx);
  if (image) customizations.images = [{ image }];

  const env = mergeEnv(opts.env.shared, opts.env.byWorkload[f.name] ?? {}, declared, f.name);
  if (env.length > 0) customizations.env = env;

  const fork: Doc = { forkOf: { kind: f.kind, name: f.name, namespace: f.namespace } };
  if (Object.keys(customizations).length > 0) fork.customizations = customizations;
  return fork;
}

// resolveImage implements the precedence: the line's own image=, then the shared
// `image` with its placeholders filled in for this fork, then none. A fork that
// only overrides env is legal.
function resolveImage(f: ForkAttrs, image: string, ctx: CIContext): string | undefined {
  if (f.image) return f.image;
  if (image === "") return undefined;
  return resolveImageTemplate(image, imagePlaceholders(ctx, f.name, f.namespace), f.name);
}

// resolveImageTemplate substitutes {placeholder} tokens, naming any it cannot
// resolve: an unresolved one would otherwise reach the cluster as a literal and
// fail to pull, long after this job went green.
export function resolveImageTemplate(tpl: string, placeholders: Record<string, string>, workload?: string): string {
  const missing: string[] = [];
  const out = tpl.replace(/\{([a-zA-Z][a-zA-Z0-9-]*)\}/g, (token, key: string) => {
    // Own keys only: {constructor} must not resolve to what every object
    // inherits.
    const v = Object.hasOwn(placeholders, key) ? placeholders[key] : "";
    if (v === "") {
      if (!missing.includes(key)) missing.push(key);
      return token;
    }
    return v;
  });
  if (missing.length > 0) {
    const where = workload ? `fork '${workload}': ` : "";
    // A placeholder the Action knows but this run has no value for — {branch} on
    // an issue_comment, {pr} on a push — is named as that, and not offered as
    // available: it is the one that just failed.
    const named = missing.map((k) => (Object.hasOwn(placeholders, k) ? `${k} (no value in this run)` : k));
    const available = Object.keys(placeholders).filter((k) => placeholders[k] !== "");
    throw new Error(
      `${where}unresolvable image placeholder(s): ${named.join(", ")}. ` + `Available: ${available.sort().join(", ")}`,
    );
  }
  return out;
}

// mergeEnv merges the shared env under the fork's own, then compiles every value,
// resolving ${resource:name.key} references.
function mergeEnv(
  shared: Record<string, EnvValue>,
  own: Record<string, EnvValue>,
  declared: Set<string>,
  workload: string,
): Doc[] {
  const merged: Record<string, EnvValue> = { ...shared, ...own };
  // Sorted so the spec is identical between runs, which is what makes the
  // rendered output worth diffing.
  return Object.keys(merged)
    .sort()
    .map((k) => {
      const v = merged[k];
      if (typeof v !== "string") return { name: k, operation: "delete" };
      const ref = /^\$\{resource:([^}]+)\}$/.exec(v)?.[1];
      if (ref) {
        return { name: k, valueFrom: { resource: resourceRef(ref, declared, k, workload) } };
      }
      // Unescape $${...} so a value that genuinely wants those characters can
      // say so.
      const value = v.replace(/\$\$\{/g, "${");
      // The API's model does not distinguish an empty value from an absent one,
      // so neither does this: emitting `value: ""` would only look like it did.
      return value === "" ? { name: k } : { name: k, value };
    });
}

function resourceRef(ref: string, declared: Set<string>, envKey: string, workload: string): Doc {
  const prefix = `fork '${workload}': env '${envKey}': `;
  const i = ref.indexOf(".");
  const name = i < 0 ? "" : ref.slice(0, i);
  const key = i < 0 ? "" : ref.slice(i + 1);
  if (!name || !key) {
    throw new Error(`${prefix}resource reference '${ref}' must be of the form name.key`);
  }
  if (!declared.has(name)) {
    throw new Error(`${prefix}resource reference '${ref}' names an undeclared resource '${name}'`);
  }
  return { name, outputKey: key };
}

function requireCluster(cluster: string): string {
  if (cluster === "") {
    throw new Error("`cluster` is required when the sandbox is built from inputs");
  }
  return cluster;
}

// The fields the Action models in each blob input. Anything else is refused: a
// misspelt key would otherwise vanish, the spec would still validate, and the
// sandbox would come up without the customization with nothing to say why.
const resourceFields = ["name", "plugin", "params"];

function strictDoc(v: unknown, where: string, allowed: readonly string[]): Doc {
  if (!isDoc(v)) throw new Error(`${where}: must be a mapping`);
  for (const k of Object.keys(v)) {
    if (!allowed.includes(k)) {
      throw new Error(`${where}: unknown field '${k}' (allowed: ${allowed.join(", ")})`);
    }
  }
  return v;
}

// envInput reads the multiline `env` input. `KEY=VALUE` sets a variable on every
// fork and `NAME-` removes one the baseline workload has, as `kubectl set env`
// writes it; prefixing either with `workload:` scopes it to that fork. The
// prefix is unambiguous because a variable name cannot contain ':'.
export function envInput(s: string): EnvInput {
  // Keyed by workload, '' for the shared scope. Maps rather than objects, so that
  // a workload or variable called __proto__ is only a name.
  const scopes = new Map<string, Map<string, EnvValue>>();
  for (const raw of lines(s)) {
    // The scope is a prefix on the name, so it ends before any '=' does.
    const eq = raw.indexOf("=");
    const colon = (eq < 0 ? raw : raw.slice(0, eq)).indexOf(":");
    const workload = colon < 0 ? "" : raw.slice(0, colon).trim();
    const line = colon < 0 ? raw : raw.slice(colon + 1).trim();
    if (colon >= 0 && workload === "") {
      throw new Error(`\`env\`: '${raw}' has an empty workload before the ':'`);
    }

    const [name, value] = envEntry(line, raw);
    let vars = scopes.get(workload);
    if (!vars) {
      vars = new Map();
      scopes.set(workload, vars);
    }
    const before = vars.get(name);
    if (before !== undefined && typeof before !== typeof value) {
      const where = workload === "" ? "`env`" : `\`env\` for '${workload}'`;
      throw new Error(`${where}: '${name}' is both set and removed`);
    }
    vars.set(name, value);
  }

  const { "": shared, ...byWorkload } = Object.fromEntries(
    [...scopes].map(([workload, vars]) => [workload, Object.fromEntries(vars)]),
  );
  return { shared: shared ?? {}, byWorkload };
}

// envEntry reads one line of `env` with its scope already removed: `KEY=VALUE`,
// where the value is everything after the first '=', or `NAME-`.
function envEntry(line: string, raw: string): [string, EnvValue] {
  const eq = line.indexOf("=");
  if (eq >= 0) return [line.slice(0, eq).trim(), line.slice(eq + 1)];
  if (!line.endsWith("-")) {
    throw new Error(
      `\`env\`: want KEY=VALUE, or NAME- to remove a variable, optionally prefixed workload:, got '${raw}'`,
    );
  }
  const name = line.slice(0, -1).trim();
  if (name === "") throw new Error(`\`env\`: a bare '-' names no variable`);
  return [name, { delete: true }];
}

function keyVals(name: string): Record<string, string> {
  const raw = input(name);
  return raw === "" ? {} : parseKeyVals(raw, name);
}

function blob(s: string, what: string): unknown {
  const doc = loadYAML(s, `\`${what}\``);
  if (doc == null) throw new Error(`\`${what}\` is empty`);
  return doc;
}

function blobList(s: string, what: string, fields: readonly string[]): Doc[] {
  if (s === "") return [];
  const doc = blob(s, what);
  if (!Array.isArray(doc)) throw new Error(`\`${what}\` must be a list`);
  return doc.map((entry, i) => strictDoc(entry, `${what}[${i}]`, fields));
}

// resourceList reads the `resources` input, checking the type of each field it
// models: anything else would be spread into the spec as it came, so params
// written as a string would reach the CLI as {"0": "c", "1": "u", ...}.
function resourceList(s: string): ResourceInput[] {
  return blobList(s, "resources", resourceFields).map((entry, i) => {
    const name = requiredString(entry, "name", `resources[${i}]`);
    const plugin = requiredString(entry, "plugin", `resource '${name}'`);
    const r: ResourceInput = { name, plugin };
    if (entry.params != null) {
      if (!isDoc(entry.params)) {
        throw new Error(`resource '${name}': params must be a mapping, got ${kindOf(entry.params)}`);
      }
      r.params = entry.params;
    }
    return r;
  });
}

function requiredString(entry: Doc, field: string, where: string): string {
  const v = entry[field];
  if (v == null || v === "") throw new Error(`${where}: ${field} is required`);
  if (typeof v !== "string") throw new Error(`${where}: ${field} must be a string, got ${kindOf(v)}`);
  return v;
}
