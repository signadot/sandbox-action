import { apply, defaultRuntime, runAction } from "./apply";

// Entry point for from-template: the root action, except that it requires the
// template its name promises.
runAction(() => apply(defaultRuntime(), { templateRequired: true }));
