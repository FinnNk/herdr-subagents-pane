# herdr-subagents-pane

An [opencode](https://opencode.ai) v2 plugin that opens a [herdr](https://herdr.dev) pane for each
subagent, so you can watch it work next to the main agent.

- When the session in your opencode TUI spawns a subagent and it keeps working for 10 seconds, a
  viewer pane opens for it, so quick subagents don't flash a pane open and shut (they still appear
  in the summary strip). A subagent that asks for input gets its pane at once, and so does one
  whose own subagent is working. Subagents can be excluded by agent name or title. **Layout:** the orchestrator keeps the left third of its pane and
  each task gets a column to the right. Name subagents `<Role>: <Task>` (the orchestrator chooses
  the description) and subagents with the same task share a column, e.g. `Driver: implementation`
  and `Navigator: implementation` stack in one column while `Research: word splitting` gets its own.
  A description without a colon gets a column of its own. Columns are always full height: if every
  column is already stacked, the plugin briefly closes and reopens the cards below the top one so it
  can split the new column off at full height (a column with an expanded view is left alone).
- **Cards:** each pane shows a compact card instead of the full transcript: title, status and
  elapsed time, the latest message the subagent received and who sent it (`← orchestrator: …`,
  `← Driver: implementation (completed): …`), the current tool, and the tail of its latest output.
  **Zoom is the toggle.** Zoom the pane as usual (herdr's `prefix+z`, default `ctrl+b z`), or
  press Enter in it, to expand it: the pane fills the tab with the full opencode view of that
  subagent. **Press `ctrl+b z` again** (or quit the full view with ctrl+c) to return to the card
  and the layout. Cards don't capture the mouse, so clicking one just focuses the pane. An expanded pane is never closed automatically; its countdown restarts until
  you collapse it.
- **Summary strip:** a full-width strip along the bottom of the tab shows the agent tree, with an
  indicator per agent (`●` active, `◌` waiting on a subagent, `○` idle, `▲` needs input), its total
  active time (ticking while it works), and tokens in / out (in includes cached prompt tokens, out
  includes reasoning), plus a total. It opens as soon as the first subagent appears (even one too
  quick to get a pane) and closes with the panes once the workflow has been quiet for the close
  delay. Set `"summary": false` to turn it off (see [Configuration](#configuration)).
- Each pane's label shows the subagent's title and status: `· starting`, `· working`,
  `· working (run 2)` each time it starts working again (resumed by its parent, or after
  its own subagents report back), `· waiting`, `· needs input`, or
  `· done, closing in 20s`.
- **Debounced close once the workflow is quiet:** countdowns (default 20s) start only when nothing
  under the main session (the main session included) is running or waiting for input, and has
  stayed that way for a short settling period (default 3s). Orchestrators end their turn after
  launching background subagents and are woken by the results, so a subagent's parent being idle
  doesn't mean the workflow is done. Idle panes read `· waiting` until then, so a
  driver/navigator pair stays visible for the whole loop. Any new activity cancels pending closes.
- A pending permission or question keeps the pane open until it is answered.
- Repeated titles are numbered (`Research: x`, `Research: x #2`) in labels, cards and the strip.
- **Picks up a run in progress:** when the TUI starts, or switches to a session that already has
  subagents (e.g. after restarting opencode mid-run), running subagents get their panes at once,
  and every subagent appears in the strip with its tokens so far. Active time before the TUI
  attached isn't known, so it counts from then.
- At the pane limit, the oldest idle viewer is closed to make room for a new subagent. If every
  viewer is busy, the new subagent doesn't get a pane.
- Panes are closed when the subagent session is deleted, when you switch the TUI to an unrelated
  session, or when the TUI exits. Each pane also watches the TUI process that opened it and closes
  itself if that process is gone, so a crash or a quick exit doesn't leave panes behind.

Requires opencode ≥ 2.3 (client plugin API: `setup(api)`) running inside a herdr pane.

## Install

Add the `plugin` directory to `~/.config/opencode/cli.json`:

```json
{
  "plugins": ["/path/to/herdr-subagents-pane/plugin"]
}
```

## Configuration

Settings come from a JSON file, and environment variables override the file. The file is the
first of these that exists:

1. the path in `HERDR_SUBAGENTS_CONFIG` (if set, nothing else is tried)
2. `$OPENCODE_CONFIG_DIR/herdr-subagents-pane.json`
3. `~/.config/opencode/herdr-subagents-pane.json` (or under `$XDG_CONFIG_HOME`)

Every key is optional; these are the defaults:

```json
{
  "enabled": true,
  "autoClose": true,
  "openDelaySeconds": 10,
  "closeDelaySeconds": 20,
  "settleSeconds": 3,
  "maxPanes": 4,
  "summary": true,
  "debugLog": null,
  "excludeAgents": [],
  "excludeTitles": []
}
```

| Key | Environment variable | Meaning |
| --- | --- | --- |
| `enabled` | `HERDR_SUBAGENTS_ENABLED` (`1`/`0`) | Master switch. `false` turns the plugin off without uninstalling it |
| `autoClose` | `HERDR_SUBAGENTS_AUTO_CLOSE` (`1`/`0`) | Close panes once the workflow is quiet. `false` keeps them open, labelled `done`, until you close them (the pane cap still applies) |
| `openDelaySeconds` | `HERDR_SUBAGENTS_OPEN_DELAY_MS` (ms) | How long a subagent must keep working before its pane opens. `0` opens panes immediately |
| `closeDelaySeconds` | `HERDR_SUBAGENTS_CLOSE_DELAY_MS` (ms) | Countdown before an idle subagent's pane closes |
| `settleSeconds` | `HERDR_SUBAGENTS_SETTLE_MS` (ms) | How long the workflow must stay quiet before countdowns start |
| `maxPanes` | `HERDR_SUBAGENTS_MAX_PANES` | Maximum viewer panes open at once (the oldest idle one is closed to make room) |
| `summary` | `HERDR_SUBAGENTS_SUMMARY` (`1`/`0`) | Show the summary strip |
| `debugLog` | `HERDR_SUBAGENTS_DEBUG` | Path of a file to append debug logs to |
| `excludeAgents` | | Agent names whose subagents get no pane, e.g. `["explore"]` |
| `excludeTitles` | | Regular expressions (case-insensitive) for subagent titles that get no pane, e.g. `["^Quick:"]` |

Excluded subagents still appear in the summary strip, and still get a pane if they ask for input.

Boolean variables also accept `true`/`false`, `yes`/`no` and `on`/`off`. Invalid values and
unknown keys are ignored (the default is kept) and reported in a warning toast when opencode
starts. Settings are read once at startup, so restart opencode after changing them.

## Recipe: a navigator that directs its own driver

To have the orchestrator talk only to a navigator, and the navigator and driver talk directly,
let the navigator spawn the driver as its own subagent. By default opencode 2.3 allows one level
of subagents, and the built-in `general` agent can't spawn subagents. Enable both in a
project-level `opencode.json`:

```json
{
  "experimental": { "subagent_depth": 2 },
  "agents": {
    "navigator": {
      "mode": "subagent",
      "description": "Pair-programming navigator. Plans and reviews, and directs its own driver subagent. Never edits files.",
      "permission": { "subagent": "allow", "edit": "deny" }
    }
  }
}
```

Then ask the orchestrator to launch one `navigator` subagent (`Navigator: implementation`) and have
it launch `Driver: implementation` itself. The driver's results go to the navigator, not the
orchestrator. Both stack in the implementation column, and each card shows who its latest message
came from (`← Navigator: implementation: …`, `← Driver: implementation (completed): …`).
`subagent_depth` is an experimental opencode setting.

## How it works

- `plugin/tui.js`: the v2 entrypoint. Subscribes to `api.data.listen` and polls the TUI route.
- `plugin/controller.js`: a pure state machine (open, debounce, close) with no opencode or herdr imports.
- `plugin/cards.js`: builds each card's state from events (pure; writes JSON to `$XDG_RUNTIME_DIR`).
- `plugin/card.js`: the card renderer that runs in each pane (via opencode's embedded Bun), with
  zoom/Enter to expand into the full view using `herdr pane zoom`.
- `plugin/summary.js`: the summary store (fed by events in the parent TUI) and the strip renderer.
- `plugin/herdr.js`: a thin adapter over the `herdr` CLI (`pane split/run/rename/get/close`).

Viewer panes are started with `HERDR_SUBAGENTS_PANE_VIEWER=1` so the plugin does not run inside them.
If the parent TUI uses `--server <url>`, the viewer uses the same URL, and `OPENCODE_SERVER_PASSWORD`
is passed through `herdr pane split --env`, not on the command line.

## Development

```sh
BUN_BE_BUN=1 opencode test
```
