# herdr-subagents-pane

An [opencode](https://opencode.ai) v2 plugin that opens a [herdr](https://herdr.dev) pane for each
subagent, so you can watch it work next to the main agent.

- When the session in your opencode TUI spawns a subagent, a viewer pane opens running
  `opencode --session <child>`. **Layout:** the orchestrator keeps the left third of its pane and
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
  includes reasoning), plus a total. It opens with the first subagent and closes with the last
  viewer. Set `HERDR_SUBAGENTS_SUMMARY=0` to turn it off.
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
- At the pane limit, the oldest idle viewer is closed to make room for a new subagent. If every
  viewer is busy, the new subagent doesn't get a pane.
- Panes are closed when the subagent session is deleted, when you switch the TUI to an unrelated
  session, or when the TUI exits.

Requires opencode ≥ 2.3 (client plugin API: `setup(api)`) running inside a herdr pane.

## Install

Add the `plugin` directory to `~/.config/opencode/cli.json`:

```json
{
  "plugins": ["/path/to/herdr-subagents-pane/plugin"]
}
```

## Configuration (environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `HERDR_SUBAGENTS_CLOSE_DELAY_MS` | `20000` | Debounce before closing an idle subagent's pane |
| `HERDR_SUBAGENTS_SETTLE_MS` | `3000` | How long the workflow must stay quiet before countdowns start |
| `HERDR_SUBAGENTS_MAX_PANES` | `4` | Maximum viewer panes open at once (the oldest idle one is closed to make room) |
| `HERDR_SUBAGENTS_SUMMARY` | `1` | Set to `0` to hide the summary strip |
| `HERDR_SUBAGENTS_DEBUG` | unset | Path of a file to append debug logs to |

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
