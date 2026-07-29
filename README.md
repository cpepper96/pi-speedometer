# pi-speedometer

A per-turn speedometer for [pi](https://pi.dev): TTFT (time to first token), prefill tok/s, decode tok/s, and total wall time.

Pi's built-in footer already shows tokens, cache, cost, context, and model. This extension surfaces the *timing* numbers it doesn't show.

## Status line

While a turn streams, pi's status area shows a live gauge for the current turn:

```txt
⠹ ▁▂······ ~65 tok/s · ttft 812ms · 4.2s
```

The gauge is a tachometer for decode speed: fill level is the current turn's
decode tok/s on a linear 0–400 scale (50 tok/s per cell). A ~65 tok/s model
lights a cell or two; a 400+ tok/s provider revs it to full. The number is an
estimate from streamed characters — it snaps to the real value at turn end.
During tool calls the gauge sags and revs back when streaming resumes. Before
the first token you get `⠹ ········ waiting… · 1.3s`.

After each turn, the line settles into the measured stats:

```txt
ttft 1967ms  prefill 412 tok/s  decode 63.8 tok/s  total 14.2s
```

## Commands

- `/speed` — show recent turns and per-model session averages
- `/speed clear` — reset history
- `/speed csv` — dump full history to `~/.pi/pi-speedometer-<timestamp>.csv`
- `/speed live on|off` — toggle the live gauge for the current session (on by default)

## Install

```bash
pi install npm:pi-speedometer
```

Or try it without installing:

```bash
pi -e npm:pi-speedometer
```

## How it is measured

- **TTFT** — the time from `turn_start` to the first `text_delta` or `toolcall_delta`, measured with `performance.now()`. Thinking deltas do not stop this timer. Thus, on reasoning models, TTFT shows the latency that the user feels.
- **Prefill tok/s** — `(input + cacheWrite) / ttft`. `cacheRead` is not included, because those tokens did no prefill work in this turn. `cacheWrite` is included, because those tokens were processed and written to the cache.
- **Decode tok/s** — `answer_output / (turn_end - first_token)`. `answer_output` is the answer-phase part of `usage.output`, calculated from the ratio of streamed characters. Reasoning tokens are not included, because the decode window starts at the first visible token. Without this correction, thinking tokens would make the answer-phase rate too high on reasoning models. If no stream deltas occurred, the raw `output` value is used.
- **Total** — the wall-clock time from `turn_start` to `turn_end`. Tool round-trips in the turn are included.
- **Live estimate** — streamed characters divided by 4, divided by the time of the current phase. The gauge operates during thinking, because thinking tokens are real decode work and their speed is visible. When visible text starts, the gauge changes to the answer-phase rate. The answer-phase window includes tool round-trips, to agree with the settled decode number. At `turn_end`, the true `usage` counts replace the estimate.

Numbers come from `AssistantMessage.usage` (provider-agnostic) plus pi's own event timings, so any provider pi supports will report.

## Development

`./dev` drops you into a [nono](https://nono.sh)-sandboxed shell with the toolchain (node 24, matching CI) provided by the nix flake:

```bash
./dev                    # interactive sandboxed shell — run pi, npm, etc. inside
./dev npm ci             # or run a one-off command sandboxed
./dev npm run typecheck
```

The only host prerequisite is [nix](https://nixos.org/download). One-time setup — install the base sandbox profile pack (using the flake's own nono):

```bash
nix --extra-experimental-features 'nix-command flakes' develop -c nono pull always-further/pi
```

The sandbox profile lives in `.nono/pi-speedometer.json` and extends `always-further/pi`; project-specific grants go there.

## License

MIT
