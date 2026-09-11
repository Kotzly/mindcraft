# Todo list for goals (plan, not implemented)

Give `!goal` a persistent, visible plan: a todo list that lives in the system prompt, is filled automatically when
a goal starts, and that the bot updates as it works.

## What the code does today

- `!goal` (`src/agent/commands/actions.js:364`) starts `SelfPrompter.startLoop` (`src/agent/self_prompter.js:56`),
  which sends `You are self-prompting with the goal: '...'. Your next response MUST contain a command...` as a
  `system` message.
- `handleMessage` (`src/agent/agent.js:317-379`) keeps prompting while commands return output, so one loop
  message starts a chain of commands. Every action costs 2 turns (the command + its `system` result), plus a
  behavior-log turn when modes did something (`agent.js:301-309`).
- `max_messages` is 15 (`settings.js:58`). When full, the 5 oldest turns are summarized into a 500-char memory
  (`src/agent/history.js:72-79`). So the bot sees about the last 7 actions; anything it planned earlier is gone.
- The only state the model always sees is `YOUR CURRENT ASSIGNED GOAL: "..."` from `$SELF_PROMPT`
  (`src/models/prompter.js:173-177`). No progress, no plan.
- The stock examples already try to plan inside the goal string, e.g. example 25 in `_default.json`:
  `!goal("1. Collect 3 cobblestone. 2. Craft sticks 3. Find or make a crafting table. 4. Craft a stone pickaxe.")`.
  The plan exists but nothing tracks which steps are done.
- The only failure check is "no command in 3 rounds" (`self_prompter.js:64-77`). A bot that keeps using commands
  but never makes progress loops forever.
- The default conversing prompt says "don't give instructions or make lists unless asked", which works against
  planning.

Result: on long goals the bot forgets finished steps, repeats work and drifts.

## Design principles

1. **The list lives in the system prompt**, which is rebuilt on every call, so it survives the history window and
   memory summarization. This is the main fix; the commands are only how the list gets edited.
2. **Works without the new commands.** Andy models are fine-tuned on the stock command set, so the plan is created
   by code at goal start and the prompt still shows it even if the bot never calls a todo command.
3. **Stays compatible with the stock loop message and examples** (Andy's training data most likely contains them,
   since it comes from Mindcraft logs; not verified).
4. **One setting turns it all off**, so both modes can be compared per profile.

## 1. State: `src/agent/todo_list.js`

A `TodoList` owned by the agent (`this.todo = new TodoList()` next to `self_prompter` in `agent.js:46`).

```js
items = [{ text, done }]   // max 12 steps, each trimmed to 100 chars
attempts = 0               // commands used since the current step started
```

| Method | Behavior |
|---|---|
| `set(texts)` | replace items, reset `attempts` |
| `add(text)` | insert before the current open step, which makes it current (reset `attempts`); append when all steps are done |
| `done(n)` | `n` must be the current step: mark it done, reset `attempts`. Otherwise return an error string that names the current step (section 2) |
| `clear()` | empty list, reset `attempts` |
| `current()` | first open item and its number, or `null` |
| `tick()` | `attempts++` |
| `isStuck()` | `attempts >= STUCK_COMMANDS` (10) |
| `render()` | prompt text, `''` when empty |
| `toJSON()` / `load(data)` | persistence |
| `static parseSteps(text)` | split on `;` and newlines, strip `1.`, `1)`, `-`, `[ ]`, `[x]` prefixes, drop empty items |
| `static parseNumberedGoal(text)` | extract `1. ... 2. ...` steps from a goal string (see 5a), or `null` |

`render()`:

```
YOUR TODO LIST (your own plan for the goal). When a command result or your inventory shows the current step is finished, use !doneTodo(n) before starting the next step. Use !addTodo for a missing step:
[x] 1. craft a wooden pickaxe
[ ] 2. mine 3 iron ore   <- current (4 commands so far)
[ ] 3. smelt 3 iron ore
```

When `isStuck()`, the current marker becomes
`<- current (12 commands so far, try a different approach or re-plan with !setTodo)`.

## 2. Commands: `src/agent/commands/queries.js`

Put them in `queryList`, not `actionsList`: they only return strings and don't affect the world (the comment at
the top of `queryList`), and `isAction()` (`commands/index.js:184`) would otherwise make a user-prompted
`!doneTodo` call `stopLoop()` (`agent.js:342`, `self_prompter.js:139`).

