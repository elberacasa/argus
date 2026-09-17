// Every request is checked against the published schema before any code sees
// it, so argusd and the standard cannot drift apart silently: a request the
// schema rejects never runs, and (in tests) a result the schema rejects fails.

import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import schema from "../../../protocol/argus.schema.json" with { type: "json" };

const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, strictTuples: false, allowUnionTypes: true });
ajv.addSchema(schema);
const id = (schema as { $id: string }).$id;

const request = ajv.getSchema(id + "#/$defs/Request")!;
const cache = new Map<string, ValidateFunction | null>();

const fragment = (pointer: string): ValidateFunction | null => {
  if (!cache.has(pointer)) {
    try { cache.set(pointer, ajv.getSchema(id + pointer) ?? null); } catch { cache.set(pointer, null); }
  }
  return cache.get(pointer)!;
};

/** The verbs a step may use, from the schema itself, so this cannot drift. */
const STEP_VERBS: string[] = ((schema as { $defs: { Step: { oneOf: Array<{ required: string[] }> } } }).$defs.Step.oneOf ?? [])
  .flatMap((branch) => branch.required ?? []);

const at = (data: unknown, pointer: string): unknown =>
  pointer.split("/").filter(Boolean).reduce<unknown>((v, key) => (v == null ? v : (v as Record<string, unknown>)[key]), data);

const format = (v: ValidateFunction, data?: unknown) => {
  const errors = v.errors ?? [];
  // A step that names no verb fails every branch of the union at once, and the
  // first few read as if open/click/hover were the whole list. Say what a step
  // may be, once.
  const stepPath = errors.find((e) => /^\/params\/steps\/\d+$/.test(e.instancePath) && e.keyword === "required")?.instancePath;
  if (stepPath) {
    const step = at(data, stepPath);
    const keys = step && typeof step === "object" ? Object.keys(step as object).filter((k) => k !== "id" && k !== "expect") : [];
    const named = keys.filter((k) => !STEP_VERBS.includes(k));
    const what = named.length ? `has no verb argus knows (${named.map((k) => `"${k}"`).join(", ")})` : "names no verb";
    return `${stepPath} ${what}; a step is one of: ${STEP_VERBS.join(", ")}`;
  }
  return errors.slice(0, 4).map((e) => `${e.instancePath || "request"} ${e.message}`).join("; ");
};

/** null when valid, otherwise a readable reason. */
export function checkRequest(message: unknown): string | null {
  if (request(message)) return null;
  return format(request, message);
}

/** Validate a result against the schema's result shape for a method, when one exists. */
export function checkResult(method: string, result: unknown): string | null {
  const v = fragment(`#/$defs/result/${method}`);
  if (!v || v(result)) return null;
  return format(v);
}
