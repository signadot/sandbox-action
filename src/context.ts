import { createHash } from "node:crypto";
import * as fs from "node:fs";

// What CI knows and a committed file cannot: which repository and pull request
// this run belongs to. It is what lets a workflow omit the sandbox name and still
// converge on the same sandbox every time it runs for a given pull request.

// The API reserves this prefix. Two keys under it correlate a sandbox to the
// pull request that made it, and are a pair: one without the other is refused.
export const SIGNADOT_LABEL_PREFIX = "signadot/";
export const LABEL_GITHUB_REPO = "signadot/github-repo";
export const LABEL_GITHUB_PR = "signadot/github-pull-request";

// The longest sandbox name the Signadot API accepts.
export const MAX_NAME_LEN = 30;

export interface CIContext {
  provider: string;
  detected: boolean;
  /** Fully qualified repository, e.g. "signadot/hotrod". */
  repo: string;
  /** Slugified trailing segment of repo, e.g. "hotrod". */
  repoSlug: string;
  pr: string;
  sha: string;
  shortSha: string;
  branchSlug: string;
}

export type Env = Record<string, string | undefined>;

export function noContext(): CIContext {
  return {
    provider: "",
    detected: false,
    repo: "",
    repoSlug: "",
    pr: "",
    sha: "",
    shortSha: "",
    branchSlug: "",
  };
}

export function detectGitHub(env: Env): CIContext {
  const repo = env.GITHUB_REPOSITORY ?? "";
  const sha = env.GITHUB_SHA ?? "";
  return {
    provider: "github",
    detected: true,
    repo,
    repoSlug: slugify(lastPathSegment(repo)),
    pr: githubPRNumber(env),
    sha,
    shortSha: sha.length > 7 ? sha.slice(0, 7) : sha,
    branchSlug: slugify(env.GITHUB_HEAD_REF ?? ""),
  };
}

// detect reads the CI context off GitHub's own marker variable. This is a
// GitHub Action, so there is nothing to choose: either the runner is GitHub's
// and the facts are there, or it is not and there are none.
export function detect(env: Env): CIContext {
  return env.GITHUB_ACTIONS === "true" ? detectGitHub(env) : noContext();
}

// providerLabels correlate a sandbox back to the pull request that produced it,
// which is how the Signadot GitHub App knows to delete it when that pull request
// closes. A build with no pull request — a push to a branch, say — gets neither,
// because the API refuses one without the other.
export function providerLabels(c: CIContext): Record<string, string> | undefined {
  if (c.provider !== "github" || c.repo === "" || c.pr === "") return undefined;
  return { [LABEL_GITHUB_REPO]: c.repo, [LABEL_GITHUB_PR]: c.pr };
}

// defaultName derives a stable name so repeated runs on one pull request update a
// single sandbox instead of accumulating them: `<repo>-<n>` on a pull request, and
// `<repo>-<short-sha>` on a push with no pull request. The GitHub owner is not in it — the full `owner/repo` is on
// the sandbox as a label regardless — and neither is a `pr` token, which keeps
// the name short. When the repository name is
// too long for the API's limit it is the repository that gives way, so the
// number stays whole and visible at the end.
//
// A repository whose name the slug does not capture — `foo.bar` and `foo_bar`
// both slugify to `foo-bar`, as does `foo-bar` itself — gets a short hash of its
// real name as well, or two repositories in one org would share, relabel and
// delete each other's sandboxes. Case alone does not count: GitHub does not let
// two repositories differ only in case.
//
// A sandbox name has to start with a letter, so a repository whose slug starts
// with a digit — acme/123app — is prefixed with `r`: `r123app-5`, not a
// `123app-5` the API would refuse.
export function defaultName(c: CIContext): string {
  if (c.repoSlug === "") return "";
  const slug = /^[0-9]/.test(c.repoSlug) ? `r${c.repoSlug}` : c.repoSlug;
  const suffix = c.pr !== "" ? c.pr : c.shortSha;
  const repoName = lastPathSegment(c.repo).toLowerCase();
  if (repoName !== "" && repoName !== c.repoSlug) return hashedName(slug, shortHash(repoName), suffix);
  if (suffix !== "") return fitName(slug, suffix);
  return normalizeName(slug);
}

// fitName joins a repository slug and a suffix into a name inside MAX_NAME_LEN,
// keeping the suffix whole. A repository that does not fit is truncated and
// given a short hash of its full slug, so two long repositories with the same
// prefix still get distinct names and the same repository always gets the same
// one: `application-orchest-b64581-139`.
export function fitName(repoSlug: string, suffix: string): string {
  const plain = `${repoSlug}-${suffix}`;
  if (plain.length <= MAX_NAME_LEN) return plain;
  return hashedName(repoSlug, shortHash(repoSlug), suffix);
}

// hashedName is `<slug>-<hash>-<suffix>`, or `<slug>-<hash>` with no suffix, with
// the slug truncated as far as it must be to fit MAX_NAME_LEN.
function hashedName(repoSlug: string, hash: string, suffix: string): string {
  const tail = suffix === "" ? hash : `${hash}-${suffix}`;
  const keep = Math.max(1, MAX_NAME_LEN - tail.length - 1);
  return `${repoSlug.slice(0, keep).replace(/-+$/, "")}-${tail}`;
}

function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 6);
}