| Command | Params | Returns |
|---|---|---|
| `!setTodo` | `steps` (string): steps separated by `;` | the rendered list |
| `!addTodo` | `step` (string): a missing step, inserted before the current step | the rendered list |
| `!doneTodo` | `step` (int, domain `[1, Infinity)`): must be the current step | `Step 2 done. Next step is 3: 'smelt 3 iron ore'.` or the all-done text from section 4 |

- Command params only accept string/int/float/bool (`commandRegex`, `commands/index.js:29`), hence one `;`-separated
  string. Steps can't contain double quotes.
- `!addTodo` inserts instead of appending because a step found mid-goal is usually a prerequisite of the current
  step (no fuel before smelting, see section 11). Steps for later go through `!setTodo`.
- `!doneTodo` always closes the current step, so the number is a check, not a selector. Old loop messages stay in
  history (`If the results above show it is finished, use !doneTodo(6)`), and after a restart two prompts run side
  by side (section 11), so the same call can arrive twice. With the number the second call is a harmless error;
  without it, it would silently close the next step. Errors name the current step so the bot can correct itself:
  - already done: `Step 6 is already done. The current step is 7: 'craft an iron pickaxe'.`
  - any other step: `Step 7 is not the current step. The current step is 6: 'smelt 3 raw iron'. Finish it first, or change the plan with !setTodo.`
- All three return `You have no goal. Set one with !goal first.` when the self-prompter is stopped: the list is
  part of a goal, not a separate feature.
- Keep the returns short: the result goes into history as a `system` turn, and `handleMessage` continues the chain
  with it (`agent.js:367-368`), so `!doneTodo` hands the bot its next step in the same turn.

## 3. Prompt: extend `$SELF_PROMPT` instead of adding `$TODO`

In `prompter.js:173-177`, append `this.agent.todo.render()` to the goal line (only when the goal isn't stopped and
the setting is on).

Why not a new placeholder: `$SELF_PROMPT` appears in the `conversing` and `coding` prompts of `_default.json`,
`andy-4-reasoning.json` and the 3 task profiles in `profiles/tasks/`. Extending it updates all of them with no
profile edits, and `!newAction` code generation sees the plan too. The render header ("your own plan") also
gets past the "don't make lists" line without touching the profiles.

## 4. Goal loop message: `self_prompter.js:66`

Keep the original sentence and suffix (Andy's training data most likely contains them, and loop examples 26 and 28
in `_default.json` are matched by that prefix via embeddings, `src/utils/examples.js:46-66`). Insert one sentence
based on list state:

| State | Inserted sentence |
|---|---|
| list empty (planning failed) | `First make a plan with !setTodo("step one; step two; ...").` |
| step not started (`attempts == 0`) | `Your current todo step is 2: 'mine 3 iron ore'.` |
| step started (`attempts > 0`) | `Your current todo step is 6: 'smelt 3 raw iron'. If the results above show it is finished, use !doneTodo(6), otherwise keep working on it.` |
| stuck (`isStuck()`) | `Your current todo step is 2: 'mine 3 iron ore'. It has taken 12 commands. Try a different approach, split it with !setTodo, or ask for help.` |
| all done | `All todo steps are done. If the goal is fully met use !endGoal. If it is ongoing or not met, add the next steps with !setTodo.` |

The "ongoing" wording covers endless goals like "Survive forever" / "Repeat forever" (examples 24 and 27).

Wording choices:

- **No `!doneTodo` when a step starts.** The message ends with "Your next response MUST contain a command", and small
  models tend to copy the one complete command it contains, so `Use !doneTodo(1)` would invite closing the step
  before any work. The standing rule ("when a command result or your inventory shows...") lives in the list header
  instead. `!doneTodo` is only named once the step has had commands, which is when it may really be finished (e.g.
  the resumed loop after the smelt restart, section 11).
- **Step text in quotes** (`step is 2: 'mine 3 iron ore'`): `Current step: 2. mine 3 iron ore.` reads as two
  sentences.
- **The message stays in history**, so a few turns later it names an old step. The `!doneTodo` results are newer and
  name the new step, and a repeated `!doneTodo` is rejected (section 2), so this is accepted.

Counting attempts: in `agent.js`, right after `executeCommand` (`agent.js:362`), call `this.todo.tick()` when
`self_prompt` is true and the command is not one of the todo commands. The loop message is only added once per
chain, so the count also shows in `render()`, which the model sees on every call.

## 5. Automatic plan at goal start

