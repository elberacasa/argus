// Types for the Argus Protocol v0. The JSON Schema in protocol/argus.schema.json
// is the standard; these mirror it for the implementation, and every request
// is validated against the schema before it reaches code typed by these.

export type LaneKind = "throwaway" | "desk" | "own";
export type LaneId = string;
export type Ref = string;

export interface Viewport { w: number; h: number; mobile?: boolean; scale?: number }

export interface TargetObject { role?: string; name?: string; text?: string; near?: Target; nth?: number }
export type Target = string | TargetObject;

export type ElementStateName =
  | "disabled" | "enabled" | "checked" | "unchecked" | "expanded" | "collapsed" | "selected"
  | "focused" | "required" | "invalid" | "readonly" | "visible" | "hidden";

export interface Expectation {
  within?: string;
  appears?: string | TargetObject;
  disappears?: string | TargetObject;
  url?: { is?: string; matches?: string; changes?: boolean };
  field?: [Target, string];
  state?: [Target, ElementStateName];
  count?: [Target, number | { gte?: number; lte?: number }];
  noErrors?: boolean;
  request?: { url: string; method?: string; status?: number };
}

export type Step = { id?: string; expect?: Expectation } & (
  | { open: string }
  | { click: Target }
  | { hover: Target }
  | { type: [Target, string | { secret: string }] }
  | { press: string }
  | { select: [Target, string] }
  | { upload: [Target, ...string[]] }
  | { scroll: Target | { by: { x: number; y: number } } }
  | { dialog: "accept" | "dismiss" | { accept: string } }
  | { viewport: Viewport | "reset" }
  | { wait: Expectation }
);

export type Verb = "open" | "click" | "hover" | "type" | "press" | "select" | "upload" | "scroll" | "dialog" | "viewport" | "wait";

export interface Rect { x: number; y: number; w: number; h: number }

export interface Element {
  ref: Ref;
  role: string;
  name: string;
  bounds?: Rect | null;
  frames?: number[];
  shadow?: "open" | "closed" | null;
  state?: string[];
  reach?: "ok" | "offscreen" | "hidden" | "zero-size" | { blocked: Element };
  selector?: string;
}

export interface FailedCondition { condition: string; actual: unknown }

export interface Observation {
  ms?: number;
  settled?: { quietMs: number; waitedMs: number } | "timeout";
  url?: { from: string; to: string };
  title?: { from: string; to: string };
  added?: string[];
  addedMore?: number;
  removed?: string[];
  removedMore?: number;
  fields?: Array<{ target: string; from?: string; to: string }>;
  dialogs?: Array<{ type: "alert" | "confirm" | "prompt" | "beforeunload"; message: string; answered: "accept" | "dismiss" | "unanswered" }>;
  console?: Array<{ level: "warning" | "error"; text: string; source?: string }>;
  exceptions?: Array<{ message: string; stack?: string }>;
  network?: Array<{ method?: string; url: string; status?: number; ms?: number; error?: string }>;
  rebound?: boolean;
  effect?: "none";
  expect?: { held: boolean; failed?: FailedCondition[] };
}

export type DiagnosisReason =
  | "not-found" | "ambiguous" | "covered" | "disabled" | "hidden" | "offscreen" | "zero-size" | "detached"
  | "expectation-failed" | "timeout" | "navigation-failed" | "dialog-blocked" | "forbidden" | "probe-error";

export interface Diagnosis {
  reason: DiagnosisReason;
  hint: string;
  didYouMean?: Element[];
  candidates?: Element[];
  blocker?: Element;
  why?: "display" | "visibility" | "opacity" | "inert" | "aria-hidden";
  scrollable?: boolean;
  failed?: FailedCondition[];
  waitedMs?: number;
  errorText?: string;
  detail?: string;
}

export interface StepResult {
  i: number;
  id?: string;
  verb: Verb;
  ok: boolean;
  target?: Element;
  match?: "exact" | "ci" | "substring" | "ref";
  observation: Observation;
  diagnosis?: Diagnosis;
}

export interface ActResult { ok: boolean; steps: StepResult[]; ms: number; tokensEst: number }

export const ErrorCode = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  unknownLane: -32001,
  notNegotiated: -32002,
  capabilityMissing: -32003,
  forbidden: -32004,
  browserLost: -32005,
  busy: -32006,
} as const;

export class RpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
  }
}
