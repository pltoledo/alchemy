import * as Fly from "@alchemy.run/fly";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as machines from "@distilled.cloud/fly-io/machines";
import * as Drift from "alchemy/Drift";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { fetchFrom, nginx } from "./fixtures/flycast.ts";

const { test } = Test.make({ providers: Fly.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const tags = [
  "provider:fly",
  "provider:fly:app",
  "provider:fly:egressip",
  "provider:fly:ipassignment",
  "live",
];

const listed = (appName: string) =>
  machines.listAppIPAssignments({ app_name: appName }).pipe(Effect.map((res) => res.ips ?? []));

const listedEgress = (appName: string, ip: string) =>
  listed(appName).pipe(
    Effect.map((ips) => ips.find((item) => item.ip === ip && item.egress === true)),
  );

const waitUntilIpsGone = (appName: string, ips: readonly string[]) =>
  listed(appName).pipe(
    Effect.map((observed) =>
      observed.some((item) => ips.includes(item.ip ?? "")) ? "found" : "gone",
    ),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const waitUntilAppGone = (appName: string) =>
  machines.getApp({ app_name: appName }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "allocate, redeploy, and release an egress pair",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = Effect.gen(function* () {
        const app = yield* Fly.App("EgressApp");
        const egress = yield* Fly.EgressIp("Egress", { app, region: "iad" });
        return { app, egress };
      });

      const created = yield* stack.deploy(program);
      expect(created.egress.appName).toEqual(created.app.appName);
      expect(created.egress.region).toEqual("iad");
      expect(created.egress.ipv4).not.toContain(":");
      expect(created.egress.ipv4.length).toBeGreaterThan(0);
      expect(created.egress.ipv6).toContain(":");

      const v4 = yield* listedEgress(created.app.appName, created.egress.ipv4);
      const v6 = yield* listedEgress(created.app.appName, created.egress.ipv6);
      expect(v4?.region).toEqual("iad");
      expect(v6?.region).toEqual("iad");

      const redeployed = yield* stack.deploy(program);
      expect(redeployed.egress.ipv4).toEqual(created.egress.ipv4);
      expect(redeployed.egress.ipv6).toEqual(created.egress.ipv6);

      const provider = yield* Provider.findProvider(Fly.EgressIp);
      const rows = yield* provider.list();
      const row = rows.find((item) => item.ipv4 === created.egress.ipv4);
      expect(row?.appName).toEqual(created.app.appName);
      expect(row?.region).toEqual("iad");
      expect(row?.ipv6).toEqual(created.egress.ipv6);

      yield* stack.destroy();

      const ips = [created.egress.ipv4, created.egress.ipv6];
      expect(yield* waitUntilIpsGone(created.app.appName, ips)).toEqual("gone");
      expect(yield* waitUntilAppGone(created.app.appName)).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 120_000 },
);

test.provider(
  "changing region replaces the pair",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("EgressRegionApp");
          const egress = yield* Fly.EgressIp("Egress", { app, region: "iad" });
          return { app, egress };
        }),
      );

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("EgressRegionApp");
          const egress = yield* Fly.EgressIp("Egress", { app, region: "ord" });
          return { app, egress };
        }),
      );

      expect(replaced.egress.region).toEqual("ord");
      expect(replaced.egress.ipv4).not.toEqual(created.egress.ipv4);
      expect(replaced.egress.ipv6).not.toEqual(created.egress.ipv6);
      expect((yield* listedEgress(replaced.app.appName, replaced.egress.ipv4))?.region).toEqual(
        "ord",
      );

      const oldIps = [created.egress.ipv4, created.egress.ipv6];
      expect(yield* waitUntilIpsGone(created.app.appName, oldIps)).toEqual("gone");

      yield* stack.destroy();

      const newIps = [replaced.egress.ipv4, replaced.egress.ipv6];
      expect(yield* waitUntilIpsGone(replaced.app.appName, newIps)).toEqual("gone");
      expect(yield* waitUntilAppGone(replaced.app.appName)).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 120_000 },
);

