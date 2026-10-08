import * as core from "@actions/core";
import * as yaml from "js-yaml";

// GitHub Actions inputs are all strings, so this file holds the small grammars
// that let a workflow express structure in one: multiline KEY=VALUE, and the
// fork line. Everything they produce goes into a spec the CLI validates;
// nothing here checks meaning.

export function input(name: string): string {
  return core.getInput(name).trim();
}

export function boolInput(name: string, fallback: boolean): boolean {
  const raw = input(name);
  if (raw === "") return fallback;
  switch (raw.toLowerCase()) {
    case "true":
    case "yes":
    case "1":
      return true;
    case "false":
    case "no":
    case "0":
      return false;
    default:
      throw new Error(`input '${name}' must be true or false, got '${raw}'`);
  }
}

// lines splits a multiline input, dropping blanks and # comments.
export function lines(s: string): string[] {
  return s
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
}

// parseKeyVals parses multiline KEY=VALUE. Values keep their internal spacing
// and any '=' after the first.
export function parseKeyVals(s: string, what: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of lines(s)) {
    const i = line.indexOf("=");
    if (i < 0) {
      throw new Error(`\`${what}\`: invalid KEY=VALUE line: '${line}'`);
    }
    out[line.slice(0, i).trim()] = line.slice(i + 1);
  }
  return out;
}

// A fork is fully identified on its own line. Nothing is defaulted or inferred:
// the kind and namespace are written down where the workload is, so a line can
// be read without knowing what the rest of the step says.
export interface ForkAttrs {
  kind: string;
  namespace: string;
  name: string;
  image?: string;
}

const required = ["kind", "namespace", "name"] as const;
const forkAttrs = [...required, "image"] as const;
const example = "kind=Deployment,namespace=hotrod,name=route";

// parseForkLine parses one `key=value,key=value` fork record.
export function parseForkLine(line: string): ForkAttrs {
  const seen: Partial<Record<(typeof forkAttrs)[number], string>> = {};
  for (const raw of line.split(",")) {
    const part = raw.trim();
    if (part === "") continue;
    const eq = part.indexOf("=");
    if (eq < 0) {
      throw new Error(
        `invalid fork '${line}': '${part}' is not key=value. A fork line names its ` +
          `kind, namespace and name, e.g. ${example}; put each fork on its own line`,
      );
    }
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (!(forkAttrs as readonly string[]).includes(key)) {
      throw new Error(`invalid fork '${line}': unknown attribute '${key}' (allowed: ${forkAttrs.join(", ")})`);
    }
    const k = key as (typeof forkAttrs)[number];
    if (seen[k] !== undefined) throw new Error(`invalid fork '${line}': '${key}' is given twice`);
    if (val === "") throw new Error(`invalid fork '${line}': '${key}' has no value`);
    seen[k] = val;
  }
  return complete(seen, `invalid fork '${line}'`);
}

// parseForkList reads the `fork` input as a whole: one record per line, or a
// JSON array for a list a previous step computed. Each element of the array is
// an object with the same four attributes, or a string in the line grammar.
export function parseForkList(s: string): ForkAttrs[] {
  if (!s.startsWith("[")) return lines(s).map(parseForkLine);

  let list: unknown;
  try {
    list = yaml.load(s);
  } catch (e) {
    throw new Error(`\`fork\` starts with '[' but is not a valid JSON array: ${(e as Error).message}`);
  }
  if (!Array.isArray(list)) throw new Error("`fork` starts with '[' but is not a JSON array");
  return list.map((item, i) => {
    if (typeof item === "string") return parseForkLine(item);
    const where = `fork[${i}]`;
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`${where}: must be a {kind, namespace, name} object or a "key=value,..." string`);
    }
    const seen: Partial<Record<(typeof forkAttrs)[number], string>> = {};
    for (const [k, v] of Object.entries(item)) {
      if (!(forkAttrs as readonly string[]).includes(k)) {
        throw new Error(`${where}: unknown attribute '${k}' (allowed: ${forkAttrs.join(", ")})`);
      }
      if (typeof v !== "string" || v === "") throw new Error(`${where}: '${k}' must be a non-empty string`);
      seen[k as (typeof forkAttrs)[number]] = v;
    }
    return complete(seen, where);
  });
}

function complete(seen: Partial<Record<(typeof forkAttrs)[number], string>>, where: string): ForkAttrs {
  const { kind, namespace, name, image } = seen;
  if (kind === undefined || namespace === undefined || name === undefined) {
    const missing = required.filter((k) => seen[k] === undefined);
    throw new Error(`${where}: missing ${missing.join(", ")}; every fork names all three, e.g. ${example}`);
  }
  const fork: ForkAttrs = { kind, namespace, name };
  if (image !== undefined) fork.image = image;
  return fork;
}
