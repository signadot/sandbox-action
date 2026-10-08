import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { checkNameInput, defaultName, detect, type Env, noContext, providerLabels, suppliedName } from "../src/context";

// What the Action learns about the run from the runner: the variables GitHub
// sets, and the event payload it writes to disk for triggers whose ref does not
// name the pull request.

const sha = "abc1234def5678901234567890abcdef12345678";
const base: Env = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "acme/hotrod", GITHUB_SHA: sha };

let tmp = "";
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "context-test-"));
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// event writes a payload where GITHUB_EVENT_PATH would point, and returns the path.
function event(name: string, payload: unknown): string {
  const file = path.join(tmp, `${name}.json`);
  fs.writeFileSync(file, typeof payload === "string" ? payload : JSON.stringify(payload));
  return file;
}

describe("detect", () => {
  it("reads a pull_request run from its variables", () => {
    const c = detect({ ...base, GITHUB_REF: "refs/pull/42/merge", GITHUB_HEAD_REF: "Feature/New_Thing" });
    assert.deepEqual(c, {
      provider: "github",
      detected: true,
      repo: "acme/hotrod",
      repoSlug: "hotrod",
      pr: "42",
      sha,
      shortSha: "abc1234",
      branchSlug: "feature-new-thing",
    });
    assert.equal(suppliedName("", c), "hotrod-42");
    assert.deepEqual(providerLabels(c), {
      "signadot/github-repo": "acme/hotrod",
      "signadot/github-pull-request": "42",
    });
  });

  it("prefers the ref over the payload when both carry a number", () => {
    const c = detect({
      ...base,
      GITHUB_REF: "refs/pull/42/merge",
      GITHUB_EVENT_PATH: event("both", { pull_request: { number: 7 } }),
    });
    assert.equal(c.pr, "42");
  });

  it("reads the number from the payload on pull_request_target, whose ref is the base branch", () => {
    const c = detect({
      ...base,
      GITHUB_REF: "refs/heads/main",
      GITHUB_EVENT_PATH: event("pull_request_target", { number: 42, pull_request: { number: 42 } }),
    });
    assert.equal(c.pr, "42");
  });

  it("reads the number from the payload on a comment on a pull request, but not on an issue", () => {
    const onPR = event("issue_comment_pr", {
      issue: { number: 42, pull_request: { url: "https://api.github.com/repos/acme/hotrod/pulls/42" } },
      comment: { body: "/sandbox" },
    });
    const onIssue = event("issue_comment_issue", { issue: { number: 43 }, comment: { body: "/sandbox" } });
    assert.equal(detect({ ...base, GITHUB_REF: "refs/heads/main", GITHUB_EVENT_PATH: onPR }).pr, "42");
    // An issue is not a pull request, and a sandbox labelled as one would be
    // correlated to a pull request that does not exist.
    assert.equal(detect({ ...base, GITHUB_REF: "refs/heads/main", GITHUB_EVENT_PATH: onIssue }).pr, "");
  });

  it("finds no pull request on a push, and names the sandbox after the commit", () => {
    const c = detect({
      ...base,
      GITHUB_REF: "refs/heads/main",
      GITHUB_EVENT_PATH: event("push", { ref: "refs/heads/main", after: sha }),
    });
    assert.equal(c.pr, "");
    assert.equal(suppliedName("", c), "hotrod-abc1234");
    // The API refuses one correlation label without the other.
    assert.equal(providerLabels(c), undefined);
  });

  it("treats a missing or unreadable payload as no pull request", () => {
    for (const p of [path.join(tmp, "absent.json"), event("garbled", "{not json"), tmp]) {
      assert.equal(detect({ ...base, GITHUB_EVENT_PATH: p }).pr, "");
    }
  });

  it("finds nothing outside GitHub Actions, whatever else is set", () => {
    assert.deepEqual(detect({ ...base, GITHUB_ACTIONS: "false", GITHUB_REF: "refs/pull/42/merge" }), noContext());
    assert.equal(suppliedName("", detect({})), "");
    assert.equal(suppliedName("my-sandbox", detect({})), "my-sandbox");
  });

  it("keeps a short sha whole", () => {
    assert.equal(detect({ ...base, GITHUB_SHA: "abc12" }).shortSha, "abc12");
  });
});

