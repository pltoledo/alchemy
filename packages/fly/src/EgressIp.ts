import type { IPAssignment as FlyIPAssignment } from "@distilled.cloud/fly-io/machines";
import * as machines from "@distilled.cloud/fly-io/machines";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { listOwnedApps } from "./App.ts";
import type { App } from "./App.ts";
import type { Providers } from "./Providers.ts";
import type { Region } from "./Region.ts";

/**
 * A resource-valued prop: the resource itself, or an Effect that produces
 * it (so `yield* App(...)` and `App(...)` both type-check).
 */
type Ref<T> = T | Effect.Effect<T, never, Providers>;

export interface EgressIpProps {
  /**
   * Fly App whose Machines send traffic from the pair. Accepts a
   * `Fly.App` resource or an Effect that produces one. Changing the App
   * replaces the pair.
   */
  app: Ref<App>;
  /**
   * Region of the pair. Only the App's Machines in this region send
   * traffic from it. Changing it replaces the pair.
   */
  region: Region;
}

export type EgressIp = Resource<
  "Fly.EgressIp",
  EgressIpProps,
  {
    /** Physical Fly App name the pair is allocated on. */
    appName: string;
    /** Region of the pair. */
    region: string;
    /** Static IPv4 the App's Machines in `region` send traffic from. */
    ipv4: string;
    /** Static IPv6 the App's Machines in `region` send traffic from. */
    ipv6: string;
    /** RFC3339 creation timestamp of the IPv4, if the API returned one. */
    createdAt: string | undefined;
  },
  never,
  Providers
>;

const resolveEgressIpProps = (
  props: EgressIpProps | Effect.Effect<EgressIpProps, never, Providers>,
): Effect.Effect<EgressIpProps, never, Providers> =>
  Effect.gen(function* () {
    const resolved = Effect.isEffect(props) ? yield* props : props;
    if (globalThis.__ALCHEMY_RUNTIME__) return resolved;
    const app = Effect.isEffect(resolved.app)
      ? yield* resolved.app as Effect.Effect<App, never, Providers>
      : resolved.app;
    return { ...resolved, app };
  });

const EgressIpResource = Resource<EgressIp>("Fly.EgressIp");

/**
 * A Fly.EgressIp is a pair of static egress addresses, an IPv4 and an
 * IPv6, that an {@link App}'s Machines in one region send their outbound
 * traffic from. Use it when an external service only accepts connections
 * from allowlisted addresses. Without it, a Machine's outbound address
 * can change.
 *
 * The pair is app-scoped: it survives deploys and Machine replacement,
 * and every Machine of the App in `region` uses it. It does not receive
 * traffic; use {@link IpAssignment} for inbound addresses. Fly bills the
 * IPv4 hourly.
 *
 * @see https://fly.io/docs/networking/egress-ips/
 *
 * ### Allocate a pair
 * Allocate the pair in the region the App's Machines run in, and give
 * `ipv4` and `ipv6` to the service that allowlists them.
 *
 * **Example:** Static egress in gru
 * ```typescript
 * export const Egress = Fly.EgressIp("Egress", {
 *   app: Worker,
 *   region: "gru",
 * });
 * ```
 *
 * :::caution[Changing `region` or `app` replaces the pair]
 * A new pair is allocated with new addresses. The old pair is released.
 * :::
 *
 * :::note[Existing Machines pick the pair up within minutes]
 * Fly applies a new pair to Machines that are already running within
 * 5 to 10 minutes. Machines created after the pair use it at once.
 * :::
 *
 * ### Keep the addresses
 * An allowlist entry outlives the stack that wrote it. Retain the pair so
 * that destroying the stack does not release addresses a partner still
 * expects.
 *
 * **Example:** Retain the pair
 * ```typescript
 * export const Egress = Fly.EgressIp("Egress", {
 *   app: Worker,
 *   region: "gru",
 * }).pipe(RemovalPolicy.retain());
 * ```
 *
 * ### Stack outputs
 * **Example:** Return the addresses to allowlist
 * ```typescript
 * export default Alchemy.Stack(
 *   "MyApp",
 *   { providers: Fly.providers(), state: Alchemy.localState() },
 *   Effect.gen(function* () {
 *     const egress = yield* Egress;
 *     return { ipv4: egress.ipv4, ipv6: egress.ipv6 };
 *   }),
 * );
 * ```
 *
 * @resource
 * @product App
 */
export const EgressIp: typeof EgressIpResource = Object.assign(
  (id: string, props: EgressIpProps | Effect.Effect<EgressIpProps, never, Providers>) =>
    EgressIpResource(id, resolveEgressIpProps(props)),
  EgressIpResource,
);

export class EgressIpNotCreated extends Data.TaggedError("Fly.EgressIpNotCreated")<{
  appName: string;
  region: string;
}> {}

export class EgressIpAppMissing extends Data.TaggedError("Fly.EgressIpAppMissing")<{
  region: string;
}> {}

const appNameOf = (value: unknown): string | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as { appName?: unknown; name?: unknown };
  if (typeof rec.appName === "string" && rec.appName.length > 0) {
    return rec.appName;
  }
  if (typeof rec.name === "string" && rec.name.length > 0) {
    return rec.name;
  }
  return undefined;
};

const isV6 = (ip: string) => ip.includes(":");

