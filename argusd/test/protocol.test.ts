// The protocol schema is the standard; these examples are its executable form.
// Every file in protocol/examples/valid must validate and every file in
// protocol/examples/invalid must not. An example with "result" is also checked
// against the result shape of that method.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";

const root = join(import.meta.dir, "../../protocol");
const schema = JSON.parse(readFileSync(join(root, "argus.schema.json"), "utf8"));
// strictRequired is off: "not required" is how the schema says a key must be absent.
// strictTuples is off: upload is an open tuple, a target followed by one or more paths.
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, strictTuples: false, allowUnionTypes: true });
ajv.addSchema(schema);
const id = schema.$id as string;
// Compile up front: a broken schema must fail loudly, not make every invalid example "pass".
const whole = ajv.getSchema(id)!;

interface Example { about: string; message: { result?: unknown }; result?: string; rejectedAt?: string }

/** Failures as "<JSON pointer> <message>", into the message or, for results, into its result. */
function errors(ex: Example): string[] {
  const out: string[] = [];
  if (ex.result) {
    const shape = ajv.getSchema(`${id}#/$defs/result/${ex.result}`);
    if (!shape) return [`no result schema for ${ex.result}`];
    if (!shape(ex.message.result)) out.push(...shape.errors!.map((e) => `${e.instancePath} ${e.message}`));
  }
  if (!whole(ex.message)) out.push(...whole.errors!.map((e) => `${e.instancePath} ${e.message}`));
  return out;
}

const load = (dir: string) =>
  readdirSync(join(root, "examples", dir)).filter((f) => f.endsWith(".json")).sort()
    .map((f) => [f, JSON.parse(readFileSync(join(root, "examples", dir, f), "utf8")) as Example] as const);

describe("protocol examples that must validate", () => {
  for (const [file, ex] of load("valid")) test(`${file}: ${ex.about}`, () => expect(errors(ex)).toEqual([]));
});

describe("protocol examples that must be rejected", () => {
  // Each names where it must fail, so an example rejected for an unrelated
  // reason (a typo, a schema bug) cannot pass as a correct rejection.
  for (const [file, ex] of load("invalid")) test(`${file}: ${ex.about}`, () => {
    expect(ex.rejectedAt).toBeString();
    expect(errors(ex).some((e) => e.startsWith(`${ex.rejectedAt} `))).toBe(true);
  });
});