Runs at the top of `startLoop()` when `settings.todo_list` is on, the list is empty and
`this.planned_goal !== this.prompt`. Set `planned_goal = prompt` first, so loop restarts (`update()`,
`self_prompter.js:89-106`, and the `stopLoop()` calls in `modes.js:307`) don't plan again. `startLoop` is also
where paused goals resume (`conversation.js:348-352`), so a goal set during a conversation gets planned when the
conversation ends.

**a. Steps already in the goal text (no model call).** `TodoList.parseNumberedGoal` handles the example-25 style.
Only accept numbers that go 1, 2, 3... in order with at least 2 steps, so coordinates like `at 100, 64, 200. `
don't count as steps.

**b. Otherwise, one planning call.** `Prompter.promptPlanning()`, modeled on `promptMemSaving`
(`prompter.js:280-291`): `checkCooldown`, `replaceStrings`, `sendRequest([], prompt)`, strip `</think>`, then
`TodoList.parseSteps`. New `planning` prompt in `profiles/defaults/_default.json`:

```
You are a Minecraft bot named $NAME. Break your goal into a short todo list of concrete steps, in order, that you can do with your commands. Each step should be checkable, like "collect 3 cobblestone" or "craft a stone pickaxe". Skip steps that your inventory already covers.
$SELF_PROMPT
$STATS
$INVENTORY
Respond only with the steps, one per line, at most 8 steps, with no numbering or other text.
```

(The list is still empty at this point, so `$SELF_PROMPT` renders only the goal line.)

**Model:** optional `planning_model` profile key, built like `vision_model` (`prompter.js:70-76`), defaulting to
`chat_model`. Andy is weak at open-ended planning; `andy42air-lmstudio-haiku.json` can set
`"planning_model": {"api": "claude-cli", "model": "haiku", "params": {"effort": "low"}}` and pay one Haiku call
per goal.

If both fail, the list stays empty and the loop message asks the bot to `!setTodo` (section 4).

## 6. Goal lifecycle

| Event | Code | Todo |
|---|---|---|
| `!goal` with a different prompt | `actions.js:369` | `todo.clear()`, reset `planned_goal` |
| `!goal` resumed / loop restarted | `self_prompter.js:15`, `:89` | keep |
| `!endGoal` | `actions.js:381` | `todo.clear()` |
| `!stfu` / `shutUp` | `agent.js:246-251` | goal is stopped, so the list is hidden and not saved; next `!goal` clears it |
| `!clearChat` | `actions.js:84` | keep (only history is cleared, and the plan should survive) |
| task start | `tasks.js:405` | goes through `!goal`, gets planned like any goal |
| agent restart (successful `!smeltItem`, `!restart`, crash) | `agent_process.js:42-50` | restored from `memory.json` (section 7) |

## 7. Persistence

- `history.js:82-98` `save()`: add `todo: self_prompter.isStopped() ? null : agent.todo.toJSON()`, same rule
  as `self_prompt` (`history.js:88`).
- `agent.js:197-201`: `this.todo.load(save_data.todo)` and set `self_prompter.planned_goal` **before**
  `handleLoad`, otherwise `handleLoad -> start -> startLoop` plans again on top of the saved list.
- Needed on every restart, not only with `load_memory: true`: `agent_process.js:42-50` restarts an agent that
  exits with code 1 with `load_memory = true`, and `!smeltItem` calls `cleanKill` (exit code 1) 500 ms after every
  successful smelt (`actions.js:278-291`). Without this, any goal that smelts loses its list halfway (section 11).

## 8. Setting

- `settings.js`: `"todo_list": true, // goals keep a todo list in the prompt and get an automatic plan`.
- `src/mindcraft/public/settings_spec.json`: add `todo_list` (`boolean`, default `true`). `mindserver.js:136-140`
  deletes unknown keys for agents created from the dashboard (`main.js:79` doesn't filter, but both paths should
  work).
- Per profile via `"settings": {"todo_list": false}` (`mindcraft.js:40`), e.g. to compare Andy with and without it.
- When false: add the 3 commands to `this.blocked_actions` in `agent.js:62` (removes them from docs via
  `getCommandDocs` and from `commandMap` via `blacklistCommands`), skip planning, render nothing, send the original
  loop message unchanged.

## 9. Examples: `profiles/defaults/_default.json` `conversation_examples`

2 examples are picked per call (`num_examples`) by similarity of the non-assistant turns, so new examples must
contain the new loop message wording to get picked during goals.

- Step progress: loop message with `Your current todo step is 1: 'collect 3 cobblestone'.` → `!collectBlocks` →
  `Collected 3 cobblestone.` → `!doneTodo(1)` → `Step 1 done. Next step is 2: '...'.` → next command.
