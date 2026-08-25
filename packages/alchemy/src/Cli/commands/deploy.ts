import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";

import * as Stacks from "../../Alchemist/routes/stack.ts";
import { Cli } from "../../Report.ts";

import {
  config,
  dryRun as dryRunFlag,
  envFile,
  force,
  profile,
  stage,
  yes,
} from "./flags.ts";
import { instrumentCommand } from "./instrument.ts";
import { renderApply, renderPlanning } from "./render.ts";

interface StackCommandOptions {
  readonly main: string;
  readonly stage: string;
  readonly envFile: Option.Option<string>;
  readonly profile?: string;
  readonly dryRun?: boolean;
  readonly force?: boolean;
  readonly yes?: boolean;
  readonly destroy?: boolean;
  readonly adopt?: boolean;
  readonly detailed?: boolean;
}

const stackSpanAttrs = (args: StackCommandOptions) => ({
  "alchemy.stage": args.stage,
  "alchemy.profile": args.profile,
  "alchemy.main": args.main,
  "alchemy.dry_run": !!args.dryRun,
  "alchemy.force": !!args.force,
  "alchemy.destroy": !!args.destroy,
  "alchemy.adopt": !!args.adopt,
  "alchemy.detailed": !!args.detailed,
});

const adopt = Flag.boolean("adopt").pipe(
  Flag.withDescription(
    "Adopt pre-existing cloud resources that conflict with this stack instead of failing. " +
      "Useful for re-importing infrastructure into a fresh state store.",
  ),
  Flag.withDefault(false),
);

const detailed = Flag.boolean("detailed").pipe(
  Flag.withDescription("Show declared resource properties as YAML"),
  Flag.withDefault(false),
);

const runStack = Effect.fn(function* (options: StackCommandOptions) {
  const cli = yield* Cli;
  const display = { detailed: options.detailed, stage: options.stage };
  const target = {
    entrypoint: options.main,
    stage: options.stage,
    profile: options.profile,
    envFile: Option.getOrUndefined(options.envFile),
  };

  const operation = options.destroy
    ? "Destroy"
    : options.dryRun
      ? "Plan"
      : "Deploy";
  const withPlanningProgress = renderPlanning({
    operation,
    stage: options.stage,
  });

  const snapshot = yield* Stacks.plan({
    target,
    operation: options.destroy ? "destroy" : "deploy",
    force: options.force,
    adopt: options.adopt,
    updateStateStore: options.yes,
  }).pipe(withPlanningProgress);

  if (options.dryRun) {
    return yield* cli.displayPlan(snapshot.native, display);
  }

  if (
    !options.yes &&
    Stacks.hasChanges(snapshot.summary) &&
    !(yield* cli.approvePlan(snapshot.native, display))
  ) {
    return;
  }

  const result = yield* Stacks.apply(snapshot).pipe(
    renderApply(snapshot.native, display),
  );
  if (result !== undefined) yield* Console.log(result);
});

export const deployCommand = Command.make(
  "deploy",
  {
    dryRun: dryRunFlag,
    force,
    main: config,
    envFile,
    stage,
    yes,
    profile,
    adopt,
    detailed,
  },
  instrumentCommand("deploy", stackSpanAttrs)(runStack),
);

export const destroyCommand = Command.make(
  "destroy",
  {
    dryRun: dryRunFlag,
    main: config,
    envFile,
    stage,
    yes,
    profile,
  },
  instrumentCommand(
    "destroy",
    stackSpanAttrs,
  )((args) =>
    runStack({
      ...args,
      destroy: true,
    }),
  ),
);

export const planCommand = Command.make(
  "plan",
  {
    main: config,
    envFile,
    stage,
    profile,
    detailed,
  },
  instrumentCommand(
    "plan",
    stackSpanAttrs,
  )((args) =>
    runStack({
      ...args,
      // plan is the same as deploy with dryRun always set to true
      dryRun: true,
    }),
  ),
);
