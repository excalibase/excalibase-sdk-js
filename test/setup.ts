// Polyfill fetch for Node environments that don't have it (Node <18).
// Node 18+ has global fetch; undici provides a consistent implementation across versions.
import { fetch, Headers, Request, Response } from "undici";

if (typeof globalThis.fetch === "undefined") {
  // @ts-expect-error — installing undici primitives onto globalThis for tests
  globalThis.fetch = fetch;
  // @ts-expect-error
  globalThis.Headers = Headers;
  // @ts-expect-error
  globalThis.Request = Request;
  // @ts-expect-error
  globalThis.Response = Response;
}