- Resumed step, finished: `... If the results above show it is finished, use !doneTodo(2), otherwise keep working on
  it.` with a successful result in history → `!doneTodo(2)`.
- Resumed step, not finished: the same message with a failed result (`No iron_ore nearby to collect.`) → a new
  command, not `!doneTodo`.
- All done: loop message with `All todo steps are done...` → `!endGoal`.
- Stuck: `... It has taken 12 commands...` → `!setTodo("find a cave; mine iron ore in the cave")`.

Keep example 25 (numbered plan in the goal string); it now feeds `parseNumberedGoal` directly.

## 10. Dashboard

- `src/agent/library/full_state.js`: add `todo: { items, attempts }` (empty when the goal is stopped). The mindserver
  polls every second (`mindserver.js:311-330`).
- `src/mindcraft/public/index.html`: in `renderAgentCard` (~line 954, after the usage cell) add
  `<div class="cell" id="todo-${agent.name}" style="grid-column: 1 / -1; white-space: pre-line;">todo: -</div>`, and
  fill it in the `state-update` handler (~line 714): done steps struck through, current step marked. Step text is
  model output, so build it with `textContent` / escaping, not raw `innerHTML`.

## 11. Walkthrough: "get an iron pickaxe"

Setup: profile `andy42air-lmstudio-haiku.json` (bot `AndyAirLMS`) with `planning_model` set to Haiku, player
`Steve`, starting inventory `wooden_pickaxe: 1, crafting_table: 1, stick: 4`. Command outputs use the log strings
from `src/agent/library/skills.js`; coordinates are made up. Turns are shown as they sit in history (`SYSTEM:` is
how `strictFormat` sends `system` turns, `src/utils/text.js:52-55`). Behavior-log turns are left out.

### Player asks, bot sets the goal

```
Steve: can you get an iron pickaxe?
AndyAirLMS: Sure, I'll get one! !goal("Get an iron pickaxe")
```

`!goal` has a new prompt, so the list is cleared and the loop starts. `startLoop` finds an empty list and
`planned_goal !== prompt`:

1. `parseNumberedGoal("Get an iron pickaxe")` returns `null`.
2. `promptPlanning()` makes one Haiku call with the goal, stats and inventory, and gets back:

```
collect 11 cobblestone
craft a stone pickaxe
craft a furnace
mine 3 iron ore
smelt 3 raw iron
craft an iron pickaxe
```

No sticks step: the inventory already has 4. The list is set and the first loop message goes out:

```
SYSTEM: You are self-prompting with the goal: 'Get an iron pickaxe'. Your current todo step is 1: 'collect 11 cobblestone'. Your next response MUST contain a command with this syntax: !commandName. Respond:
```

### Steps 1-3: a normal chain

Every command returns output, so `handleMessage` keeps prompting without another loop message
(`agent.js:317-379`):

```
AndyAirLMS: Getting some cobblestone first. !collectBlocks("cobblestone", 11)
SYSTEM: Action output:
Collected 11 cobblestone.
AndyAirLMS: !doneTodo(1)
SYSTEM: Step 1 done. Next step is 2: 'craft a stone pickaxe'.
AndyAirLMS: !craftRecipe("stone_pickaxe", 1)
SYSTEM: Action output:
Placed crafting_table at (105, 64, -30).
Successfully crafted stone_pickaxe, you now have 1 stone_pickaxe.
Collected 1 crafting_table.
AndyAirLMS: !doneTodo(2)
SYSTEM: Step 2 done. Next step is 3: 'craft a furnace'.
AndyAirLMS: !craftRecipe("furnace", 1)
SYSTEM: Action output:
Placed crafting_table at (105, 64, -30).
Successfully crafted furnace, you now have 1 furnace.
Collected 1 crafting_table.
AndyAirLMS: !doneTodo(3)
SYSTEM: Step 3 done. Next step is 4: 'mine 3 iron ore'.
```

That last result is turn 15, so history hits `max_messages` and the 6 oldest turns (Steve's request through
`!doneTodo(1)`) are summarized into the 500-char memory (`history.js:72-79`). From here on the model never sees
Steve's request or the cobblestone being collected, but the goal and the list are in the system prompt on every
call.

### Step 4: a longer step, and a question mid-goal

