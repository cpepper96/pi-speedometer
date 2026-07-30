# Metrics and status behavior

## Measurements

- **TTFT** — the time from `turn_start` to the first `text_delta` or `toolcall_delta`. The extension uses `performance.now()`. Thinking deltas do not stop this timer. Thus, TTFT shows the latency that the user sees on reasoning models.
- **Prefill tok/s** — `(input + cacheWrite) / ttft`. The calculation does not include `cacheRead`, because the provider did not process those tokens again. It includes `cacheWrite`, because the provider processed and wrote those tokens to the cache.
- **Decode tok/s** — `answer_output / (turn_end - first_token)`. `answer_output` is `usage.output - (usage.reasoning ?? 0)`. The calculation does not include reported reasoning tokens, because the decode time starts at the first visible token. If the provider does not report reasoning usage, the calculation uses the raw `output` value.
- **Total** — the time from `turn_start` to `turn_end`. This time includes tool round-trips in the turn.

The token counts come from `AssistantMessage.usage`. The timings come from pi events.

## Gauge

The gauge uses the completed turn's decode tok/s value. It has eight cells and a linear scale from 0 to 400 tok/s. Each cell represents 50 tok/s. Values at 400 tok/s or more fill the gauge.

The extension does not estimate speed while a turn runs. The last valid status line stays unchanged until the next valid turn ends. An aborted or invalid turn does not replace it.

When new data arrives, the complete status line uses the theme `warning` color for 500 ms. It then returns to its normal colors.

## History

The extension keeps up to 1,000 completed turns in memory for the current session. `/speed` shows recent turns and per-model session averages. `/speed csv` writes the stored turns to `~/.pi/pi-speedometer-<timestamp>.csv`. `/speed clear` removes the history and status line.
