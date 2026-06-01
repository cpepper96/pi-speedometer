# pi-speedometer

A per-turn speedometer for [pi](https://pi.dev): TTFT(Time-to-first-token), prefill tok/s, decode tok/s, and total wall time.

Pi's built-in footer already shows tokens, cache, cost, context, and model. This extension surfaces the *timing* numbers it doesn't show.

## Status line

After each turn, pi's status area shows:

```txt
ttft 1967ms  prefill 412 tok/s  decode 63.8 tok/s  total 14.2s
```

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

## How it's measured

- **TTFT** — `performance.now()` from `turn_start` to the first `text_delta` or `toolcall_delta` (thinking deltas are skipped so TTFT reflects perceived latency on reasoning models).
- **Prefill tok/s** — `(input + cacheWrite) / ttft`. `cacheRead` is excluded because those tokens didn't require real prefill work this turn. `cacheWrite` is included because those tokens were processed *and* persisted to cache.
- **Decode tok/s** — `output / (turn_end - first_token)`.
- **Total** — wall-clock from `turn_start` to `turn_end`, including any tool round-trips inside the turn.

Numbers come from `AssistantMessage.usage` (provider-agnostic) plus pi's own event timings, so any provider pi supports will report.

## License

MIT
