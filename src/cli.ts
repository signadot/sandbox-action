import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as tc from "@actions/tool-cache";
import { version } from "../package.json";
import type { Env } from "./context";

// The oldest CLI with the hidden flags the Action needs: --dry-run, --no-template
// and --header all shipped in v1.9.0.
const MIN_CLI = "v1.9.0";

// The CLI this version of the Action runs unless told otherwise: the release it
// was tested against. A pin, so that a CLI release cannot change what a pinned
// Action does; `cli-version: latest` opts back in to tracking releases. The
// action.yml files declare the same default, and a test keeps them in step.
export const DEFAULT_CLI = "v1.9.0";

const CLI_REPO = "signadot/cli";
const CLI_PROJECT = "signadot-cli";
const TOOL_NAME = "signadot";

export interface CLI {
  path: string;
  version: string;
}

// Exec runs a command the way @actions/exec does. It is a parameter so that the
// code driving the CLI can be tested without one.
export type Exec = (command: string, args: string[], options: exec.ExecOptions) => Promise<number>;

// Runner is what running the CLI depends on from outside the process: the
// environment it inherits, and the means of starting it.
export interface Runner {
  env: Env;
  exec: Exec;
}

export function defaultRunner(): Runner {
  return { env: process.env, exec: exec.exec };
}

// ensureCli picks the CLI to run, most explicit first:
//
//  1. SIGNADOT_CLI_PATH, a directory or the binary itself: exactly that one, for
//     a CLI built from source or put somewhere on purpose.
//  2. "latest": a signadot already on PATH, so that a preceding install-cli
//     step wins; otherwise the latest release.
//  3. A pinned cli-version, which unset means DEFAULT_CLI: that version,
//     installed into the tool cache unless an earlier step in the job already
//     did. A signadot that happens to be on PATH does not count, since a pin
//     that a runner's own CLI could override would not be a pin.
//
// cached finds the tool-cache install of a version, and install installs one;
// both are parameters so the choice can be tested without a network.
export async function ensureCli(
  version: string,
  env: Env = process.env,
  cached: (version: string) => string | undefined = cachedCli,
  install: (version: string) => Promise<CLI> = installCli,
): Promise<CLI> {
  const explicit = overridePath(env);
  if (explicit) {
    core.info(`Using the signadot CLI named by SIGNADOT_CLI_PATH: ${explicit}`);
    return { path: explicit, version: "" };
  }
  const wanted = requested(version);
  if (wanted === "latest") {
    const onPath = lookPath(env);
    if (onPath) {
      core.info(`Using the signadot CLI already on PATH: ${onPath}`);
      return { path: onPath, version: "" };
    }
    return install(wanted);
  }
  const done = cached(wanted);
  if (done !== undefined) {
    core.info(`Using signadot ${wanted} from the tool cache: ${done}`);
    return { path: done, version: wanted };
  }
  return install(wanted);
}

// requested reads a cli-version input: "latest" as itself, nothing as the
// built-in pin, and anything else as a release tag, with or without its "v".
export function requested(version: string): string {
  const v = version.trim();
  if (v === "latest") return v;
  if (v === "") return DEFAULT_CLI;
  return v.startsWith("v") ? v : `v${v}`;
}

// cachedCli is where installCli put a version in the tool cache, if it has.
// A runner the CLI publishes no build for has none, rather than an error: this
// only decides whether a notice is worth giving.
function cachedCli(tag: string): string | undefined {
  try {
    const dir = tc.find(TOOL_NAME, tag.replace(/^v/, ""), platform().arch);
    return dir ? path.join(dir, TOOL_NAME) : undefined;
  } catch {
    return undefined;
  }
}

// installCli downloads the CLI, verifies it against the published checksums and
// puts it on PATH for later steps.
export async function installCli(version: string): Promise<CLI> {
  const { goos, arch } = platform();
  const resolved = await resolveVersion(version);

  const cached = tc.find(TOOL_NAME, resolved.replace(/^v/, ""), arch);
  if (cached) {
    core.info(`signadot ${resolved} found in the tool cache`);
    core.addPath(cached);
    return { path: path.join(cached, TOOL_NAME), version: resolved };
  }

  core.info(`Installing signadot ${resolved} for ${goos}/${arch}`);
  const sums = await fetchChecksums(resolved);

  // Releases from before the rename carry no `mcp` infix, so a pinned older
  // version still resolves.
  const names = [`${CLI_PROJECT}_mcp_${goos}_${arch}.tar.gz`, `${CLI_PROJECT}_${goos}_${arch}.tar.gz`];
  const name = names.find((n) => sums[n]);
  if (!name) {
    throw new Error(`release ${resolved} publishes none of the expected assets: ${names.join(", ")}`);
  }

  const url = `https://github.com/${CLI_REPO}/releases/download/${resolved}/${name}`;
  const archive = await tc.downloadTool(url);
  await verifyChecksum(archive, sums[name], url);

  const extracted = await tc.extractTar(archive);
  const dir = await tc.cacheDir(extracted, TOOL_NAME, resolved.replace(/^v/, ""), arch);
  const binary = path.join(dir, TOOL_NAME);
  fs.chmodSync(binary, 0o755);
  core.addPath(dir);
  return { path: binary, version: resolved };
}

