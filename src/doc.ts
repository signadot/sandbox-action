import * as yaml from "js-yaml";
import { LABEL_GITHUB_PR, LABEL_GITHUB_REPO, MAX_NAME_LEN, SIGNADOT_LABEL_PREFIX } from "./context";

export type Doc = Record<string, unknown>;

export function isDoc(v: unknown): v is Doc {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// loadYAML parses YAML or JSON, naming `what` if it cannot.
export function loadYAML(s: string, what: string): unknown {
  try {
    return yaml.load(s);
  } catch (e) {
    throw new Error(`${what} is not valid YAML or JSON: ${(e as Error).message}`);
  }
}

// parseDoc reads a sandbox document, YAML or JSON.
export function parseDoc(s: string, what: string): Doc {
  const parsed = loadYAML(s, what);
  if (!isDoc(parsed)) {
    throw new Error(`${what} must be a mapping with a name and a spec`);
  }
  return parsed;
}

// spec returns the document's spec, creating it if absent. A spec that is there
// but is not a mapping is refused rather than replaced: replacing it would apply
// a sandbox with none of what the author wrote.
export function spec(doc: Doc): Doc {
  if (doc.spec == null) doc.spec = {};
  if (!isDoc(doc.spec)) {
    throw new Error(`your document's spec must be a mapping, got ${kindOf(doc.spec)}`);
  }
  return doc.spec;
}

// kindOf names what a YAML value turned out to be, for messages about a
// document that has the wrong shape.
export function kindOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "a list";
  if (typeof v === "object") return "a mapping";
  return `a ${typeof v}`;
}

// pruneNulls drops null-valued keys, recursively. A document that has come back
// from a template carries nulls that would otherwise show up as `local: null`
// noise in the spec people read.
export function pruneNulls(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(pruneNulls);
  if (isDoc(v)) {
    const out: Doc = {};
    for (const [k, val] of Object.entries(v)) {
      if (val === null || val === undefined) continue;
      out[k] = pruneNulls(val);
    }
    return out;
  }
  return v;
}

// validate catches what would otherwise come back as an opaque API rejection
// after the sandbox has already been submitted.
export function validate(doc: Doc): void {
  const name = typeof doc.name === "string" ? doc.name : "";
  if (name === "") throw new Error("the sandbox has no name");
  if (name.length > MAX_NAME_LEN) {
    throw new Error(`sandbox name '${name}' exceeds ${MAX_NAME_LEN} characters`);
  }

  const sp = isDoc(doc.spec) ? doc.spec : undefined;
  const cluster = sp && typeof sp.cluster === "string" ? sp.cluster : "";
  if (cluster === "") {
    throw new Error("the sandbox spec has no cluster: set the `cluster` input, or a cluster in your document");
  }

  const forks = sp && Array.isArray(sp.forks) ? sp.forks : [];
  forks.forEach((f, i) => {
    const forkOf = isDoc(f) && isDoc(f.forkOf) ? f.forkOf : undefined;
    if (!forkOf || typeof forkOf.name !== "string" || forkOf.name === "") {
      throw new Error(`forks[${i}]: forkOf.name is required`);
    }
    if (typeof forkOf.namespace !== "string" || forkOf.namespace === "") {
      throw new Error(`forks[${i}]: forkOf.namespace is required`);
    }
  });

  validateLabels(sp && isDoc(sp.labels) ? sp.labels : {});
}

// The keys the API allows under the reserved prefix: the GitHub pair, and
// nothing else.
const reservedLabels = [LABEL_GITHUB_REPO, LABEL_GITHUB_PR];

// validateLabels enforces the API's rules for the reserved prefix here, where the
// message can name the offending key and nothing has been submitted yet.
function validateLabels(labels: Doc): void {
  // Sorted so a document with several bad keys always reports the same one.
  for (const k of Object.keys(labels).sort()) {
    if (!k.startsWith(SIGNADOT_LABEL_PREFIX)) continue;
    if (!reservedLabels.includes(k)) {
      throw new Error(
        `label '${k}': the ${SIGNADOT_LABEL_PREFIX} prefix is reserved, and only ` +
          `${reservedLabels.join(", ")} are allowed under it`,
      );
    }
  }
  const hasRepo = LABEL_GITHUB_REPO in labels;
  const hasPR = LABEL_GITHUB_PR in labels;
  if (hasRepo !== hasPR) {
    throw new Error(`labels ${LABEL_GITHUB_REPO} and ${LABEL_GITHUB_PR} must be set together or not at all`);
  }
}

// keyRank puts the short fields that identify a sandbox above the bulky nested
// ones, matching how specs are written in the Signadot documentation. Labels in
// particular are worth seeing without scrolling past every fork.
const keyRank = [
  "name",
  "spec",
  "cluster",
  "description",
  "labels",
  "ttl",
  "resources",
  "forks",
  "defaultRouteGroup",
  "forkOf",
  "kind",
  "namespace",
  "customizations",
  "images",
  "env",
  "endpoints",
  "patch",
];

// The CLI reads documents as YAML 1.1, where more plain scalars are numbers or
// bools than in the YAML 1.2 js-yaml writes. js-yaml already quotes the 1.1 bools
// (`yes`, `on`, `n`) and most numbers, but not digits separated by underscores:
// `1_000`, `0_7` and `685_230.15` are strings to js-yaml and numbers to the CLI,
// which then refuses them as an env value. yaml11Number matches the 1.1 int and
// float forms, underscores included; quoting a string that did not need it is
// harmless, so the pattern errs wide.
const yaml11Number =
  /^[-+]?(?:0b[01_]+|0o[0-7_]+|0x[0-9a-fA-F_]+|[0-9][0-9_]*(?::[0-5]?[0-9])*(?:\.[0-9._]*)?(?:[eE][-+]?[0-9]+)?|\.[0-9][0-9._]*(?:[eE][-+]?[0-9]+)?|\.(?:inf|Inf|INF))$|^\.(?:nan|NaN|NAN)$/;

// dumpSchema is js-yaml's default schema plus a type that claims every
// yaml11Number. The dumper quotes any string that some implicit type would
// resolve, so claiming them is what gets them quoted; the type is never used to
// load anything.
const dumpSchema = yaml.DEFAULT_SCHEMA.extend({
  implicit: [
    new yaml.Type("tag:signadot.com,2026:yaml11-number", {
      kind: "scalar",
      resolve: (s: string | null) => s !== null && yaml11Number.test(s),
    }),
  ],
});

// toYAML serialises a document for a person to read: our key order rather than a
// purely alphabetical one, and long image references left unwrapped, since one
// folded across lines is needlessly hard to read in a job log. Strings the CLI's
// YAML 1.1 would read as something else are quoted.
export function toYAML(doc: unknown): string {
  return yaml.dump(doc, {
    schema: dumpSchema,
    lineWidth: 0,
    noRefs: true,
    sortKeys: (a: string, b: string) => {
      const ra = keyRank.indexOf(a);
      const rb = keyRank.indexOf(b);
      if (ra >= 0 && rb >= 0) return ra - rb;
      if (ra >= 0) return -1;
      if (rb >= 0) return 1;
      return a < b ? -1 : a > b ? 1 : 0;
    },
  });
}
