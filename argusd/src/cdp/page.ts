// What the executor, the probe and the Scene need from a page: send a command,
// hear events, navigate, close. A page argusd owns over a pipe and a tab in the
// person's own browser reached through the extension both provide exactly this,
// so everything built on it works the same in either.

import type { EventName, EventParams, Method, Params, Result } from "./pipe";

export interface CdpPage {
  /** The page's main frame id. */
  readonly targetId: string;
  readonly contextId: string | undefined;
  /** Still reachable: its browser runs and the channel to it is open. */
  readonly alive: boolean;
  send<M extends Method>(method: M, params?: Params<M>): Promise<Result<M>>;
  on<E extends EventName>(event: E, listener: (params: EventParams<E>) => void): () => void;
  navigate(url: string, timeoutMs?: number): Promise<{ errorText?: string }>;
  info(): Promise<{ url: string; title: string }>;
  close(): Promise<void>;
}
