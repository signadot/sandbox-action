import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { version } from "../package.json";
import {
  CLIENT_CONTEXT_HEADER,
  ensureCli,
  lookPath,
  parseChecksums,
  reason,
  resetClientContext,
  resolveVersion,
  run,
  tryRun,
} from "../src/cli";
import { fakeExec } from "./harness";

// Everything between the Action and the signadot binary: finding or installing
// it, and running it. The network and the binary are faked; what is under test
// is what the Action makes of their answers.

const cli = { path: "/opt/signadot", version: "v1.2.3" };

describe("resolveVersion", () => {
  const never: typeof fetch = async () => {
    throw new Error("a pinned version must not touch the network");
  };

  it("takes a pinned version as it is, with or without the v", async () => {
    assert.equal(await resolveVersion("1.2.3", never), "v1.2.3");
    assert.equal(await resolveVersion("v1.2.3", never), "v1.2.3");
    assert.equal(await resolveVersion("  v1.2.3 \n", never), "v1.2.3");
  });

  it("resolves latest, or nothing, from the redirect github.com serves", async () => {
    const seen: RequestInit[] = [];
    const redirect: typeof fetch = async (_url, init) => {
      seen.push(init ?? {});
      return new Response(null, {
        status: 302,
        headers: { location: "https://github.com/signadot/cli/releases/tag/v1.4.0" },
      });
    };
    assert.equal(await resolveVersion("latest", redirect), "v1.4.0");
    assert.equal(await resolveVersion("", redirect), "v1.4.0");
    // Following the redirect would fetch the release page for nothing.
    assert.equal(seen[0].redirect, "manual");
  });

  it("says what came back when the redirect is not to a tag", async () => {
    const elsewhere: typeof fetch = async () =>
      new Response(null, { status: 302, headers: { location: "https://github.com/login" } });
    await assert.rejects(resolveVersion("latest", elsewhere), /unexpected redirect 'https:\/\/github.com\/login'/);
  });
});

describe("parseChecksums", () => {
  it("reads sha256sum output in text and binary mode, and CRLF line ends", () => {
    const text = [
      "aaa  signadot-cli_linux_amd64.tar.gz",
      "bbb *signadot-cli_darwin_arm64.tar.gz\r",
      "",
      "not a checksum line at all",
    ].join("\n");
    assert.deepEqual(parseChecksums(text, "v1"), {
      "signadot-cli_linux_amd64.tar.gz": "aaa",
      "signadot-cli_darwin_arm64.tar.gz": "bbb",
    });
  });

  it("refuses a file with nothing in it, rather than failing later on a missing asset", () => {
    assert.throws(() => parseChecksums("", "v1.2.3"), /checksums.txt for v1.2.3 is empty or unparseable/);
    assert.throws(() => parseChecksums("NotFound\n", "v1"), /empty or unparseable/);
  });
});

describe("lookPath", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "signadot-lookpath-"));
  const onPath = path.join(tmp, "bin");
  const override = path.join(tmp, "override");
  for (const dir of [onPath, override]) {
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "signadot"), "");
  }

  it("finds signadot on PATH", () => {
    assert.equal(lookPath({ PATH: ["/nonexistent", onPath].join(path.delimiter) }), path.join(onPath, "signadot"));
  });

  it("looks in SIGNADOT_CLI_PATH first, as a directory or as the binary itself", () => {
    assert.equal(lookPath({ PATH: onPath, SIGNADOT_CLI_PATH: override }), path.join(override, "signadot"));
    const binary = path.join(override, "signadot");
    assert.equal(lookPath({ PATH: onPath, SIGNADOT_CLI_PATH: binary }), binary);
  });

  it("finds nothing where there is nothing, and does not mistake a directory for the binary", () => {
    assert.equal(lookPath({}), undefined);
    assert.equal(lookPath({ PATH: tmp }), undefined);
    fs.mkdirSync(path.join(tmp, "signadot"));
    assert.equal(lookPath({ PATH: tmp }), undefined);
  });
});

