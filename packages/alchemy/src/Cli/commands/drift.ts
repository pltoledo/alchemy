import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";

import * as Drift from "../../Alchemist/routes/drift.ts";
import { Cli } from "../../Report.ts";
import * as CliKit from "../CliKit/index.ts";

import { config, envFile, profile, stage } from "./flags.ts";
import { instrumentCommand } from "./instrument.ts";
import { renderApply, renderPlanning } from "./render.ts";

const repairFlag = Flag.boolean("repair").pipe(
  Flag.withDescription("Repair detected drift without prompting"),
  Flag.withDefault(false),
);

interface SyncArgs {
  main: string;
  stage: string;
  envFile: Option.Option<string>;
  profile?: string;
  repair?: boolean;
}

const routeDrift = Effect.fn(function* ({
  main,
  stage,
  envFile,
  profile,
  repair = false,
}: SyncArgs) {
  const cli = yield* Cli;
  const snapshot = yield* Drift.inspect({
    entrypoint: main,
    stage,
    profile,
    envFile: Option.getOrUndefined(envFile),
  }).pipe(
    renderPlanning({
      operation: "Drift",
      stage,
      computingLabel: "Checking drift",
      readyLabel: "Drift check complete",
    }),
  );
  if (!Drift.hasDrift(snapshot)) {
    return yield* cli.displayPlan(snapshot.repairPlan.native);
  }

  if (!repair) {
    yield* cli.displayPlan(snapshot.repairPlan.native);
    const terminal = yield* CliKit.CliKit;
    if (!terminal.terminal.input) return;
    const approved = yield* terminal.prompt
      .confirm({
        message: "Repair this drift?",
        initialValue: false,
      })
      .pipe(Effect.catchTag("TerminalCancelled", () => Effect.succeed(false)));
    if (!approved) return;
  }

  yield* Drift.repair(snapshot).pipe(renderApply(snapshot.repairPlan.native));
});

export const driftCommand = Command.make(
  "drift",
  {
    repair: repairFlag,
    main: config,
    envFile,
    stage,
    profile,
  },
  instrumentCommand("drift", (args: SyncArgs & { repair: boolean }) => ({
    "alchemy.stage": args.stage,
    "alchemy.profile": args.profile,
    "alchemy.main": args.main,
    "alchemy.repair": args.repair,
  }))((args) => routeDrift(args)),
).pipe(Command.withDescription("Detect infrastructure drift"));
