import * as fs from "node:fs";
import * as path from "node:path";
import type { Exec } from "../src/cli";

// Inputs reach an Action as INPUT_* variables, so a test that exercises the input
// surface has to install them the way the runner does. Only spaces become
// underscores, which is why `template-file` arrives as INPUT_TEMPLATE-FILE.

export function withInputs<T>(inputs: Record<string, string>, fn: () => T): T {
  const installed = Object.keys(inputs).map((k) => `INPUT_${k.replace(/ /g, "_").toUpperCase()}`);
  Object.values(inputs).forEach((v, i) => {
    process.env[installed[i]] = v;
  });
  try {
    return fn();
  } finally {
    for (const name of installed) delete process.env[name];
  }
}

// fixtureDir locates test data by walking up from wherever this file ended up:
// the tests run compiled, out of .test-build, so a path relative to __dirname
// would only work in one of the two layouts.
export function fixtureDir(...parts: string[]): string {
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, "test", "testdata", ...parts);
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error(`cannot find test/testdata/${parts.join("/")} above ${__dirname}`);
}

// withInputsAsync is withInputs for a function that returns a promise: the
// inputs have to stay installed until it settles, not until it returns.
export async function withInputsAsync<T>(inputs: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const installed = Object.keys(inputs).map((k) => `INPUT_${k.replace(/ /g, "_").toUpperCase()}`);
  Object.values(inputs).forEach((v, i) => {
    process.env[installed[i]] = v;
  });
  try {
    return await fn();
  } finally {
    for (const name of installed) delete process.env[name];
  }
}

// A FakeCall is one run of the CLI as the code under test asked for it. `args`
// is the command itself: the --header pair the runner puts in front of every
// call is split off into `header`, so tests about a command need not repeat it.
// `argv` is everything, as the CLI received it.
export interface FakeCall {
  command: string;
  args: string[];
  argv: string[];
  header?: string;
  env: Record<string, string>;
}

export interface FakeResult {
  code?: number;
  stdout?: string;
  stderr?: string;
}

// fakeExec stands in for @actions/exec. Each call is recorded and answered by
// respond, which sees the arguments and says what the CLI would have printed.
export function fakeExec(respond: (args: string[]) => FakeResult): {
  exec: Exec;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  const exec: Exec = async (command, args, options) => {
    const header = args[0] === "--header" ? args[1] : undefined;
    const rest = header === undefined ? args : args.slice(2);
    calls.push({ command, args: rest, argv: args, header, env: { ...(options.env ?? {}) } });
    const r = respond(args);
    if (r.stdout) options.listeners?.stdout?.(Buffer.from(r.stdout));
    if (r.stderr) options.listeners?.stderr?.(Buffer.from(r.stderr));
    return r.code ?? 0;
  };
  return { exec, calls };
}

// captureStdout collects what fn writes to stdout while it runs, which is where
// @actions/core sends warnings and notices as ::warning:: workflow commands.
// Everything is still passed through: under `node --test` the runner reports
// results over the same stream, and swallowing it loses them.
export async function captureStdout(fn: () => Promise<unknown>): Promise<string> {
  const write = process.stdout.write;
  let out = "";
  process.stdout.write = function (this: NodeJS.WriteStream, chunk: string | Uint8Array, ...rest: unknown[]) {
    out += chunk.toString();
    return (write as (...a: unknown[]) => boolean).call(this, chunk, ...rest);
  } as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = write;
  }
  return out;
}
