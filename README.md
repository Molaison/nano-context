<div align="center">

# NANO CONTEXT

**A compact segmented context bar and transparent token/cache footer for `pi.dev`.**

<img src="imgs/nano-context.png" alt="nano-context segmented context bar" width="100%" />

</div>

This is [Molaison's fork](https://github.com/Molaison/nano-context) of [daynin/nano-context](https://github.com/daynin/nano-context).

## What it shows

The bar under the editor splits the active model window into system prompt, user prompts, assistant replies, thinking, tool results, and free space.

The footer adds two explicit accounting lines.

The first line covers the main session plus all tracked side calls:

- `prompt` — all tracked prompt volume: `input + cacheRead + cacheWrite`.
- `cache` — all tracked tokens the provider reported as served from cache.
- `last-hit` — latest main-session request on the active branch: `cacheRead / (input + cacheRead + cacheWrite)`.
- `all-hit` — token-weighted rate across all tracked requests in the session tree.
- `write` — all tracked provider-reported cache creation tokens.
- `out` — all tracked output tokens.
- `$` — all tracked reported cost.

The second line is always present and isolates side calls as `external prompt/cache/hit/write/out/$`. It reads `external none` until a tracked side call records usage, so zero usage is visible rather than silently omitted. External `hit` is the token-weighted cache rate across external calls only.

On narrow terminals, the overall line uses `P/C/LH/AH/W/O`; the external line uses `X P/C/H/W/O/$`.

Cache creation is **not** counted as a hit: only `cacheRead` is in either hit-rate numerator. `cacheWrite` is in the denominator and is displayed separately. Hit rates are token-weighted rather than averages of per-request percentages. OpenAI currently reports automatic cache creation as uncached input rather than `cacheWrite`; only API `cached_tokens` contributes to `cache`, `last-hit`, `all-hit`, and external `hit`.

## Tracked side calls

Nano Context persists side-call usage as branch-aware, LLM-hidden `nano-context.usage` session entries. This fork tracks:

- Observational Memory observer, reflector, and dropper requests.
- `/btw` side questions.
- `/wtf?` and `/oops?` typo-fix requests.
- `/until-done` judge requests.
- Foreground and background `pi-subagents` runs, including producer usage written in direct child sessions.

The context bar still describes only the active main-model context; side calls consume provider tokens and cost but do not occupy that context window. Forks/clones inherit earlier usage entries, so totals describe the retained session lineage rather than a fresh billing period. Destructive session rewrites such as `/wtf!` remove usage entries in the deleted subtree.

MCP services such as DeepWiki/Fast Context and Pi's built-in branch summarizer do not expose token usage through the extension API, so Nano cannot claim those costs. Default Pi compaction is likewise unobservable, although the installed Observational Memory hook supplies compaction without a separate built-in summary request.

## Segments

Labels shorten as the terminal narrows, while colors stay stable:

- `sys` — current system prompt
- `pr` — user prompts and attached images
- `assistant` — visible assistant replies and tool calls
- `think` — thinking blocks
- `tools` — tool results
- `free` — unused model context

When Pi knows the measured context count, Nano Context scales the estimated segment breakdown to that total.

## Install this fork

```bash
pi install git:github.com/Molaison/nano-context
```

The command writes to global Pi settings. Pass `-l` for project-local installation. Verify with `pi list`.

## Validate

```bash
npm install
npm run typecheck
pi --offline --no-extensions -e ./index.ts --list-models
```

## Stack

- TypeScript strict; Pi loads the `.ts` source directly through jiti.
- Peer dependency: `@earendil-works/pi-coding-agent`.

## License

MIT. Original implementation by Sergey Golovin (`daynin`).