describe("ensureCli", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "signadot-ensure-"));
  const onPath = path.join(dir, "signadot");
  fs.writeFileSync(onPath, "");
  const own = fs.mkdtempSync(path.join(os.tmpdir(), "signadot-own-"));
  fs.writeFileSync(path.join(own, "signadot"), "");

  // fakeInstall records what would have been installed.
  function fakeInstall() {
    const installed: string[] = [];
    const install = async (version: string) => {
      installed.push(version);
      return { path: `/cache/${version}/signadot`, version };
    };
    return { installed, install };
  }
  const nothingCached = () => undefined;

  it("with latest, uses a CLI on PATH, and installs only when there is none", async () => {
    for (const version of ["latest", ""]) {
      const f = fakeInstall();
      assert.deepEqual(await ensureCli(version, { PATH: dir }, nothingCached, f.install), {
        path: onPath,
        version: "",
      });
      assert.deepEqual(f.installed, [], version);
    }
    const f = fakeInstall();
    await ensureCli("latest", { PATH: "/nowhere" }, nothingCached, f.install);
    assert.deepEqual(f.installed, ["latest"]);
  });

  it("with a pinned version, installs that version even when a signadot is on PATH", async () => {
    for (const version of ["v1.9.0", "1.9.0"]) {
      const f = fakeInstall();
      const got = await ensureCli(version, { PATH: dir }, nothingCached, f.install);
      assert.deepEqual(got, { path: "/cache/v1.9.0/signadot", version: "v1.9.0" }, version);
      assert.deepEqual(f.installed, ["v1.9.0"], version);
    }
  });

  it("reuses a pinned version an earlier step already installed", async () => {
    const f = fakeInstall();
    const got = await ensureCli(
      "v1.9.0",
      { PATH: dir },
      (tag) => (tag === "v1.9.0" ? "/tc/1.9.0/signadot" : undefined),
      f.install,
    );
    assert.deepEqual(got, { path: "/tc/1.9.0/signadot", version: "v1.9.0" });
    assert.deepEqual(f.installed, []);
  });

  it("uses exactly the CLI SIGNADOT_CLI_PATH names, over a pin and over PATH", async () => {
    for (const version of ["v1.9.0", "latest"]) {
      const f = fakeInstall();
      const got = await ensureCli(version, { PATH: dir, SIGNADOT_CLI_PATH: own }, nothingCached, f.install);
      assert.deepEqual(got, { path: path.join(own, "signadot"), version: "" }, version);
      assert.deepEqual(f.installed, [], version);
    }
  });
});

describe("tryRun", () => {
  it("passes credentials in the environment and never in argv", async () => {
    const fake = fakeExec(() => ({ stdout: "out" }));
    const r = await tryRun(cli, { apiKey: "sk-secret", org: "acme" }, ["sandbox", "list"], {
      env: { PATH: "/usr/bin" },
      exec: fake.exec,
    });
    assert.deepEqual(r, { code: 0, stdout: "out", stderr: "" });
    const [call] = fake.calls;
    assert.equal(call.command, "/opt/signadot");
    assert.deepEqual(call.args, ["sandbox", "list"]);
    assert.equal(call.env.SIGNADOT_API_KEY, "sk-secret");
    assert.equal(call.env.SIGNADOT_ORG, "acme");
    assert.equal(call.env.PATH, "/usr/bin");
    assert.ok(!call.args.some((a) => a.includes("sk-secret")));
  });

  it("leaves an inherited key alone when the input is empty", async () => {
    const fake = fakeExec(() => ({}));
    await tryRun(cli, { apiKey: "", org: "" }, ["version"], {
      env: { SIGNADOT_API_KEY: "from-env" },
      exec: fake.exec,
    });
    assert.equal(fake.calls[0].env.SIGNADOT_API_KEY, "from-env");
    assert.equal(fake.calls[0].env.SIGNADOT_ORG, undefined);
  });

  it("returns stdout on failure, for a caller that needs what was printed", async () => {
    const fake = fakeExec(() => ({ code: 3, stdout: '{"name":"x"}' }));
    const r = await tryRun(cli, { apiKey: "", org: "" }, ["sandbox", "apply"], { env: {}, exec: fake.exec });
    assert.equal(r.code, 3);
    assert.equal(r.stdout, '{"name":"x"}');
  });
});

describe("run", () => {
  const auth = { apiKey: "", org: "" };

  it("returns stdout on success", async () => {
    const fake = fakeExec(() => ({ stdout: "name: x\n" }));
    assert.equal(await run(cli, auth, ["sandbox", "get", "x"], { env: {}, exec: fake.exec }), "name: x\n");
  });

  it("names the command and the exit code on failure", async () => {
    const fake = fakeExec(() => ({ code: 1 }));
    await assert.rejects(
      run(cli, auth, ["sandbox", "get", "x"], { env: {}, exec: fake.exec }),
      /^Error: signadot sandbox get x failed with exit code 1$/,
    );
  });

  it("says why, from what the CLI printed to stderr", async () => {
    const fake = fakeExec(() => ({ code: 1, stderr: 'Error: sandbox "x" not found\n' }));
    await assert.rejects(
      run(cli, auth, ["sandbox", "get", "x"], { env: {}, exec: fake.exec }),
      /^Error: signadot sandbox get x failed with exit code 1: sandbox "x" not found$/,
    );
  });
});