// imagePlaceholders are the values available to the `image` input. {workload}
// and {namespace} vary per fork and are what lets one input name every image;
// the rest are facts about the run. There is no {short-sha}: image tags are usually
// a full SHA, a digest or a release tag, and a workflow that wants a short
// SHA can compute it in a step.
export function imagePlaceholders(c: CIContext, workload: string, namespace: string): Record<string, string> {
  return {
    workload,
    namespace,
    sha: c.sha,
    pr: c.pr,
    branch: c.branchSlug,
  };
}

// Placeholders whose value differs between forks. An `image` shared by several
// forks has to use one of them, or every fork would run the same image.
export const perForkPlaceholders = ["workload", "namespace"];

// resolveName picks the sandbox name: the `name` input wins, then a name in the
// caller's own document, then one derived from the CI context.
//
// Only names we synthesise are normalised. A name someone wrote — in a document
// or in the `name` input — is used exactly as written, so adopting this Action
// cannot silently retarget an existing sandbox, and a cleanup step given the same
// `name` deletes the sandbox that was created. The input is checked instead.
export function resolveName(docName: string, explicitName: string, c: CIContext): string {
  const supplied = suppliedName(explicitName, c);
  if (explicitName !== "") return supplied;
  if (docName !== "") return docName;
  if (supplied !== "") return supplied;
  throw new Error(
    `sandbox name is required, and ${noDerivedName(c)}: set the \`name\` input, or put a name in your document`,
  );
}

// noDerivedName says why no name could be derived, for the error that asks for
// one. "Run where a CI context can be detected" is no help to a run on GitHub
// whose repository name simply has nothing in it a sandbox name can use.
export function noDerivedName(c: CIContext): string {
  if (!c.detected) return "there is no CI context to derive one from";
  if (c.repo === "") return "GITHUB_REPOSITORY is not set, so there is no repository to derive one from";
  return `the repository name '${c.repo}' has no letters or digits to derive one from`;
}

// suppliedName is the name the Action can supply from outside a document: the
// explicit input, or one derived from CI. It is empty when there is neither,
// which is when a document has to carry its own.
export function suppliedName(explicitName: string, c: CIContext): string {
  if (explicitName !== "") return checkNameInput(explicitName);
  const derived = defaultName(c);
  return c.detected && derived !== "" ? normalizeName(derived) : "";
}

// checkNameInput refuses a bad `name` input, with the rule it broke. The rule is
// the API's own for a sandbox name (v2sb.SandboxName): at most MAX_NAME_LEN
// characters of letters, digits and single dashes, starting with a letter and
// not ending with a dash. The one difference is case. The API accepts uppercase
// and folds the name to lowercase when it creates the sandbox, but a delete
// looks the name up as given, so `Hotrod-42` would create `hotrod-42` and a
// cleanup step using the same input would miss it. Requiring lowercase keeps
// create and delete agreeing.
//
// Rewriting the name instead — slugifying `Hotrod_PR_42` to `hotrod-pr-42` —
// would make two differently written names one sandbox, and leave a cleanup
// step that uses the name as written deleting nothing.
export function checkNameInput(name: string): string {
  const problem = !/[a-zA-Z0-9]/.test(name)
    ? "has no letters or digits"
    : name.length > MAX_NAME_LEN
      ? `is ${name.length} characters, and the limit is ${MAX_NAME_LEN}`
      : /[A-Z]/.test(name)
        ? `has '${/[A-Z]/.exec(name)?.[0]}': write it in lowercase. The API would fold it to lowercase on ` +
          "create, but a delete looks the name up as written, so the two would not agree"
        : /[^a-z0-9-]/.test(name)
          ? `has '${/[^a-z0-9-]/.exec(name)?.[0]}': only lowercase letters, digits and '-' are allowed`
          : !/^[a-z]/.test(name)
            ? "must start with a lowercase letter"
            : name.endsWith("-")
              ? "must not end with '-'"
              : name.includes("--")
                ? "must not contain '--'"
                : "";
  if (problem !== "") throw new Error(`the \`name\` input '${name}' ${problem}`);
  return name;
}

// normalizeName slugifies a candidate and, when it is too long for the API,
// truncates it and appends a content hash so distinct inputs stay distinct.
export function normalizeName(name: string): string {
  const slug = slugify(name);
  if (slug.length <= MAX_NAME_LEN) return slug;

  const suffix = createHash("sha256").update(slug).digest("hex").slice(0, 6);
  const keep = Math.max(1, MAX_NAME_LEN - 1 - suffix.length);
  return `${slug.slice(0, Math.min(keep, slug.length)).replace(/-+$/, "")}-${suffix}`;
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function lastPathSegment(s: string): string {
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

// githubPRNumber reads the number from GITHUB_REF where it carries one, and falls
// back to the event payload for triggers such as pull_request_target and
// issue_comment where it does not.
function githubPRNumber(env: Env): string {
  const m = /^refs\/pull\/(\d+)\//.exec(env.GITHUB_REF ?? "");
  if (m) return m[1];

  const eventPath = env.GITHUB_EVENT_PATH ?? "";
  if (eventPath === "") return "";
  try {
    const event = JSON.parse(fs.readFileSync(eventPath, "utf8")) as {
      pull_request?: { number?: number };
      number?: number;
      issue?: { number?: number; pull_request?: unknown };
    };
    // A comment's payload has the number on the issue, and GitHub treats every
    // pull request as an issue; only one carrying `pull_request` is one.
    const onPR = event.issue?.pull_request ? event.issue.number : undefined;
    const n = event.pull_request?.number ?? event.number ?? onPR;
    return n ? String(n) : "";
  } catch {
    // No readable payload just means we cannot derive a number from it.
    return "";
  }
}
