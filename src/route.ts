import { type CIContext, resolveName } from "./context";
import { type Doc, isDoc, kindOf, pruneNulls, spec as specOf } from "./doc";
import { input } from "./inputs";
import { type Options, stampLabels, ttlOf } from "./spec";

// Where the shape of the sandbox comes from. The Action supplies identity and
// lifecycle, though a document that states either one wins; this decides who owns
// the shape.
export type Route = "inputs" | "template" | "spec";

// chooseRoute reads that decision off the inputs. `fork` describes a shape, so
// it cannot be combined with a document that already has one: that would leave
// two answers to the same question.
//
// templateRequired is set by the from-template entry point. Its action.yml
// declares template-file `required: true`, which the runner does not enforce,
// and without the check a step that forgot it would fall through to the flat
// inputs and be asked for `fork`, an input from-template does not declare.
export function chooseRoute(templateRequired = false): Route {
  const template = input("template-file");
  const spec = input("spec");
  if (templateRequired && template === "") {
    throw new Error("`template-file` is required: from-template renders the sandbox from your template");
  }
  if (template !== "" && spec !== "") {
    throw new Error("`template-file` and `spec` are mutually exclusive");
  }
  if ((template !== "" || spec !== "") && input("fork") !== "") {
    throw new Error(
      "`fork` says which workloads to fork, but " +
        `\`${template !== "" ? "template-file" : "spec"}\` already does: remove one`,
    );
  }
  if (template !== "") return "template";
  if (spec !== "") return "spec";
  return "inputs";
}

// overlay is what the Action contributes to a document it did not write.
//
// The precedence is worth stating once: an explicit `name` input wins over the
// document, because overriding the name is the only reason to set it; `cluster`
// wins because which cluster a workflow targets is the workflow's business;
// `description` and `ttl` defer to the document, because a value written there
// was chosen deliberately; and labels merge, so the Action's can be added
// without displacing anyone's own.
export function overlay(doc: Doc, opts: Options, ctx: CIContext): Doc {
  doc.name = resolveName(ownName(doc), opts.name, ctx);

  const sp = specOf(doc);
  if (opts.cluster !== "") sp.cluster = opts.cluster;
  // A null is a field the document left out rather than one it chose to empty:
  // it is what a template renders for a placeholder bound to nothing, and it is
  // pruned below, so deferring to it would drop the workflow's value too.
  if (opts.description !== "" && sp.description == null) sp.description = opts.description;
  if (sp.ttl == null) {
    const ttl = ttlOf(opts);
    if (ttl) sp.ttl = ttl;
  }

  const own = ownLabels(sp);
  sp.labels = { ...stampLabels(opts, ctx, own), ...own };

  return pruneNulls(doc) as Doc;
}

// ownName and ownLabels read what the document says, where null is what a
// template renders for a key it left empty — the labels mapping or any one label
// in it. Anything else of the wrong type is refused: dropping it for what the
// Action derives would put the sandbox under another name, or without the
// author's labels, and nothing would say why.
function ownName(doc: Doc): string {
  if (doc.name == null) return "";
  if (typeof doc.name !== "string") {
    throw new Error(`your document's name must be a string, got ${kindOf(doc.name)}`);
  }
  return doc.name;
}

function ownLabels(sp: Doc): Doc {
  if (sp.labels == null) return {};
  if (!isDoc(sp.labels)) {
    throw new Error(`your document's spec.labels must be a mapping, got ${kindOf(sp.labels)}`);
  }
  return Object.fromEntries(Object.entries(sp.labels).filter(([, v]) => v != null));
}
