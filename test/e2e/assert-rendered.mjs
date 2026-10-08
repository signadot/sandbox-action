#!/usr/bin/env node
// Assert things about a rendered sandbox spec read from stdin. Used by the E2E
// workflow, where the spec arrives as a step output and the alternative is a
// pile of grep.
//
//   assert-rendered.mjs --name my-sandbox \
//     --label 'signadot/usage=ci' \
//     --fork route \
//     --path spec.cluster=demo \
//     --absent spec.labels <<< "$RENDERED"

import * as fs from "node:fs";
import { parseArgs } from "node:util";
import yaml from "js-yaml";

const { values: opts } = parseArgs({
  options: {
    name: { type: "string" },
    "name-pattern": { type: "string" },
    label: { type: "string", multiple: true, default: [] },
    fork: { type: "string", multiple: true, default: [] },
    path: { type: "string", multiple: true, default: [] },
    absent: { type: "string", multiple: true, default: [] },
  },
});

const doc = yaml.load(fs.readFileSync(0, "utf8"));
const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

function at(p) {
  return p.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), doc);
}

if (opts.name !== undefined) {
  check(doc?.name === opts.name, `name: got ${JSON.stringify(doc?.name)}, want ${JSON.stringify(opts.name)}`);
}

if (opts["name-pattern"]) {
  const rx = new RegExp(opts["name-pattern"]);
  check(rx.test(doc?.name ?? ""), `name ${JSON.stringify(doc?.name)} does not match ${rx}`);
}

for (const spec of opts.label) {
  const i = spec.indexOf("=");
  const [key, want] = [spec.slice(0, i), spec.slice(i + 1)];
  const got = doc?.spec?.labels?.[key];
  check(got === want, `label ${key}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

const forkNames = (doc?.spec?.forks ?? []).map((f) => f?.forkOf?.name);
for (const want of opts.fork) {
  check(forkNames.includes(want), `no fork of ${JSON.stringify(want)} (got ${forkNames.join(", ")})`);
}

for (const spec of opts.path) {
  const i = spec.indexOf("=");
  const [p, want] = [spec.slice(0, i), spec.slice(i + 1)];
  const got = at(p);
  check(String(got) === want, `${p}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

for (const p of opts.absent) {
  check(at(p) === undefined, `${p}: expected it to be absent, got ${JSON.stringify(at(p))}`);
}

if (failures.length > 0) {
  for (const f of failures) console.error(`::error::${f}`);
  console.error("\n--- rendered spec ---");
  console.error(yaml.dump(doc));
  process.exit(1);
}

console.log("rendered spec matches all assertions");