describe("the name input", () => {
  it("is used exactly as written, however long the derived name would be", () => {
    // Nothing is hashed: the number a house style puts at the end stays there.
    const name = "checkout-service-preview-pr-12";
    assert.equal(suppliedName(name, detect({ ...base, GITHUB_REF: "refs/pull/12/merge" })), name);
  });

  it("is refused, with the rule it breaks, when the API would refuse it", () => {
    const cases: [string, RegExp][] = [
      ["Hotrod-42", /has 'H': write it in lowercase\. The API would fold it to lowercase on create, but a delete/],
      ["hotrod_pr_42", /has '_': only lowercase letters, digits and '-' are allowed/],
      ["hotrod.pr.42", /has '\.'/],
      ["checkout-service-preview-pr-1234", /is 32 characters, and the limit is 30/],
      ["42-hotrod", /must start with a lowercase letter/],
      ["hotrod-", /must not end with '-'/],
      ["hotrod--42", /must not contain '--'/],
      ["---", /has no letters or digits/],
    ];
    for (const [name, want] of cases) {
      assert.throws(
        () => checkNameInput(name),
        (e: Error) => {
          assert.match(e.message, /^the `name` input '/);
          assert.match(e.message, want);
          return true;
        },
      );
    }
    assert.equal(checkNameInput("hotrod-pr-42"), "hotrod-pr-42");
  });
});

describe("the derived name of a repository the slug does not capture", () => {
  const pr = (repo: string, ref = "refs/pull/12/merge") =>
    defaultName(detect({ ...base, GITHUB_REPOSITORY: repo, GITHUB_REF: ref }));

  it("differs between repositories that slugify alike", () => {
    const names = ["acme/foo-bar", "acme/foo.bar", "acme/foo_bar"].map((r) => pr(r));
    assert.equal(names[0], "foo-bar-12");
    assert.match(names[1], /^foo-bar-[0-9a-f]{6}-12$/);
    assert.match(names[2], /^foo-bar-[0-9a-f]{6}-12$/);
    assert.equal(new Set(names).size, 3, names.join(" "));
  });

  it("is stable, keeps the number whole, and fits", () => {
    assert.equal(pr("acme/foo.bar"), pr("acme/foo.bar"));
    const long = pr("acme/platform.payments.authorization.service", "refs/pull/1234/merge");
    assert.ok(long.length <= 30, long);
    assert.match(long, /^platform-payments-[0-9a-f]{6}-1234$/);
    // On a push the short sha takes the number's place.
    assert.match(pr("acme/foo.bar", "refs/heads/main"), /^foo-bar-[0-9a-f]{6}-abc1234$/);
  });

  it("is not changed by case alone, which GitHub does not let two repositories differ by", () => {
    assert.equal(pr("acme/HotRod"), "hotrod-12");
  });
});

describe("the derived name of a repository that starts with a digit", () => {
  const derive = (repo: string, ref = "refs/pull/5/merge") =>
    defaultName(detect({ ...base, GITHUB_REPOSITORY: repo, GITHUB_REF: ref }));

  it("starts with a letter, as the API requires", () => {
    assert.equal(derive("acme/123app"), "r123app-5");
    assert.equal(derive("acme/123app", "refs/heads/main"), "r123app-abc1234");
    // A slug that was changed gets its hash as well as the prefix.
    assert.match(derive("acme/123.app"), /^r123-app-[0-9a-f]{6}-5$/);
    for (const name of [derive("acme/123app"), derive("acme/123.app")]) assert.equal(checkNameInput(name), name);
  });

  it("still fits, with the number whole at the end", () => {
    const name = derive("acme/1234567890-platform-payments-service", "refs/pull/98765/merge");
    assert.ok(name.length <= 30, name);
    assert.match(name, /^r1234567890-[a-z-]*[a-z]-[0-9a-f]{6}-98765$/);
    assert.equal(checkNameInput(name), name);
  });
});
