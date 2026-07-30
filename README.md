# pi-speedometer

A per-turn speedometer for [pi](https://pi.dev): TTFT (time to first token), prefill tok/s, decode tok/s, and total wall time.

Pi's built-in footer already shows tokens, cache, cost, context, and model. This extension surfaces the *timing* numbers it doesn't show.

## Status line

After each valid turn, pi's status line shows the measured stats and a gauge:

```txt
▁▂······ ttft 1967ms  prefill 412 tok/s  decode 63.8 tok/s  total 14.2s
```

The gauge is a tachometer for decode speed. Its fill level uses the same decode
tok/s value shown in the line. The scale is linear from 0 to 400 tok/s, with
50 tok/s per cell. A 65 tok/s model lights one or two cells. A provider at 400
tok/s or more fills the gauge.

The complete line uses the theme warning color for 500 ms when new data
arrives. It then returns to its normal colors. The line stays unchanged while
the next turn runs. An aborted or invalid turn does not replace it.

## Commands

- `/speed` — show recent turns and per-model session averages
- `/speed clear` — reset history
- `/speed csv` — dump full history to `~/.pi/pi-speedometer-<timestamp>.csv`

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
- **Decode tok/s** — `answer_output / (turn_end - first_token)`. `answer_output` is `usage.output - (usage.reasoning ?? 0)`. Reasoning tokens are not included because the decode window starts at the first visible token. If the provider does not report reasoning usage, the raw `output` value is used.
- **Total** — the wall-clock time from `turn_start` to `turn_end`. Tool round-trips in the turn are included.
- **Gauge** — the completed turn's decode tok/s on a linear 0–400 scale. The gauge does not estimate speed while a turn runs.

Numbers come from `AssistantMessage.usage` plus pi's event timings.

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