```
AndyAirLMS: Now I need iron. !searchForBlock("iron_ore", 64)
SYSTEM: Action output:
Could not find any iron_ore in 64 blocks.
AndyAirLMS: !searchForBlock("iron_ore", 128)
SYSTEM: Action output:
Found iron_ore at (212, 38, -77). Navigating...
```

Steve asks something while the bot walks. The system prompt for that call starts like this:

```
You are an AI Minecraft bot named AndyAirLMS that can converse with players, see, move, mine, build, and interact with the world by using commands.
YOUR CURRENT ASSIGNED GOAL: "Get an iron pickaxe"
YOUR TODO LIST (your own plan for the goal). When a command result or your inventory shows the current step is finished, use !doneTodo(n) before starting the next step. Use !addTodo for a missing step:
[x] 1. collect 11 cobblestone
[x] 2. craft a stone pickaxe
[x] 3. craft a furnace
[ ] 4. mine 3 iron ore   <- current (2 commands so far)
[ ] 5. smelt 3 raw iron
[ ] 6. craft an iron pickaxe
 Be a friendly, casual, effective, and efficient robot. ...
```

```
Steve: how's it going?
AndyAirLMS: Good! I have a stone pickaxe and a furnace, now going to some iron I found. Then I smelt it and craft the pickaxe.
```

A player message during a goal gets exactly one response (`agent.js:315-316`), then the goal continues:

```
AndyAirLMS: !collectBlocks("iron_ore", 3)
SYSTEM: Action output:
Collected 3 iron_ore.
AndyAirLMS: !doneTodo(4)
SYSTEM: Step 4 done. Next step is 5: 'smelt 3 raw iron'.
```

Step 4 took 3 commands. At 10 (`STUCK_COMMANDS`) the marker would switch to the "try a different approach" text
and the next loop message would carry the stuck sentence.

### Step 5: a missing step, `!addTodo`

```
AndyAirLMS: !smeltItem("raw_iron", 3)
SYSTEM: Action output:
Placed furnace at (213, 38, -75).
You have no fuel to smelt raw_iron, you need coal, charcoal, or wood.
Collected 1 furnace.
AndyAirLMS: No fuel, I'll get wood first. !addTodo("collect 2 oak logs for fuel")
SYSTEM: YOUR TODO LIST (your own plan for the goal). When a command result or your inventory shows the current step is finished, use !doneTodo(n) before starting the next step. Use !addTodo for a missing step:
[x] 1. collect 11 cobblestone
[x] 2. craft a stone pickaxe
[x] 3. craft a furnace
[x] 4. mine 3 iron ore
[ ] 5. collect 2 oak logs for fuel   <- current (0 commands so far)
[ ] 6. smelt 3 raw iron
[ ] 7. craft an iron pickaxe
```

`!addTodo` inserts before the current step, so the fuel step becomes current and the smelt step moves to 6. If it
appended, the step would land after "craft an iron pickaxe" and the bot would have to rewrite the list with
`!setTodo`. (2 logs happens to be exactly enough: logs smelt 1.5 items each, `mcdata.js:299-311`.)

```
AndyAirLMS: !searchForBlock("oak_log", 64)
SYSTEM: Action output:
Found oak_log at (190, 71, -58). Navigating...
AndyAirLMS: !collectBlocks("oak_log", 2)
SYSTEM: Action output:
Collected 2 oak_log.
AndyAirLMS: !doneTodo(5)
SYSTEM: Step 5 done. Next step is 6: 'smelt 3 raw iron'.
AndyAirLMS: !smeltItem("raw_iron", 3)
SYSTEM: Action output:
Placed furnace at (191, 70, -57).
Using oak_log as fuel.
Added 2 oak_log to furnace fuel.
Collected 1 furnace.
Successfully smelted raw_iron, got 3 iron_ingot.
```

### Restart in the middle of the goal

500 ms after a successful smelt, `!smeltItem` calls `agent.cleanKill('Safely restarting to update inventory.')`
(`actions.js:278-291`). The bot has no time to call `!doneTodo(6)`:

1. `cleanKill` adds the message to history and saves `memory.json`, now including `todo` (step 6 still open).
2. The process exits with code 1. `agent_process.js:42-50` starts it again with `load_memory = true` and the init
   message `Agent process restarted.`
3. `agent.js:197-201`: the list and `planned_goal` are restored, then `handleLoad` resumes the loop. No new
   planning call.