test.provider(
  "drift repair allocates a half released out of band and keeps the other",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = Effect.gen(function* () {
        const app = yield* Fly.App("EgressRepairApp");
        const egress = yield* Fly.EgressIp("Egress", { app, region: "iad" });
        return { app, egress };
      });

      const created = yield* stack.deploy(program);

      yield* machines.deleteAppIPAssignment({
        app_name: created.app.appName,
        ip: created.egress.ipv6,
      });
      expect(yield* waitUntilIpsGone(created.app.appName, [created.egress.ipv6])).toEqual("gone");

      const detected = yield* Drift.detect({ name: stack.name, stage: stack.stage });
      expect(detected.resources.Egress?.action).toEqual("missing");

      const repaired = yield* Drift.repair({ name: stack.name, stage: stack.stage });
      expect(repaired.resources.Egress?.action).toEqual("recreated");
      const attrs = repaired.resources.Egress?.attr as Fly.EgressIp["Attributes"];
      expect(attrs.ipv4).toEqual(created.egress.ipv4);
      expect(attrs.ipv6).toContain(":");
      expect((yield* listedEgress(created.app.appName, attrs.ipv6))?.region).toEqual("iad");

      const redeployed = yield* stack.deploy(program);
      expect(redeployed.egress.ipv4).toEqual(created.egress.ipv4);
      expect(redeployed.egress.ipv6).toEqual(attrs.ipv6);

      yield* stack.destroy();

      const ips = [attrs.ipv4, attrs.ipv6];
      expect(yield* waitUntilIpsGone(created.app.appName, ips)).toEqual("gone");
      expect(yield* waitUntilAppGone(created.app.appName)).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 120_000 },
);

test.provider(
  "an egress pair is not adopted as an IP assignment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("EgressIngressApp");
          const egress = yield* Fly.EgressIp("Egress", { app, region: "iad" });
          // Allocated after the pair, so an egress v6 is already listed.
          const ip = yield* Fly.IpAssignment("Public", {
            app,
            type: "v6",
            region: egress.region,
          });
          return { app, egress, ip };
        }),
      );

      expect(deployed.ip.ip).not.toEqual(deployed.egress.ipv6);
      const ingress = (yield* listed(deployed.app.appName)).find(
        (item) => item.ip === deployed.ip.ip,
      );
      expect(ingress?.egress).not.toEqual(true);

      const assignments = yield* (yield* Provider.findProvider(Fly.IpAssignment)).list();
      expect(assignments.some((row) => row.ip === deployed.egress.ipv4)).toEqual(false);
      expect(assignments.some((row) => row.ip === deployed.egress.ipv6)).toEqual(false);

      yield* stack.destroy();

      const ips = [deployed.ip.ip, deployed.egress.ipv4, deployed.egress.ipv6];
      expect(yield* waitUntilIpsGone(deployed.app.appName, ips)).toEqual("gone");
      expect(yield* waitUntilAppGone(deployed.app.appName)).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 120_000 },
);

test.provider(
  "a Machine in the region sends traffic from the pair",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("EgressMachineApp");
          const egress = yield* Fly.EgressIp("Egress", { app, region: "iad" });
          // The env var orders the Machine after the pair: a Machine created
          // after the pair egresses from it at once.
          const machine = yield* Fly.Machine("Caller", {
            app,
            ...nginx,
            env: { EGRESS_IPV4: egress.ipv4 },
          });
          return { app, egress, machine };
        }),
      );

      const seen = yield* fetchFrom(deployed.machine, "http://api.ipify.org", deployed.egress.ipv4);
      expect(seen.trim()).toEqual(deployed.egress.ipv4);

      yield* stack.destroy();

      const ips = [deployed.egress.ipv4, deployed.egress.ipv6];
      expect(yield* waitUntilIpsGone(deployed.app.appName, ips)).toEqual("gone");
      expect(yield* waitUntilAppGone(deployed.app.appName)).toEqual("gone");
    }).pipe(logLevel),
  { tags: [...tags, "provider:fly:machine"], timeout: 180_000 },
);
