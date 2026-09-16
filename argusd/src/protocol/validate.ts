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

const format = (v: ValidateFunction) =>
  (v.errors ?? []).slice(0, 4).map((e) => `${e.instancePath || "request"} ${e.message}`).join("; ");

/** null when valid, otherwise a readable reason. */
export function checkRequest(message: unknown): string | null {
  if (request(message)) return null;
  return format(request);
}

/** Validate a result against the schema's result shape for a method, when one exists. */
export function checkResult(method: string, result: unknown): string | null {
  const v = fragment(`#/$defs/result/${method}`);
  if (!v || v(result)) return null;
  return format(v);
}
