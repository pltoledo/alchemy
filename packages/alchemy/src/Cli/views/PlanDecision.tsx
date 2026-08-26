/** @jsxImportSource react */
import { useMemo, useState, type JSX } from "react";
import type { Plan } from "../../Plan.ts";
import {
  Box,
  PromptFrame,
  SegmentedChoice,
  useKeyGlyphs,
  useTerminalInput,
} from "../CliKit/components.ts";
import { Screen, type ScreenController } from "../CliKit/index.ts";
import { PlanView, PlanViewStore } from "./PlanView.tsx";

export interface PlanDecisionChoice<Value> {
  readonly value: Value;
  readonly label: string;
}

function PlanDecision<Value>(props: {
  readonly plan: Plan;
  readonly message: string;
  readonly choices: ReadonlyArray<PlanDecisionChoice<Value>>;
  readonly initialValue: Value;
  readonly controller: ScreenController<Value>;
}): JSX.Element {
  const { plan, message, choices, initialValue, controller } = props;
  const store = useMemo(() => new PlanViewStore(plan), [plan]);
  const initialIndex = Math.max(
    0,
    choices.findIndex((choice) => choice.value === initialValue),
  );
  const [selected, setSelected] = useState(initialIndex);
  const keys = useKeyGlyphs();
  const move = (delta: number) =>
    setSelected(
      (current) => (current + delta + choices.length) % choices.length,
    );

  useTerminalInput((_input, key) => {
    if (key.left) move(-1);
    else if (key.right) move(1);
    else if (key.enter) controller.submit(choices[selected]!.value);
    else if (key.escape) controller.cancel();
  });

  return (
    <Box flexDirection="column" gap={1}>
      <PlanView store={store} mode="review" viewport="virtual" />
      <PromptFrame
        message={message}
        keys={[
          [keys.upDown, "scroll plan"],
          [keys.leftRight, "choose"],
          [keys.enter, "confirm"],
          [keys.escape, "cancel"],
        ]}
      >
        <SegmentedChoice choices={choices} value={choices[selected]!.value} />
      </PromptFrame>
    </Box>
  );
}

export const planDecisionScreen = <Value,>(options: {
  readonly plan: Plan;
  readonly message: string;
  readonly choices: ReadonlyArray<PlanDecisionChoice<Value>>;
  readonly initialValue: Value;
}) =>
  Screen.make<Value>("plan decision", (controller) => (
    <PlanDecision {...options} controller={controller} />
  ));
