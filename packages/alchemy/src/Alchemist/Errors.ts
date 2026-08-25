import * as Data from "effect/Data";

/** A non-fatal note attached to a successful result. */
export interface Diagnostic {
  readonly severity: "debug" | "info" | "warning" | "error";
  readonly code: string;
  readonly message: string;
}

// Tag names are prefixed because the bare ones are already taken by the
// clouds we talk to — distilled's core ships `NotFound`, Route53 ships
// `InvalidInput` — and these errors travel in unions with cloud errors,
// where `catchTag` discriminates by tag alone.

/** The caller sent something the route cannot act on. */
export class AlchemistInvalidInput extends Data.TaggedError(
  "AlchemistInvalidInput",
)<{
  readonly message: string;
  readonly field?: string;
}> {}

/** A named entity (profile, provider) does not resolve. */
export class AlchemistNotFound extends Data.TaggedError("AlchemistNotFound")<{
  readonly kind: string;
  readonly id: string;
}> {}
