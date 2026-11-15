# herdr-subagents-pane

An [opencode](https://opencode.ai) v2 plugin that opens a [herdr](https://herdr.dev) pane for each
subagent, so you can watch it work next to the main agent.

- When the session in your opencode TUI spawns a subagent, a viewer pane opens running
  `opencode --session <child>`. **Layout:** the orchestrator keeps the left third of its pane and
  each task gets a column to the right. Name subagents `<Role>: <Task>` (the orchestrator chooses
  the description) and subagents with the same task share a column, e.g. `Driver: implementation`
  and `Navigator: implementation` stack in one column while `Research: word splitting` gets its own.
  A description without a colon gets a column of its own.
- **Cards:** each pane shows a compact card instead of the full transcript: title, status and
  elapsed time, the latest message the subagent received (e.g. `← Driver says: …`, which makes
  relayed pairing visible), the current tool, and the tail of its latest output.
  **Click the card or press Enter** to expand it: herdr zooms the pane to the full tab and the full
  opencode view of that subagent opens. Quit it (ctrl+c) to return to the card and the layout.
- Each pane's label shows the subagent's title and status: `· starting`, `· working`,
  `· working (round 2)` when the parent resumes it, `· waiting`, `· needs input`, or
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
| `HERDR_SUBAGENTS_DEBUG` | unset | Path of a file to append debug logs to |

## How it works

- `plugin/tui.js`: the v2 entrypoint. Subscribes to `api.data.listen` and polls the TUI route.
- `plugin/controller.js`: a pure state machine (open, debounce, close) with no opencode or herdr imports.
- `plugin/cards.js`: builds each card's state from events (pure; writes JSON to `$XDG_RUNTIME_DIR`).
- `plugin/card.js`: the card renderer that runs in each pane (via opencode's embedded Bun), with
  click/Enter to expand into the full view using `herdr pane zoom`.
- `plugin/herdr.js`: a thin adapter over the `herdr` CLI (`pane split/run/rename/get/close`).

Viewer panes are started with `HERDR_SUBAGENTS_PANE_VIEWER=1` so the plugin does not run inside them.
If the parent TUI uses `--server <url>`, the viewer uses the same URL, and `OPENCODE_SERVER_PASSWORD`
is passed through `herdr pane split --env`, not on the command line.

## Development

```sh
BUN_BE_BUN=1 opencode test
```
