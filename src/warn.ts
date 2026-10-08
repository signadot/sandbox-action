import * as core from "@actions/core";
import { input } from "./inputs";
import type { Route } from "./route";

// Once a document owns the shape of the sandbox, the inputs that describe a shape
// have nowhere to go. Dropping them silently is the failure mode most likely to
// waste an afternoon — a workflow that looks like it sets an image, and doesn't —
// so each one is named.

// shapeInputs describe the sandbox itself, and belong to whichever document owns
// it. None of them may declare a default in action.yml, or "was it set?" stops
// being a question this can answer.
//
// `fork` is absent deliberately: chooseRoute fails the step on it, because it
// answers precisely the question the document answers. These are the additions
// to a fork list, and with no fork list they have nothing to apply to — worth
// naming, not worth failing a workflow over.
const shapeInputs = ["image", "env", "resources", "endpoints"];

// set binds a template's placeholders, so it means nothing without one.
const templateOnlyInputs = ["set"];

export function warnIgnored(route: Route): void {
  if (route !== "template") {
    const ignored = templateOnlyInputs.filter((n) => input(n) !== "");
    if (ignored.length > 0) {
      core.warning(
        `ignoring [${ignored.join(", ")}]: there is no template to bind` +
          (route === "spec" ? " — `spec` is a document already rendered, not a template" : "") +
          ". Set `template-file` to use one.",
      );
    }
  }
  if (route === "inputs") return;

  const ignored = shapeInputs.filter((n) => input(n) !== "");
  if (ignored.length === 0) return;
  const owner = route === "template" ? "`template-file`" : "the `spec` input";
  core.warning(
    `ignoring [${ignored.join(", ")}]: ${owner} owns the shape of this sandbox. ` +
      "Move them into your document, or drop the inputs.",
  );
}
