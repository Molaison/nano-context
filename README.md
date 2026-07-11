<div align="center">

# NANO CONTEXT

**A compact segmented context bar and transparent token/cache footer for `pi.dev`.**

<img src="imgs/nano-context.png" alt="nano-context segmented context bar" width="100%" />

</div>

This is [Molaison's fork](https://github.com/Molaison/nano-context) of [daynin/nano-context](https://github.com/daynin/nano-context).

## What it shows

The bar under the editor splits the active model window into system prompt, user prompts, assistant replies, thinking, tool results, and free space.

The footer adds explicit accounting labels instead of ambiguous arrows:

- `prompt` — cumulative prompt volume: `input + cacheRead + cacheWrite`.
- `cache` — cumulative tokens the provider reported as served from cache.
- `last-hit` — latest request on the active branch: `cacheRead / (input + cacheRead + cacheWrite)`.
- `total-hit` — weighted rate across all requests in the session: total `cacheRead / (input + cacheRead + cacheWrite)`.
- `write` — cumulative provider-reported cache creation tokens.
- `out` — cumulative output tokens.
- `$` — cumulative reported cost.

On narrow terminals the labels become `P`, `C`, `LH`, `TH`, `W`, and `O`.

Cache creation is **not** counted as a hit: only `cacheRead` is in either hit-rate numerator. `cacheWrite` is in the denominator and is displayed separately. `total-hit` is token-weighted rather than an average of per-request percentages. OpenAI currently reports automatic cache creation as uncached input rather than `cacheWrite`; only API `cached_tokens` contributes to `cache`, `last-hit`, and `total-hit`.

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
