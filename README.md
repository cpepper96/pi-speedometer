# pi-speedometer

A per-turn speedometer for [pi](https://pi.dev). It adds these model performance metrics to pi's status line:

- time to first token (TTFT)
- prefill tokens per second
- decode tokens per second
- total turn time
- a gauge for decode speed

```txt
▁▂······ ttft 1967ms  prefill 412 tok/s  decode 63.8 tok/s  total 14.2s
```

The status updates after each completed model turn. It briefly changes color when new data arrives, then stays visible until the next update.

## Commands

- `/speed` — show recent turns and per-model session averages
- `/speed clear` — reset history
- `/speed csv` — export history as CSV

## Install

```bash
pi install npm:pi-speedometer
```

Or try it without installing:

```bash
pi -e npm:pi-speedometer
```

For calculation details and status behavior, see [Metrics and status behavior](docs/metrics.md).

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
