# Metrics and status behavior

## Measurements

- **TTFT** — the time from `turn_start` to the first `text_delta` or `toolcall_delta`. The extension uses `performance.now()`. Thinking deltas do not stop this timer. Thus, TTFT shows the latency that the user sees on reasoning models.
- **Prefill tok/s** — `(input + cacheWrite) / prefill_time`. Prefill time runs from `turn_start` to the first output delta of any kind, thinking included. It is not TTFT, because TTFT also spans thinking time on reasoning models. The calculation does not include `cacheRead`, because the provider did not process those tokens again. It includes `cacheWrite`, because the provider processed and wrote those tokens to the cache.
- **Decode tok/s** — `usage.output / (last_output_delta - first_output_delta)`. This calculation includes reasoning tokens because they are model output. The decode timer starts at the first thinking, text, or tool-call delta. It stops at the last delta. Thus, tool execution time in the turn does not change the decode rate. TTFT still ends at the first visible text or tool-call delta.
- **Total** — the time from `turn_start` to `turn_end`. This time includes tool round-trips in the turn.

The token counts come from `AssistantMessage.usage`. The timings come from pi events. Some providers do not stream reasoning deltas. For these providers, the first visible delta starts the decode timer and ends the prefill window. Hidden reasoning tokens then make the decode rate read too high and the prefill rate read too low.

## Gauge

The gauge uses the completed turn's decode tok/s value. It has twelve cells and a linear scale from 0 to 300 tok/s. Each cell represents 25 tok/s. Values at 300 tok/s or more fill the gauge. A speed above zero lights at least one cell.

The extension does not estimate speed while a turn runs. The last valid status line stays unchanged until the next valid turn ends. An aborted or invalid turn does not replace it.

When new data arrives, the complete status line uses the theme `warning` color for 500 ms. It then returns to its normal colors.

## History

The extension keeps up to 1,000 completed turns in memory for the current session. `/speed` shows recent turns and per-model session averages. `/speed csv` writes the stored turns to `~/.pi/pi-speedometer-<timestamp>.csv`. `/speed clear` removes the history and status line.
