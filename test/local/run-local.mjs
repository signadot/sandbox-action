#!/usr/bin/env node
// Run the Action locally the way a GitHub runner does: invoke the bundle with
// INPUT_*/GITHUB_* environment and a fake pull_request event, then report the
// outputs it wrote. Dry run by default, so it needs no credentials and creates
// nothing.
//
//   pnpm run run-local                             # dry run, default inputs
//   pnpm run run-local -- --inputs my-inputs.json  # dry run, your inputs
//   pnpm run run-local -- --live                   # really apply
//   pnpm run run-local -- --command template      # the repository-template route
//   pnpm run run-local -- --command delete         # exercise the delete sub-action
//   pnpm run run-local -- --skip-build             # reuse the dist/ already built
//
// In --live mode SIGNADOT_API_KEY (and usually SIGNADOT_ORG) must be exported.
//
// The Action shells out to the signadot CLI, so put the one you want on PATH, or
// point SIGNADOT_CLI_PATH at the directory holding it. That is how to test
// against a CLI built from a branch rather than a release.
//
// This is the fast path — no Docker, sub-second. `pnpm run act` is the faithful
// one: a real container running the real workflow file.

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import yaml from "js-yaml";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

// npm drops the `--` in `npm run run-local -- --live`; pnpm passes it through.
const argv = process.argv.slice(2);
if (argv[0] === "--") argv.shift();

const { values: opts } = parseArgs({
  args: argv,
  options: {
    inputs: { type: "string", default: "test/local/inputs.json" },
    command: { type: "string", default: "apply" },
    live: { type: "boolean", default: false },
    "skip-build": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (opts.help) {
  console.log(
    fs
      .readFileSync(import.meta.filename, "utf8")
      .split("\n")
      .slice(1, 20)
      .join("\n"),
  );
  process.exit(0);
}

// Each front door declares its own inputs, so validate against the right one.
// apply and template share an entrypoint but not an input set.
const ACTION_YML = {
  apply: "action.yml",
  template: "from-template/action.yml",
  delete: "delete/action.yml",
  install: "install-cli/action.yml",
};
const actionYml = ACTION_YML[opts.command];
if (!actionYml) fail(`unknown command '${opts.command}' (${Object.keys(ACTION_YML).join(", ")})`);

const inputsPath = path.resolve(ROOT, opts.inputs);
if (!fs.existsSync(inputsPath)) fail(`no inputs file at ${inputsPath}`);
const inputs = JSON.parse(fs.readFileSync(inputsPath, "utf8"));

if (!opts["skip-build"]) {
  console.log("› building dist/");
  execFileSync("pnpm", ["run", "--silent", "build"], { cwd: ROOT, stdio: "inherit" });
}

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-action-local-"));
const files = {
  output: path.join(workdir, "output.txt"),
  summary: path.join(workdir, "summary.md"),
  event: path.join(workdir, "event.json"),
  temp: path.join(workdir, "runner-temp"),
};
fs.mkdirSync(files.temp);
for (const f of [files.output, files.summary]) fs.writeFileSync(f, "");

// A minimal pull_request payload: enough for the PR number fallback when
// GITHUB_REF does not carry it.
const github = {
  repository: "signadot/hotrod",
  ref: "refs/pull/4242/merge",
  sha: "abc1234def5678901234567890abcdef12345678",
  headRef: "local/harness",
  prNumber: 4242,
  ...(inputs.github ?? {}),
};
fs.writeFileSync(
  files.event,
  JSON.stringify({
    action: "synchronize",
    number: github.prNumber,
    pull_request: { number: github.prNumber, head: { ref: github.headRef, sha: github.sha } },
    repository: { full_name: github.repository },
  }),
);

// The runner fills in every default declared in action.yml, so we do too.
const declared = yaml.load(fs.readFileSync(path.join(ROOT, actionYml), "utf8")).inputs ?? {};
const defaults = {};
for (const [name, spec] of Object.entries(declared)) {
  if (spec?.default !== undefined) defaults[name] = spec.default;
}
for (const name of Object.keys(inputs.inputs ?? {})) {
  if (!(name in declared)) fail(`unknown input '${name}' (not declared in ${actionYml})`);
}

const actionInputs = { ...defaults, ...(inputs.inputs ?? {}) };
if ("dry-run" in declared) actionInputs["dry-run"] = opts.live ? "false" : "true";
if (opts.live) {
  if (!process.env.SIGNADOT_API_KEY) fail("--live needs SIGNADOT_API_KEY in the environment");
  actionInputs["api-key"] = process.env.SIGNADOT_API_KEY;
  if (process.env.SIGNADOT_ORG) actionInputs.org = process.env.SIGNADOT_ORG;
}

const env = {
  ...process.env,
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "pull_request",
  GITHUB_EVENT_PATH: files.event,
  GITHUB_REPOSITORY: github.repository,
  GITHUB_REF: github.ref,
  GITHUB_SHA: github.sha,
  GITHUB_HEAD_REF: github.headRef,
  GITHUB_WORKSPACE: ROOT,
  GITHUB_OUTPUT: files.output,
  GITHUB_STEP_SUMMARY: files.summary,
  RUNNER_TEMP: files.temp,
  RUNNER_OS: process.platform === "darwin" ? "macOS" : "Linux",
};
for (const [k, v] of Object.entries(actionInputs)) {
  env[`INPUT_${k.replace(/ /g, "_").toUpperCase()}`] = String(v);
}

const DIST = {
  apply: "dist/main/index.js",
  template: "dist/from-template/index.js",
  delete: "dist/delete/index.js",
  install: "dist/install/index.js",
};

console.log(`› running ${opts.command} (${opts.live ? "LIVE" : "dry run"})`);
const result = spawnSync("node", [path.join(ROOT, DIST[opts.command])], { env, stdio: "inherit" });

report("outputs", parseCommandFile(files.output));
const summary = fs.readFileSync(files.summary, "utf8");
if (summary.trim()) console.log(`\n── step summary ──\n${summary}`);

console.log(`\n› scratch dir: ${workdir}`);
process.exit(result.status ?? 1);

// GitHub's output file uses the heredoc form:
//   name<<ghadelimiter_<uuid>\n<value>\nghadelimiter_<uuid>
function parseCommandFile(file) {
  const out = {};
  const lines = fs.readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^([^<]+)<<(.+)$/.exec(lines[i]);
    if (!m) continue;
    const [, name, delimiter] = m;
    const value = [];
    for (i++; i < lines.length && lines[i] !== delimiter; i++) value.push(lines[i]);
    out[name] = value.join("\n");
  }
  return out;
}

function report(label, map) {
  const keys = Object.keys(map);
  if (keys.length === 0) return;
  console.log(`\n── ${label} ──`);
  for (const k of keys.sort()) {
    const v = map[k];
    console.log(v.includes("\n") ? `${k}:\n${indent(v)}` : `${k}: ${v}`);
  }
}

function indent(s) {
  return s
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n");
}

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}
