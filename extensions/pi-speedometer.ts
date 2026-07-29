/**
 * pi-speedometer — display per-turn speed/timing metrics (TTFT, prefill tok/s, decode tok/s)
 *
 * Provider-agnostic; relies on standard pi events (turn_start, message_update,
 * turn_end) and the AssistantMessage.usage counts pi-ai already collects.
 *
 * Pi's own footer already shows ↑/↓/cache/cost/context/model, so this
 * extension intentionally only surfaces the *timing* numbers pi doesn't show.
 *
 * Status line (most recent turn):
 *   ttft 1967ms  prefill 412 tok/s  decode 63.8 tok/s  total 14.2s
 *
 * While a turn streams, the same status slot shows a live gauge for the
 * current turn only — fill level is decode tok/s on a linear 0–400 scale,
 * estimated from streamed characters and snapped to real usage at turn end:
 *   ⠹ ▁▂······ ~65 tok/s · ttft 812ms · 4.2s
 *
 * Commands:
 *   /speed         show recent turns and per-model session averages
 *   /speed clear   reset history
 *   /speed csv     dump full history to ~/.pi/pi-speedometer-<timestamp>.csv
 *   /speed live on|off   toggle the live gauge for this session
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
	decodeMs: number;
	totalMs: number;
}

interface Aggregate {
	n: number;          // turn count
	input: number;      // sum
	cacheWrite: number; // sum
	output: number;     // sum
	ttftMs: number;     // sum
	decodeMs: number;   // sum
	totalMs: number;    // sum
}

const DEFAULT_RECENT = 10;
const HISTORY_CAP = 1000;

// Live gauge (shown while a turn streams).
const LIVE_TICK_MS = 250;
const GAUGE_CELLS = 8;
const GAUGE_MAX_TPS = 400; // linear full scale; 50 tok/s per cell
const RAMP = "▁▂▃▄▅▆▇█";
const GAUGE_OFF = "·";
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const CHARS_PER_TOKEN = 4; // rough estimate; replaced by real usage at turn_end

// Minimal structural slices of pi's UI types, so helpers stay decoupled from
// which context (event vs command) they receive.
type ThemeLike = { fg(color: "accent" | "dim", text: string): string };
type UiLike = { setStatus(key: string, text: string | undefined): void; theme: ThemeLike };

// Render a number with `d` decimals, or "—" when not finite.
const r = (n: number, d = 0) => (Number.isFinite(n) ? n.toFixed(d) : "—");

// Wall-clock seconds with 1 decimal.
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

// Prefill numerator: tokens that actually had to be processed during TTFT.
// pi-ai already subtracts cacheRead+cacheWrite from `input`, so we add
// cacheWrite back (it's still real work this turn) but not cacheRead.
const prefillNumerator = (s: TurnStat) => s.input + s.cacheWrite;

const prefillTps = (s: TurnStat) => {
	const num = prefillNumerator(s);
	if (num <= 0 || s.ttftMs <= 0) return NaN;
	return num / (s.ttftMs / 1000);
};

const decodeTps = (s: TurnStat) =>
	s.decodeMs > 0 && s.output > 0 ? s.output / (s.decodeMs / 1000) : NaN;

const fmt = (s: TurnStat) =>
	`ttft ${s.ttftMs.toFixed(0)}ms  ` +
	`prefill ${r(prefillTps(s))} tok/s  ` +
	`decode ${r(decodeTps(s), 1)} tok/s  ` +
	`total ${secs(s.totalMs)}`;

// Ramp gauge: fill level = tps on a linear 0..GAUGE_MAX_TPS scale.
// Any nonzero speed lights at least one cell; unlit cells stay visible as dim dots.
const gauge = (tps: number, theme: ThemeLike): string => {
	const cells =
		!Number.isFinite(tps) || tps <= 0
			? 0
			: Math.min(GAUGE_CELLS, Math.max(1, Math.round((tps / GAUGE_MAX_TPS) * GAUGE_CELLS)));
	return (
		theme.fg("accent", RAMP.slice(0, cells)) +
		theme.fg("dim", GAUGE_OFF.repeat(GAUGE_CELLS - cells))
	);
};

function computeStat({
	model,
	usage,
	turnStart,
	firstTokenAt,
	turnEnd,
}: {
	model: string;
	usage: { input?: number; cacheRead?: number; cacheWrite?: number; output?: number };
	turnStart: number;
	firstTokenAt: number;
	turnEnd: number;
}): TurnStat {
	return {
		model,
		input: usage.input ?? 0,
		cacheRead: usage.cacheRead ?? 0,
		cacheWrite: usage.cacheWrite ?? 0,
		output: usage.output ?? 0,
		ttftMs: firstTokenAt - turnStart,
		decodeMs: turnEnd - firstTokenAt,
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
			decodeMs: 0,
			totalMs: 0,
		};

		a.n += 1;
		a.input += turn.input;
		a.cacheWrite += turn.cacheWrite;
		a.output += turn.output;
		a.ttftMs += turn.ttftMs;
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
	let firstTokenAt = 0;
	let recent = DEFAULT_RECENT;
	const history: TurnStat[] = [];

	// Live gauge state (current turn only).
	let liveEnabled = true;
	let liveTimer: ReturnType<typeof setInterval> | undefined;
	let streamedChars = 0;
	let liveTick = 0;

	const reset = () => {
		turnStart = 0;
		firstTokenAt = 0;
		streamedChars = 0;
	};

	const pushStat = (s: TurnStat) => {
		history.push(s);
		if (history.length > HISTORY_CAP) history.splice(0, history.length - HISTORY_CAP);
	};

	const liveLine = (theme: ThemeLike): string => {
		const now = performance.now();
		const spin = theme.fg("accent", SPINNER[liveTick % SPINNER.length]);
		if (!firstTokenAt) {
			const empty = theme.fg("dim", GAUGE_OFF.repeat(GAUGE_CELLS));
			return `${spin} ${empty} ${theme.fg("dim", `waiting… · ${secs(now - turnStart)}`)}`;
		}
		// Cumulative decode speed for this turn so far. The window spans tool
		// round-trips (matching the settled decode number), so the gauge sags
		// during tool calls and revs back when streaming resumes.
		const decodeSec = (now - firstTokenAt) / 1000;
		const tps = decodeSec > 0 ? streamedChars / CHARS_PER_TOKEN / decodeSec : NaN;
		const text =
			`~${r(tps)} tok/s · ` +
			`ttft ${(firstTokenAt - turnStart).toFixed(0)}ms · ` +
			secs(now - turnStart);
		return `${spin} ${gauge(tps, theme)} ${theme.fg("dim", text)}`;
	};

	const stopLive = () => {
		if (liveTimer) {
			clearInterval(liveTimer);
			liveTimer = undefined;
		}
	};

	const startLive = (ui: UiLike) => {
		stopLive();
		if (!liveEnabled) return;
		ui.setStatus("speedometer", liveLine(ui.theme));
		// setStatus triggers a footer repaint, so ticks stay visible even while
		// a tool runs and no stream deltas arrive.
		liveTimer = setInterval(() => {
			liveTick++;
			ui.setStatus("speedometer", liveLine(ui.theme));
		}, LIVE_TICK_MS);
	};

	pi.on("session_start", async (_e, ctx) => {
		history.length = 0;
		stopLive();
		reset();
		ctx.ui.setStatus("speedometer", undefined);
	});

	pi.on("session_shutdown", async (_e, ctx) => {
		stopLive();
		ctx.ui.setStatus("speedometer", undefined);
	});

	pi.on("turn_start", async (_e, ctx) => {
		turnStart = performance.now();
		firstTokenAt = 0;
		streamedChars = 0;
		startLive(ctx.ui);
	});

	pi.on("message_update", async (event) => {
		const ev = event.assistantMessageEvent;
		// Count every streamed character (text, thinking, tool-call args) for
		// the live output-token estimate.
		if (ev.type === "text_delta" || ev.type === "thinking_delta" || ev.type === "toolcall_delta") {
			streamedChars += ev.delta.length;
		}
		if (firstTokenAt) return;
		// Latch on the first *user-visible* delta. Skip thinking deltas so TTFT
		// reflects perceived latency on reasoning models.
		if (ev.type === "text_delta" || ev.type === "toolcall_delta") {
			firstTokenAt = performance.now();
		}
	});

	pi.on("turn_end", async (event, ctx) => {
		const turnEnd = performance.now();
		stopLive();
		const msg = event.message;
		if (!msg || msg.role !== "assistant" || !msg.usage || !firstTokenAt) {
			ctx.ui.setStatus("speedometer", undefined);
			reset();
			return;
		}

		const stat = computeStat({
			model: ctx.model?.id ?? msg.model ?? "unknown",
			usage: msg.usage,
			turnStart,
			firstTokenAt,
			turnEnd,
		});

		pushStat(stat);
		ctx.ui.setStatus("speedometer", ctx.ui.theme.fg("dim", fmt(stat)));
		reset();
	});

	pi.registerCommand("speed", {
		description:
			"Per-turn speed/timing metrics (ttft, prefill/decode tok/s). Keeps last 1000 turns. Subcommands: <n>, clear, csv, live on|off",
		handler: async (args, ctx) => {
			const sub = (args ?? "").trim().toLowerCase();

			if (sub === "live" || sub.startsWith("live ")) {
				const arg = sub.slice("live".length).trim();
				if (arg === "on") {
					liveEnabled = true;
					// Turn already in flight: pick it up immediately.
					if (turnStart > 0 && !liveTimer) startLive(ctx.ui);
					ctx.ui.notify("live gauge on", "info");
				} else if (arg === "off") {
					const wasRunning = liveTimer !== undefined;
					liveEnabled = false;
					stopLive();
					if (wasRunning) ctx.ui.setStatus("speedometer", undefined);
					ctx.ui.notify("live gauge off (this session)", "info");
				} else if (arg === "") {
					ctx.ui.notify(`live gauge is ${liveEnabled ? "on" : "off"} — /speed live on|off`, "info");
				} else {
					ctx.ui.notify(`Unknown argument: live ${arg}`, "warning");
				}
				return;
			}

			if (sub === "clear") {
				history.length = 0;
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
					"model,input,cacheRead,cacheWrite,output,ttftMs,decodeMs,totalMs,prefillTps,decodeTps";
				const rows = history.map((s) =>
					[
						JSON.stringify(s.model),
						s.input,
						s.cacheRead,
						s.cacheWrite,
						s.output,
						s.ttftMs.toFixed(1),
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
				const avgPrefill = prefillNum > 0 && a.ttftMs > 0 ? prefillNum / (a.ttftMs / 1000) : NaN;
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