/** The App's egress addresses. Ingress addresses share the endpoint. */
const listEgress = (appName: string) =>
  machines.listAppIPAssignments({ app_name: appName }).pipe(
    Effect.map((res) =>
      (res.ips ?? []).filter(
        (item) => item.egress === true && item.ip !== undefined && item.ip.length > 0,
      ),
    ),
    Effect.catchTag(["NotFound", "Forbidden"], () => Effect.succeed([] as FlyIPAssignment[])),
  );

interface Pair {
  v4: FlyIPAssignment | undefined;
  v6: FlyIPAssignment | undefined;
}

/**
 * Observe the pair in `region`, preferring the cached addresses. A region
 * holds one pair in practice; Fly does not let a Machine choose between
 * several, so any egress address of the family in the region is the pair.
 */
const observePair = (appName: string, region: string, cached?: { ipv4?: string; ipv6?: string }) =>
  listEgress(appName).pipe(
    Effect.map((ips): Pair => {
      const inRegion = ips.filter((item) => item.region === region);
      const pick = (v6: boolean, ip: string | undefined) => {
        const family = inRegion.filter((item) => isV6(item.ip!) === v6);
        return family.find((item) => item.ip === ip) ?? family[0];
      };
      return { v4: pick(false, cached?.ipv4), v6: pick(true, cached?.ipv6) };
    }),
  );

const isComplete = (pair: Pair) => pair.v4 !== undefined && pair.v6 !== undefined;

const toAttrs = (appName: string, region: string, pair: Pair): EgressIp["Attributes"] => ({
  appName,
  region,
  ipv4: pair.v4?.ip ?? "",
  ipv6: pair.v6?.ip ?? "",
  createdAt: pair.v4?.created_at,
});

const allocate = (
  appName: string,
  region: string,
  type: "egress_pair" | "egress_v4" | "egress_v6",
) =>
  machines
    .createAppIPAssignment({ app_name: appName, type, region })
    .pipe(Effect.catchTag("Conflict", () => Effect.undefined));

const waitUntilGone = (appName: string, ips: readonly string[]) =>
  listEgress(appName).pipe(
    Effect.map((observed) => !observed.some((item) => ips.includes(item.ip!))),
    Effect.repeat({ schedule: Schedule.spaced("1 second"), until: (gone) => gone, times: 8 }),
  );

export const EgressIpProvider = () =>
  Provider.succeed(EgressIp, {
    stables: ["appName", "region"],
    nuke: { dependsOn: ["Fly.App"] },

    diff: Effect.fn(function* ({ news, output }) {
      if (news === undefined || !isResolved(news)) return undefined;
      if (output === undefined) return undefined;
      const appName = appNameOf(news.app);
      const appChanged = appName !== undefined && appName !== output.appName;
      if (appChanged || news.region !== output.region) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const appName = output?.appName ?? appNameOf(olds?.app);
      const region = output?.region ?? olds?.region;
      if (appName === undefined || region === undefined) return undefined;
      const pair = yield* observePair(appName, region, output);
      if (!isComplete(pair)) return undefined;
      return toAttrs(appName, region, pair);
    }),

    list: Effect.fn(function* () {
      const apps = yield* listOwnedApps();
      const rows = yield* Effect.forEach(
        apps,
        (app) =>
          listEgress(app.appName).pipe(
            Effect.map((ips) =>
              [...new Set(ips.map((item) => item.region ?? ""))].map((region) => {
                const inRegion = ips.filter((item) => (item.region ?? "") === region);
                return toAttrs(app.appName, region, {
                  v4: inRegion.find((item) => !isV6(item.ip!)),
                  v6: inRegion.find((item) => isV6(item.ip!)),
                });
              }),
            ),
          ),
        { concurrency: 8 },
      );
      return rows.flat();
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const appName = appNameOf(news.app) ?? output?.appName;
      if (appName === undefined) {
        return yield* new EgressIpAppMissing({ region: news.region });
      }

      // Observe by the cached addresses, then by region.
      let pair = yield* observePair(appName, news.region, output);

      // Ensure both families. A whole pair is one allocation; a half that
      // was released out of band is allocated alone so the other address,
      // which a partner may have allowlisted, is kept.
      if (!isComplete(pair)) {
        if (pair.v4 === undefined && pair.v6 === undefined) {
          yield* allocate(appName, news.region, "egress_pair");
        } else {
          yield* allocate(appName, news.region, pair.v4 === undefined ? "egress_v4" : "egress_v6");
        }
        pair = yield* observePair(appName, news.region, {
          ipv4: pair.v4?.ip,
          ipv6: pair.v6?.ip,
        }).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            until: isComplete,
            times: 8,
          }),
        );
      }

      if (!isComplete(pair)) {
        return yield* new EgressIpNotCreated({ appName, region: news.region });
      }
      return toAttrs(appName, news.region, pair);
    }),

    delete: Effect.fn(function* ({ output }) {
      const ips = [output.ipv4, output.ipv6].filter((ip) => ip.length > 0);
      if (output.appName.length === 0 || ips.length === 0) return;
      for (const ip of ips) {
        yield* machines
          .deleteAppIPAssignment({ app_name: output.appName, ip })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
      }
      yield* waitUntilGone(output.appName, ips);
    }),
  });