describe("a CLI that predates --dry-run or --no-template", () => {
  const auth = { apiKey: "", org: "" };
  const args = ["sandbox", "apply", "-f", "sandbox.yaml", "--dry-run=client"];
  // What a CLI without the flag actually prints, and exits 1 with.
  const old = fakeExec(() => ({ code: 1, stderr: "Error: unknown flag: --dry-run\n" }));

  it("is told to set cli-version when the Action installed it", async () => {
    await assert.rejects(
      run(cli, auth, args, { env: {}, exec: old.exec }),
      /^Error: signadot v1\.2\.3 does not support `sandbox apply --dry-run`.*Set `cli-version` to v1\.9\.0 or later$/,
    );
  });

  it("is told to upgrade the one on PATH when that is what ran", async () => {
    await assert.rejects(
      run({ path: "/usr/local/bin/signadot", version: "" }, auth, args, { env: {}, exec: old.exec }),
      /^Error: the signadot CLI found on PATH at \/usr\/local\/bin\/signadot does not support `sandbox apply --dry-run`.*Upgrade it/,
    );
  });

  it("is recognised for --no-template too, in a CLI that has --dry-run", async () => {
    const noTemplate = fakeExec(() => ({ code: 1, stderr: "Error: unknown flag: --no-template\n" }));
    await assert.rejects(
      run(cli, auth, [...args, "--no-template"], { env: {}, exec: noTemplate.exec }),
      /^Error: signadot v1\.2\.3 does not support `sandbox apply --no-template`.*Set `cli-version` to v1\.9\.0 or later$/,
    );
  });

  it("is not suspected for any other failure", async () => {
    const other = fakeExec(() => ({ code: 1, stderr: "Error: unknown flag: --dry-run-please\n" }));
    await assert.rejects(
      run(cli, auth, args, { env: {}, exec: other.exec }),
      /failed with exit code 1: unknown flag: --dry-run-please$/,
    );
    // A call that did not pass the flag cannot have been refused for it.
    await assert.rejects(
      run(cli, auth, ["sandbox", "delete", "x"], { env: {}, exec: old.exec }),
      /failed with exit code 1/,
    );
  });
});

describe("reason", () => {
  it("prefers the lines the CLI marks as errors", () => {
    const stderr =
      "Waiting for sandbox...\nError: timed out waiting for sandbox to be ready\n\nUsage:\n  signadot sandbox apply [flags]\n";
    assert.equal(reason(stderr), "timed out waiting for sandbox to be ready");
  });

  it("falls back to the last few lines when none is marked", () => {
    const stderr = `${Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n")}\n\n`;
    assert.equal(reason(stderr), "line 7\nline 8\nline 9\nline 10\nline 11");
  });

  it("is empty for an empty stderr, and bounded for a huge one", () => {
    assert.equal(reason(""), "");
    assert.equal(reason("  \n\n"), "");
    const long = reason(`Error: ${"x".repeat(5000)}`);
    assert.equal(long.length, 1001);
    assert.ok(long.endsWith("…"));
  });
});

describe("client context", () => {
  const cli = { path: "/usr/local/bin/signadot", version: "v1.9.0" };
  const auth = { apiKey: "k", org: "o" };
  const refused = { code: 1, stderr: "Error: unknown flag: --header\n" };

  it("says who is calling on every run, through --header", async () => {
    resetClientContext();
    const fake = fakeExec(() => ({}));
    await run(cli, auth, ["sandbox", "list"], { env: {}, exec: fake.exec });
    await run(cli, auth, ["sandbox", "get", "x"], { env: {}, exec: fake.exec });
    assert.equal(fake.calls.length, 2);
    for (const c of fake.calls) {
      assert.equal(c.argv[0], "--header");
      assert.equal(c.header, `${CLIENT_CONTEXT_HEADER}: integration=sandbox-action,integration-version=${version}`);
    }
  });

  it("retries once without --header on a CLI that refuses it, and stops sending it", async () => {
    resetClientContext();
    const fake = fakeExec((args) => (args[0] === "--header" ? refused : { stdout: "ok" }));
    const out = await run(cli, auth, ["sandbox", "list"], { env: {}, exec: fake.exec });
    assert.equal(out, "ok");
    assert.deepEqual(
      fake.calls.map((c) => c.header !== undefined),
      [true, false],
    );
    await run(cli, auth, ["sandbox", "get", "x"], { env: {}, exec: fake.exec });
    assert.equal(fake.calls.length, 3);
    assert.equal(fake.calls[2].header, undefined);
  });

  it("does not retry a command that failed for any other reason", async () => {
    resetClientContext();
    const fake = fakeExec(() => ({ code: 1, stderr: "Error: unknown flag: --headers-only\n" }));
    await assert.rejects(run(cli, auth, ["sandbox", "list"], { env: {}, exec: fake.exec }));
    assert.equal(fake.calls.length, 1);
    assert.ok(fake.calls[0].header !== undefined);
  });
});
