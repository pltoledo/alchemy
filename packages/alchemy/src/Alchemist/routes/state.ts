import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as State from "../../State/index.ts";
import { open, type Target } from "../Session.ts";

/** Which store a state request addresses. */
export type StateSource =
  /** `.alchemy/` on this machine, ignoring whatever the project configures. */
  | { readonly backend: "local" }
  /** Whatever the project's entrypoint configures. */
  | ({ readonly backend: "configured" } & Target);

/**
 * Resolve the state service a source addresses. The tree operations
 * (`State.listState`, `State.readState`, `State.deleteState`) take `State`
 * from context — provide the resolved service (or {@link layer}) to run
 * them against the chosen store:
 *
 * ```ts
 * const state = yield* Alchemist.State.store({ backend: "local" });
 * const items = yield* State.listState({ path }).pipe(
 *   Effect.provideService(State.State, Effect.succeed(state)),
 * );
 * ```
 */
export const store = Effect.fn("Alchemist.state.store")(function* (
  source: StateSource,
) {
  if (source.backend === "local") {
    return yield* Effect.provide(
      Effect.flatten(State.State),
      State.localState(),
    );
  }
  const session = yield* open(source);
  return yield* Effect.provide(Effect.flatten(State.State), session.context);
});

/** The chosen store as a `State` layer. */
export const layer = (source: StateSource) =>
  Layer.effect(State.State, Effect.map(store(source), Effect.succeed));
