# Demo prompts

Prompts to copy and paste into opencode when demoing herdr-subagents-pane. Each demo
lists the setup it needs, the prompt, and what to watch for.

General setup for every demo:

- Run opencode inside a herdr pane, with the plugin listed in `cli.json`
  (`{ "plugins": ["/path/to/herdr-subagents-pane/plugin"] }`), either in
  `~/.config/opencode/cli.json` or in a directory pointed to by `OPENCODE_CONFIG_DIR`.
- Use a model that follows multi-step instructions reliably.
- Optional: `HERDR_SUBAGENTS_CLOSE_DELAY_MS=30000` keeps the panes up a little longer at the
  end, so there's time to look at the final state.

---

## 1. Word-frequency CLI: research, then a navigator/driver pair

Shows parallel columns per task, a nested subagent (the navigator launches its own driver),
the summary strip's `waiting` state while the driver works, `run 2` when the navigator
resumes to review, and every pane closing together once the whole tree is quiet.

### Setup

A throwaway repo with a `navigator` agent that is allowed to launch subagents but can't edit
files, plus nesting depth 2 so it can launch the driver:

```sh
mkdir -p ~/demo/wordfreq && cd ~/demo/wordfreq && git init -q
printf '# wordfreq\n\nA tiny word-frequency CLI (demo project).\n' > README.md
printf 'The quick brown fox jumps over the lazy dog.\nThe dog sleeps; the fox runs! Café, café, naïve résumé.\n' > sample.txt
cat > opencode.json <<'EOF'
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
EOF
git add -A && git commit -qm "demo: initial"
```

To reset between runs: `git checkout -- . && git clean -fd`.

### Prompt

```text
Hi, I'd like a small feature built in this repo, and I want to watch the delegation. Use subagent descriptions in the form 'Role: Task' exactly as given below.

(1) RESEARCH - launch one general subagent, description 'Research: word splitting': find the best way in modern JavaScript (Bun) to split text into words so punctuation is ignored and accented words like café and naïve stay whole. Compare a \p{L} regex with Intl.Segmenter and recommend one. No file changes, keep it short.

(2) IMPLEMENTATION AS A PAIR - launch ONE subagent using the agent 'navigator', description 'Navigator: implementation'. Give it the research findings and this spec: wordfreq.js (CLI: bun wordfreq.js <file> [--top N], prints the top N lowercase words with counts) plus wordfreq.test.js. Tell the navigator to launch its own general subagent with description 'Driver: implementation', who writes the code, and to run the pairing loop with the driver directly: navigator plans, driver implements, navigator reviews the diff and resumes the same driver with feedback, at most two rounds. The navigator never edits files and reports back to you only when the pair is done. Do not talk to the driver yourself.

(3) REVIEW - do the final review yourself, no subagent: read the final code, run the tests, and report findings without fixing anything.

Keep all files inside this repo and don't commit. At the end, give me a short summary of who did what.
```

### What to watch for

- **Research** opens in a column beside the orchestrator and goes `idle` once it reports back.
- **Navigator** opens in a second column; **Driver** stacks beneath it in the same column
  (same task, `implementation`).
- The summary strip shows `◌ waiting` for the orchestrator and the navigator while the driver
  is `● active`.
- The navigator's card shows `working (run 2)` when the driver's result wakes it to review.
- Zoom a card with `ctrl+b z` to see the full transcript; press it again to go back to the card.
- After the orchestrator's final review, all cards count down and close together.

Runs take about two minutes and roughly 250k tokens in total.