// lookPath finds signadot the way a shell would: SIGNADOT_CLI_PATH first, then
// each PATH entry in turn.
export function lookPath(env: Env): string | undefined {
  return (
    overridePath(env) ??
    firstFile(
      (env.PATH ?? "")
        .split(path.delimiter)
        .filter((d) => d !== "")
        .map((d) => path.join(d, TOOL_NAME)),
    )
  );
}

// overridePath is the binary SIGNADOT_CLI_PATH names, as a directory holding
// signadot or as the binary itself.
function overridePath(env: Env): string | undefined {
  const override = env.SIGNADOT_CLI_PATH;
  return override ? firstFile([path.join(override, TOOL_NAME), override]) : undefined;
}

function firstFile(candidates: string[]): string | undefined {
  return candidates.find((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
}

function platform(): { goos: string; arch: string } {
  const goos = { linux: "linux", darwin: "darwin" }[process.platform as string];
  if (!goos) {
    throw new Error(
      `the signadot CLI publishes linux and darwin builds only; this runner is ` +
        `${process.platform}. Use a linux or macOS runner`,
    );
  }
  const arch = { x64: "amd64", arm64: "arm64" }[process.arch as string];
  if (!arch) {
    throw new Error(`unsupported runner architecture ${process.arch}`);
  }
  return { goos, arch };
}

// get fetches with one retry, and reports which URL failed. A bare `fetch`
// rejection says only "fetch failed", which on a hosted runner is
// indistinguishable from a bug in the URL.
async function get(url: string, init?: RequestInit, fetcher: typeof fetch = fetch): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetcher(url, init);
    } catch (e) {
      if (attempt === 2) {
        throw new Error(`GET ${url}: ${(e as Error).message}`);
      }
      core.info(`GET ${url} failed (${(e as Error).message}), retrying`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

// resolveVersion turns a cli-version into a concrete tag. A pin, or nothing,
// needs no network; "latest" is read off the redirect github.com serves, which
// avoids api.github.com, whose unauthenticated rate limit is shared per IP and
// so flakes on hosted runners.
export async function resolveVersion(version: string, fetcher: typeof fetch = fetch): Promise<string> {
  const v = requested(version);
  if (v !== "latest") return v;
  const res = await get(`https://github.com/${CLI_REPO}/releases/latest`, { redirect: "manual" }, fetcher);
  const loc = res.headers.get("location") ?? "";
  const i = loc.lastIndexOf("/tag/");
  if (i < 0) {
    throw new Error(`could not resolve the latest signadot CLI release: unexpected redirect '${loc}'`);
  }
  return loc.slice(i + "/tag/".length);
}

// fetchChecksums fetches the checksums.txt published with each release.
async function fetchChecksums(version: string): Promise<Record<string, string>> {
  const url = `https://github.com/${CLI_REPO}/releases/download/${version}/checksums.txt`;
  const res = await get(url);
  if (!res.ok) {
    throw new Error(`GET ${url}: ${res.status} ${res.statusText}`);
  }
  return parseChecksums(await res.text(), version);
}

// parseChecksums reads checksums.txt in the format sha256sum writes, mapping asset
// name to expected sha256. A `*` before the name marks binary mode and is not
// part of it.
export function parseChecksums(text: string, version: string): Record<string, string> {
  const sums: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length === 2) sums[fields[1].replace(/^\*/, "")] = fields[0];
  }
  if (Object.keys(sums).length === 0) {
    throw new Error(`checksums.txt for ${version} is empty or unparseable`);
  }
  return sums;
}

async function verifyChecksum(file: string, want: string, url: string): Promise<void> {
  const hash = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  if (hash !== want) {
    throw new Error(`checksum mismatch for ${url}: got ${hash}, want ${want}`);
  }
}

export interface Auth {
  apiKey: string;
  org: string;
}

// env passes credentials to the CLI through the environment rather than argv,
// where they would be visible in a process listing.
function cliEnv(auth: Auth, base: Env): Record<string, string> {
  const env: Record<string, string> = { ...base } as Record<string, string>;
  if (auth.apiKey !== "") env.SIGNADOT_API_KEY = auth.apiKey;
  if (auth.org !== "") env.SIGNADOT_ORG = auth.org;
  return env;
}

export interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

// run executes the CLI, returning stdout. stderr goes to the job log, where the
// CLI's progress messages belong, and is kept so that a failure can say why.
export async function run(cli: CLI, auth: Auth, args: string[], runner: Runner = defaultRunner()): Promise<string> {
  const r = await tryRun(cli, auth, args, runner);
  if (r.code !== 0) throw failure(cli, args, r);
  return r.stdout;
}

// failure is the error for a run that exited non-zero: what to do about a CLI too
// old for the Action when that is the cause, and otherwise the command and why it
// failed.
export function failure(cli: CLI, args: string[], r: Result): Error {
  return tooOld(cli, args, r) ?? new Error(`signadot ${args.join(" ")} failed with ${exitReason(r)}`);
}

// The hidden `sandbox apply` flags the Action cannot work without: --dry-run
// renders and validates the spec without applying it, and --no-template reads a
// document that has already been rendered without expanding @{...} in it again.
const requiredFlags = ["--dry-run", "--no-template"];

// tooOld recognises a CLI that predates one of requiredFlags. They are hidden
// from --help, so support cannot be asked about up front; an old CLI rejects
// one like any flag it does not know, and that rejection is turned into what to
// do about it.
function tooOld(cli: CLI, args: string[], r: Result): Error | undefined {
  const flag = requiredFlags.find(
    (f) =>
      args.some((a) => a === f || a.startsWith(`${f}=`)) && new RegExp(`unknown flag: ${f}(?![\\w-])`).test(r.stderr),
  );
  if (!flag) return undefined;
  const what = `does not support \`sandbox apply ${flag}\`, which the Action needs to render and validate the spec`;
  if (cli.version !== "") {
    return new Error(`signadot ${cli.version} ${what}. Set \`cli-version\` to ${MIN_CLI} or later`);
  }
  return new Error(
    `the signadot CLI found on PATH at ${cli.path} ${what}. Upgrade it — or whatever step put it ` +
      `there — to ${MIN_CLI} or later, or set \`cli-version\` to a release so the Action installs that instead`,
  );
}

// The Action says who it is on every request the CLI makes, so that usage can be
// counted from the API's metrics: signadot-client-context, sent through the
// CLI's hidden --header flag. The version is the one built into the bundle.
export const CLIENT_CONTEXT_HEADER = "signadot-client-context";

export function clientContextArgs(): string[] {
  return ["--header", `${CLIENT_CONTEXT_HEADER}: integration=sandbox-action,integration-version=${version}`];
}

// Reporting usage must never cost a user their job. A CLI from before --header
// refuses the flag while parsing its arguments, before it does anything, so the
// command is run again without it, and no later command in this run sends it.
// The refusal still shows in the log once, above the note that explains it.
let headerRefused = false;

export function resetClientContext(): void {
  headerRefused = false;
}

function refusedHeader(r: Result): boolean {
  return r.code !== 0 && /unknown flag: --header(?![\w-])/.test(r.stderr);
}

// tryRun is run for a caller that wants stdout even when the CLI fails — an
// apply whose wait timed out still printed the sandbox it created.
export async function tryRun(cli: CLI, auth: Auth, args: string[], runner: Runner = defaultRunner()): Promise<Result> {
  core.info(`Running: signadot ${args.join(" ")}`);
  if (!headerRefused) {
    const r = await runOnce(cli, auth, [...clientContextArgs(), ...args], runner);
    if (!refusedHeader(r)) return r;
    headerRefused = true;
    core.info(
      "This signadot CLI does not accept --header, so this run is not counted in usage metrics; retrying without it",
    );
  }
  return runOnce(cli, auth, args, runner);
}

async function runOnce(cli: CLI, auth: Auth, args: string[], runner: Runner): Promise<Result> {
  let stdout = "";
  let stderr = "";
  const code = await runner.exec(cli.path, args, {
    env: cliEnv(auth, runner.env),
    ignoreReturnCode: true,
    listeners: {
      stdout: (d: Buffer) => (stdout += d.toString()),
      stderr: (d: Buffer) => (stderr += d.toString()),
    },
  });
  return { code, stdout, stderr };
}

// exitReason describes a failed run: the exit code, then what the CLI said went
// wrong. The exit code alone sends the reader scrolling back through the log for
// a line that belongs in the error.
export function exitReason(r: Result): string {
  const why = reason(r.stderr);
  return `exit code ${r.code}${why === "" ? "" : `: ${why}`}`;
}

// reason picks out of the CLI's stderr the part that says what went wrong. The
// CLI reports an error as a line starting `Error:`; with none, the last few
// lines are the likeliest to matter. It is capped because it becomes the
// step's annotation, and a wall of text there hides the point.
const maxReasonLines = 5;
const maxReasonChars = 1000;

export function reason(stderr: string): string {
  const all = stderr
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== "");
  const errors = all.filter((l) => l.startsWith("Error:")).map((l) => l.slice("Error:".length).trim());
  const picked = (errors.length > 0 ? errors : all).slice(-maxReasonLines).join("\n");
  return picked.length > maxReasonChars ? `${picked.slice(0, maxReasonChars)}…` : picked;
}

// tempFile writes content somewhere the CLI can read it, under the runner's
// temporary directory so the runner cleans it up.
export function tempFile(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), "signadot-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}
