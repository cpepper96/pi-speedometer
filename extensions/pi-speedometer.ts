/**
 * pi-speedometer — display per-turn speed/timing metrics (TTFT, prefill tok/s, decode tok/s)
 *
 * Relies on standard pi events (turn_start, message_update, turn_end) and the
 * AssistantMessage.usage counts pi-ai already collects.
 *
 * Pi's own footer already shows ↑/↓/cache/cost/context/model, so this
 * extension intentionally only surfaces the *timing* numbers pi doesn't show.
 *
 * Status line (most recent turn) — the gauge uses the final decode tok/s
 * from real usage and stays unchanged until the next valid turn ends:
 *   ▁▁·········· ttft 1967ms  prefill 412 tok/s  decode 63.8 tok/s  total 14.2s
 *
 * When new data arrives, the complete line uses the theme warning color for
 * 500 ms. It then returns to its normal gauge and text colors.
 *
 * Commands:
 *   /speed         show recent turns and per-model session averages
 *   /speed clear   reset history
 *   /speed csv     dump full history to ~/.pi/pi-speedometer-<timestamp>.csv
 *
 * Install:
 *   pi install npm:pi-speedometer
 * Or try without installing:
 *   pi -e npm:pi-speedometer
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface TurnStat {
	model: string;
	// Token counts (pi-ai semantics: `input` is uncached prompt tokens only).
	input: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
	// Timings (monotonic ms from performance.now()).
	ttftMs: number;
	prefillMs: number;
	decodeMs: number;
	totalMs: number;
}

interface Aggregate {
	n: number;          // turn count
	input: number;      // sum
	cacheWrite: number; // sum
	output: number;     // sum
	ttftMs: number;     // sum
	prefillMs: number;  // sum
	decodeMs: number;   // sum
	totalMs: number;    // sum
}

const DEFAULT_RECENT = 10;
const HISTORY_CAP = 1000;

const FLASH_MS = 500;
const GAUGE_CELLS = 12;
const GAUGE_MAX_TPS = 300; // linear full scale; 25 tok/s per cell
const RAMP = "▁▂▃▄▅▆▇█";
// The 8 ramp glyphs stretched across the gauge width, one glyph per cell.
const GAUGE_RAMP = Array.from(
	{ length: GAUGE_CELLS },
	(_, i) => RAMP[Math.floor((i * RAMP.length) / GAUGE_CELLS)],
).join("");
const GAUGE_OFF = "·";

// Minimal structural slice of pi's theme type, so helpers stay decoupled from
// which context (event vs command) they receive.
type ThemeLike = { fg(color: "accent" | "dim" | "warning", text: string): string };

// Render a number with `d` decimals, or "—" when not finite.
const r = (n: number, d = 0) => (Number.isFinite(n) ? n.toFixed(d) : "—");

// Wall-clock seconds with 1 decimal.
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

// Prefill numerator: tokens that actually had to be processed before output.
// pi-ai already subtracts cacheRead+cacheWrite from `input`, so we add
// cacheWrite back (it's still real work this turn) but not cacheRead.
const prefillNumerator = (s: TurnStat) => s.input + s.cacheWrite;

// Prefill window ends at the first output delta of any kind (thinking
// included), not at TTFT — on reasoning models TTFT also spans thinking time,
// which is decode work, not prompt processing.
const prefillTps = (s: TurnStat) => {
	const num = prefillNumerator(s);
	if (num <= 0 || s.prefillMs <= 0) return NaN;
	return num / (s.prefillMs / 1000);
};

// Decode includes all output tokens. Its window runs from the first output
// delta to the last output delta, so tool execution after the stream (which
// happens before turn_end) is excluded.
// TTFT ends at the first visible delta, so it can include reasoning time.
const decodeTps = (s: TurnStat) =>
	s.decodeMs > 0 && s.output > 0 ? s.output / (s.decodeMs / 1000) : NaN;

const fmt = (s: TurnStat) =>
	`ttft ${s.ttftMs.toFixed(0)}ms  ` +
	`prefill ${r(prefillTps(s))} tok/s  ` +
	`decode ${r(decodeTps(s), 1)} tok/s  ` +
	`total ${secs(s.totalMs)}`;

// Ramp gauge: fill level = tps on a linear 0..GAUGE_MAX_TPS scale, floored so
// each cell represents exactly GAUGE_MAX_TPS/GAUGE_CELLS tok/s.
// Any nonzero speed lights at least one cell; unlit cells stay visible as dim dots.
const gaugeCells = (tps: number) =>
	!Number.isFinite(tps) || tps <= 0
		? 0
		: Math.min(GAUGE_CELLS, Math.max(1, Math.floor((tps / GAUGE_MAX_TPS) * GAUGE_CELLS)));

const gaugeText = (tps: number): string => {
	const cells = gaugeCells(tps);
	return GAUGE_RAMP.slice(0, cells) + GAUGE_OFF.repeat(GAUGE_CELLS - cells);
};

const gauge = (tps: number, theme: ThemeLike): string => {
	const cells = gaugeCells(tps);
	return (
		theme.fg("accent", GAUGE_RAMP.slice(0, cells)) +
		theme.fg("dim", GAUGE_OFF.repeat(GAUGE_CELLS - cells))
	);
};

const statusLine = (s: TurnStat, theme: ThemeLike): string =>
	`${gauge(decodeTps(s), theme)} ${theme.fg("dim", fmt(s))}`;

const flashLine = (s: TurnStat, theme: ThemeLike): string =>
	theme.fg("warning", `${gaugeText(decodeTps(s))} ${fmt(s)}`);

function computeStat({
	model,
	usage,
	turnStart,
	firstVisibleTokenAt,
	firstOutputTokenAt,
	lastOutputTokenAt,
	turnEnd,
}: {
	model: string;
	usage: {
		input?: number;
		cacheRead?: number;
		cacheWrite?: number;
		output?: number;
	};
	turnStart: number;
	firstVisibleTokenAt: number;
	firstOutputTokenAt: number;
	lastOutputTokenAt: number;
	turnEnd: number;
}): TurnStat {
	return {
		model,
		input: usage.input ?? 0,
		cacheRead: usage.cacheRead ?? 0,
		cacheWrite: usage.cacheWrite ?? 0,
		output: usage.output ?? 0,
		ttftMs: firstVisibleTokenAt - turnStart,
		prefillMs: firstOutputTokenAt - turnStart,
		decodeMs: lastOutputTokenAt - firstOutputTokenAt,
		totalMs: turnEnd - turnStart,
	};
}

function aggregateByModel(history: readonly TurnStat[]): Map<string, Aggregate> {
	const m = new Map<string, Aggregate>();

	for (const turn of history) {
		const a = m.get(turn.model) ?? {
			n: 0,
			input: 0,
			cacheWrite: 0,
			output: 0,
			ttftMs: 0,
			prefillMs: 0,
			decodeMs: 0,
			totalMs: 0,
		};

		a.n += 1;
		a.input += turn.input;
		a.cacheWrite += turn.cacheWrite;
		a.output += turn.output;
		a.ttftMs += turn.ttftMs;
		a.prefillMs += turn.prefillMs;
		a.decodeMs += turn.decodeMs;
		a.totalMs += turn.totalMs;

		m.set(turn.model, a);
	}
	return m;
}

function formatRecent(history: readonly TurnStat[], n: number): string[] {
	const recentTurns = history.slice(-n);
	return [
		`Recent turns (last ${recentTurns.length}):`,
		...recentTurns.map((s) => `  ${fmt(s)}  [${s.model}]`),
	];
}

export default function (pi: ExtensionAPI) {
	let turnStart = 0;
	let firstVisibleTokenAt = 0;
	let firstOutputTokenAt = 0;
	let lastOutputTokenAt = 0;
	let recent = DEFAULT_RECENT;
	const history: TurnStat[] = [];

	let flashTimer: ReturnType<typeof setTimeout> | undefined;

	const reset = () => {
		turnStart = 0;
		firstVisibleTokenAt = 0;
		firstOutputTokenAt = 0;
		lastOutputTokenAt = 0;
	};

	const pushStat = (s: TurnStat) => {
		history.push(s);
		if (history.length > HISTORY_CAP) history.splice(0, history.length - HISTORY_CAP);
	};

	const stopFlash = () => {
		if (flashTimer) {
			clearTimeout(flashTimer);
			flashTimer = undefined;
		}
	};

	pi.on("session_start", async (_e, ctx) => {
		history.length = 0;
		stopFlash();
		reset();
		ctx.ui.setStatus("speedometer", undefined);
	});

	pi.on("session_shutdown", async (_e, ctx) => {
		stopFlash();
		ctx.ui.setStatus("speedometer", undefined);
	});

	pi.on("turn_start", async () => {
		turnStart = performance.now();
		firstVisibleTokenAt = 0;
		firstOutputTokenAt = 0;
		lastOutputTokenAt = 0;
	});

	pi.on("message_update", async (event) => {
		const ev = event.assistantMessageEvent;
		if (ev.type !== "thinking_delta" && ev.type !== "text_delta" && ev.type !== "toolcall_delta") {
			return;
		}
		const now = performance.now();
		if (!firstOutputTokenAt) firstOutputTokenAt = now;
		lastOutputTokenAt = now;
		if (!firstVisibleTokenAt && ev.type !== "thinking_delta") {
			// Skip thinking deltas so TTFT reflects perceived latency.
			firstVisibleTokenAt = now;
		}
	});

	pi.on("turn_end", async (event, ctx) => {
		const turnEnd = performance.now();
		const msg = event.message;
		if (
			!msg ||
			msg.role !== "assistant" ||
			!msg.usage ||
			// Aborted/errored turns have partial usage and timings; keep the
			// previous status line instead of recording a misleading stat.
			msg.stopReason === "aborted" ||
			msg.stopReason === "error" ||
			!firstVisibleTokenAt ||
			!firstOutputTokenAt
		) {
			reset();
			return;
		}

		const stat = computeStat({
			model: ctx.model?.id ?? msg.model ?? "unknown",
			usage: msg.usage,
			turnStart,
			firstVisibleTokenAt,
			firstOutputTokenAt,
			lastOutputTokenAt,
			turnEnd,
		});

		pushStat(stat);
		stopFlash();
		ctx.ui.setStatus("speedometer", flashLine(stat, ctx.ui.theme));
		flashTimer = setTimeout(() => {
			ctx.ui.setStatus("speedometer", statusLine(stat, ctx.ui.theme));
			flashTimer = undefined;
		}, FLASH_MS);
		reset();
	});

	pi.registerCommand("speed", {
		description:
			"Per-turn speed/timing metrics (ttft, prefill/decode tok/s). Keeps last 1000 turns. Subcommands: <n>, clear, csv",
		handler: async (args, ctx) => {
			const sub = (args ?? "").trim().toLowerCase();

			if (sub === "clear") {
				history.length = 0;
				stopFlash();
				ctx.ui.setStatus("speedometer", undefined);
				ctx.ui.notify("speed history cleared", "info");
				return;
			}

			if (sub === "csv") {
				if (!history.length) {
					ctx.ui.notify("No turns to export.", "info");
					return;
				}
				const header =
					"model,input,cacheRead,cacheWrite,output,ttftMs,prefillMs,decodeMs,totalMs,prefillTps,decodeTps";
				const rows = history.map((s) =>
					[
						JSON.stringify(s.model),
						s.input,
						s.cacheRead,
						s.cacheWrite,
						s.output,
						s.ttftMs.toFixed(1),
						s.prefillMs.toFixed(1),
						s.decodeMs.toFixed(1),
						s.totalMs.toFixed(1),
						r(prefillTps(s), 2),
						r(decodeTps(s), 2),
					].join(","),
				);
				const path = join(homedir(), ".pi", `pi-speedometer-${Date.now()}.csv`);
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, [header, ...rows].join("\n") + "\n");
				ctx.ui.notify(`Wrote ${history.length} turns to ${path}`, "info");
				return;
			}

			if (sub && /^\d+$/.test(sub)) {
				const n = parseInt(sub, 10);
				if (n < 1) {
					ctx.ui.notify("n must be ≥ 1", "warning");
					return;
				}
				recent = n;
			} else if (sub) {
				ctx.ui.notify(`Unknown subcommand: ${sub}`, "warning");
				return;
			}

			if (!history.length) {
				ctx.ui.notify("No turns yet.", "info");
				return;
			}

			const lines = formatRecent(history, recent);

			// Per-model session aggregates.
			const byModel = aggregateByModel(history);

			lines.push("");
			lines.push("Session averages:");
			for (const [model, a] of byModel) {
				const prefillNum = a.input + a.cacheWrite;
				const avgPrefill =
					prefillNum > 0 && a.prefillMs > 0 ? prefillNum / (a.prefillMs / 1000) : NaN;
				const avgDecode = a.output > 0 && a.decodeMs > 0 ? a.output / (a.decodeMs / 1000) : NaN;
				lines.push(
					`  [${model}] ${a.n} turns  ` +
						`avg ttft ${(a.ttftMs / a.n).toFixed(0)}ms  ` +
						`prefill ${r(avgPrefill)} tok/s  ` +
						`decode ${r(avgDecode, 1)} tok/s  ` +
						`avg total ${secs(a.totalMs / a.n)}`,
				);
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
