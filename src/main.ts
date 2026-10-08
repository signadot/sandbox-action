import { apply, runAction } from "./apply";

// Entry point for the root action: render a sandbox spec from the inputs, or from
// the caller's own document, and apply it.
runAction(apply);
