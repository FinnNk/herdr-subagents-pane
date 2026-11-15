# herdr-subagents-pane

An [opencode](https://opencode.ai) v2 plugin that opens a [herdr](https://herdr.dev) pane for each
subagent, so you can watch it work next to the main agent.

- When the session in your opencode TUI spawns a subagent, a viewer pane opens to the right
  (later subagents stack below it) running `opencode --session <child>`.
- When the subagent goes idle, its pane closes after a **debounce** (default 20 s). Any new work
  in that window (the parent resuming the same subagent, a permission prompt, a question) cancels
  the close, so a subagent that is resumed keeps its pane instead of flickering.
- A pending permission or question keeps the pane open until it is answered.
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
| `HERDR_SUBAGENTS_MAX_PANES` | `4` | Maximum viewer panes open at once |
| `HERDR_SUBAGENTS_DEBUG` | unset | Path of a file to append debug logs to |

## How it works

- `plugin/tui.js`: the v2 entrypoint. Subscribes to `api.data.listen` and polls the TUI route.
- `plugin/controller.js`: a pure state machine (open, debounce, close) with no opencode or herdr imports.
- `plugin/herdr.js`: a thin adapter over the `herdr` CLI (`pane split/run/rename/get/close`).

Viewer panes are started with `HERDR_SUBAGENTS_PANE_VIEWER=1` so the plugin does not run inside them.
If the parent TUI uses `--server <url>`, the viewer uses the same URL, and `OPENCODE_SERVER_PASSWORD`
is passed through `herdr pane split --env`, not on the command line.

## Development

```sh
BUN_BE_BUN=1 opencode test
```
