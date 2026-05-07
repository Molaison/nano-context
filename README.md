<div align="center">

# NANO CONTEXT

**A tiny `pi.dev` extension that replaces the default context meter with a compact segmented bar under the editor.**

<img src="imgs/nano-context.png" alt="nano-context segmented context bar" width="100%" />

</div>

## What it is

`nano-context` shows what is filling up the current session. The bar sits right under the input and splits the model window into colored pieces: system prompt, your prompts, assistant replies, thinking, tool results, and free space.

That's the whole thing. No sidebar, no popover, no second context meter in the footer.

## In action

When a session gets long, you can see at a glance what ate the context:

<p align="center">
  <img src="imgs/example.png" alt="pi session with nano-context under the editor" width="80%" />
</p>

## Segments

The labels get shorter when the terminal is narrow, but the colors stay the same:

- `sys` — the current system prompt
- `pr` — your prompts and attached images
- `assistant` — visible assistant replies and tool calls
- `think` — thinking blocks, if pi has them
- `tools` — tool results
- `free` — the space still left in the model window

The pieces are proportional. If pi knows the real context count for the turn, `nano-context` uses that total and scales the pieces to match.

## Install

From [npm](https://www.npmjs.com/package/pi-nano-context):

```bash
pi install npm:pi-nano-context
```

Or from [GitHub](https://github.com/daynin/nano-context):

```bash
pi install git:github.com/daynin/nano-context
```

Both commands write to your global pi settings (`~/.pi/agent/settings.json`). Pass `-l` to install only for the current project.

Verify with `pi list`. Remove with `pi remove pi-nano-context`.

## Testing

Typecheck it:

```bash
npm run typecheck
```

Smoke-load it:

```bash
pi --no-extensions -e ./index.ts --no-session --no-tools -p "Reply ok"
```

To exercise the bar, run pi with tools enabled, ask it to read a file, then ask a second question in the same session. You should see `sys`, `pr`, `assistant`, `tools`, and `free`. `think` only appears when the selected model/provider stores thinking blocks in the session.

## Stack

- TypeScript strict, no build step. The extension loads as `.ts` source via jiti.
- Deps: `@mariozechner/pi-coding-agent`. Nothing else.

## License

MIT.