```
SYSTEM: Safely restarting to update inventory.
SYSTEM: Agent process restarted.
SYSTEM: You are self-prompting with the goal: 'Get an iron pickaxe'. Your current todo step is 6: 'smelt 3 raw iron'. If the results above show it is finished, use !doneTodo(6), otherwise keep working on it. Your next response MUST contain a command with this syntax: !commandName. Respond:
AndyAirLMS: The smelting worked, I have 3 iron ingots. !doneTodo(6)
SYSTEM: Step 6 done. Next step is 7: 'craft an iron pickaxe'.
```

Step 6 already had a command (`attempts` was saved as 1), so the loop message uses the "step started" wording. The
model sees the smelt result in the loaded history and `iron_ingot: 3` in `$INVENTORY`, so it closes the step.
Without section 7 the list and progress would be gone here and a second planning call would run.

Side note: with no `last_sender`, `_setupEventHandlers` also sends `Agent process restarted.` through
`handleMessage('system', ..., 2)` (`agent.js:213-215`), next to the resumed loop, so that message is in history twice
and the model gets an extra call. That happens today and this plan doesn't change it. If both answers are
`!doneTodo(6)`, the second one gets `Step 6 is already done...` instead of closing step 7 (section 2).

### Finishing

```
AndyAirLMS: !craftRecipe("iron_pickaxe", 1)
SYSTEM: Action output:
Placed crafting_table at (192, 70, -57).
Successfully crafted iron_pickaxe, you now have 1 iron_pickaxe.
Collected 1 crafting_table.
AndyAirLMS: !doneTodo(7)
SYSTEM: All todo steps are done. If the goal is fully met use !endGoal. If it is ongoing or not met, add the next steps with !setTodo.
AndyAirLMS: Got it! !endGoal
SYSTEM: Self-prompting stopped.
AndyAirLMS: Steve, I have an iron pickaxe now!
```

- `!endGoal` clears the list. The next save writes `todo: null` and the dashboard cell goes back to `todo: -`.
- The last chat line exists because `stop()` has already set the state to STOPPED when the chain checks for an
  interrupt, and `shouldInterrupt` is only true while ACTIVE or PAUSED (`self_prompter.js:120-137`). The chain asks
  the model once more, it answers without a command, and the chain ends. Also existing behavior.

### Cost of this run

About 25 chat calls plus 1 Haiku planning call. 8 of the chat calls were list edits (7 `!doneTodo`, 1 `!addTodo`).
That's the overhead of an explicit list on a local model, and what the later automatic step checks would cut.

## Implementation order

1. `todo_list.js`, the 3 commands, `$SELF_PROMPT` render, setting + spec. Test with `claude-cli.json`.
2. Loop message states and attempt counting.
3. Automatic planning: `parseNumberedGoal`, `promptPlanning`, `planning_model`.
4. Persistence, dashboard, examples. Then test with `andy42air-lmstudio-haiku.json`.

## Testing

- A small node script for `parseSteps` / `parseNumberedGoal` edge cases (numbered goal, coordinates, `[x]` prefixes,
  empty items, over 12 steps).
- `!goal("get an iron pickaxe")` with `log_all_prompts: true`: check the rendered list in
  `bots/<name>/logs/conversation_*.txt`, and watch the dashboard cell.
- A goal that smelts (or `!restart` mid-goal): after the restart the list and progress come back and no second
  plan is made.
- Start a goal, then `!startConversation` with another bot: the list stays visible while paused and the loop
  continues from the current step afterwards.
- Compare `todo_list` on/off per profile on the same goal: commands used, repeated work, whether it ends with
  `!endGoal`.

## Risks and later

- **Andy may never call `!doneTodo`.** The list still helps it (plan + goal in every prompt), but the current step never
  moves forward and the stuck warning shows up on steps that are really done. Watch for this in testing. If it
  happens, the fix is automatic checks:
- **Later: automatic step checks.** Let planned steps carry an optional item target (e.g. `iron_ingot 3`) and
  mark them done in `tick()` using `world.getInventoryCounts` / `npc/utils.js` `itemSatisfied`. Saves a
  model call per step and stops the bot from marking steps done too early. Out of scope for v1.
- **Smelt restart:** `!smeltItem` restarts the agent after every successful smelt (`actions.js:278-291`), a
  workaround for a mineflayer inventory bug (comment in commit `1da78ba`). It costs a respawn, extra model calls and
  all state that isn't in `memory.json`. Worth fixing separately; section 7 is still needed for `!restart` and
  crashes.
- **Context size:** at most 12 short lines. `lmstudio.js:43` already drops the oldest turn if the context
  overflows.
- **Not changing:** `max_messages` and the loop message's base wording; the list makes the bot depend less on
  history instead.
