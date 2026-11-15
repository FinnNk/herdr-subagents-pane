# Demo prompts

Prompts to copy and paste into opencode when demoing herdr-subagents-pane. Each demo
lists the setup it needs, the prompt, and what to watch for.

General setup for every demo:

- Run opencode inside a herdr pane, with the plugin listed in `cli.json`
  (`{ "plugins": ["/path/to/herdr-subagents-pane/plugin"] }`), either in
  `~/.config/opencode/cli.json` or in a directory pointed to by `OPENCODE_CONFIG_DIR`.
- Use a model that follows multi-step instructions reliably.
- Set `"openDelaySeconds": 0` in `herdr-subagents-pane.json` so every subagent gets a pane, as
  described below. With the default 5-second delay, the quickest subagents (e.g. demo 2's
  Formula solver, which takes about 2 seconds) appear only in the summary strip.
- Optional: `"closeDelaySeconds": 30` in `herdr-subagents-pane.json` keeps the panes up a little
  longer at the end, so there's time to look at the final state. `"autoClose": false` keeps them
  open until you close them.

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

---

## 2. Intercepted message: crack the cipher, then answer its question

Shows a wide fan-out: three codebreakers race at once, stacked in one column; only one succeeds
and the others go idle early. Then the decrypted message asks a question with a trap in it, and two
solvers answer it independently for the orchestrator to compare. Quick: about a minute.

### Setup

No project needed, just an empty directory (the subagents may write small Python scripts):

```sh
mkdir -p ~/demo/cipher && cd ~/demo/cipher
```

### Prompt

```text
I intercepted this message and want to know what it asks, and the answer. Use subagent descriptions in the form 'Role: Task' exactly as given below.

Aqmp uszf, cfy tbzv gdbgbip ulv qqtwrkq. Osn jas xyi dfec tgadci. M dpfgw usnid cicp djrxw aogv ef prv s'omsto, fxmti mu xns, moh js ao yg xa uavphf xzqqt ek xifpmi. Uu ecwa smeke prti mu imidz lrpr qejx fii ysgs. Lfa ybrp xunij hafw klq cicp djrx mz prv atppv hmz? Vvtxz azxt ulv rgnfvv moh ysi zsl kau mk.

(1) CODEBREAKING - launch three general subagents at the same time, each testing one hypothesis: 'Caesar: codebreaking' (try all 26 shifts), 'Atbash: codebreaking' (try Atbash and simple reversal), and 'Vigenere: codebreaking' (find the key length with the index of coincidence, then the key by frequency analysis). Each may write and run a small Python script in this directory, must stop after one honest attempt, and reports either the key and plaintext or "no". No other file changes.

(2) ANSWER - once you have the plaintext, launch two general subagents at the same time to answer its question independently: 'Formula: answer' (work it out by reasoning and arithmetic only, no code) and 'Simulation: answer' (write a short Python script that steps through the day minute by minute). Give each only the decrypted question.

(3) VERDICT - compare the two answers yourself. If they disagree, find out why. Then give me the cipher and key, the decrypted message, the answer, and who did what.
```

### What to watch for

- All three codebreakers open within seconds of each other and stack in one column (same task,
  `codebreaking`). Caesar and Atbash report "no" quickly and go `idle` in the summary strip,
  while Vigenère keeps working.
- Formula and Simulation then open together. That makes five subagents, over the default limit
  of four panes, so the oldest idle codebreaker (Caesar) is closed to make room.
- The question has traps: counting 1 to 24 for the hours (300), or forgetting the half-hour
  rings (156). Sometimes one solver gets it wrong and the orchestrator has to reconcile.
- Both columns stay full height: when the solvers arrive, the codebreaker column briefly
  collapses to its top card so the answer column can be split off beside it, and the other
  codebreakers reappear underneath.

### Answer (spoiler)

Vigenère with key `EMBER`. The message describes a clock tower bell that rings the hour (1 to
12) and once at every half past, and asks how many rings in a day:
2 × (1 + … + 12) + 24 = **180**.
