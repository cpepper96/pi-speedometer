# Keeping nixpkgs' nono in sync with upstream

Notes from investigating why the flake's nono (nixpkgs, 0.61.1) lags upstream
(0.67.1), and where a contribution would actually help. Written 2026-07-09.

## Why it lags

- **nono ships ~2–3 releases a week** — 15 releases between 2026-05-26 and
  2026-07-06 (0.58.0 → 0.67.1).
- **nixpkgs bumps are batched, human-reviewed PRs.** The last merged bump was
  0.57.0 → 0.61.1 on 2026-06-03. Two bump PRs are open and stalled:
  - [#531423](https://github.com/NixOS/nixpkgs/pull/531423) `0.61.1 -> 0.62.0`
    (r-ryantm, 2026-06-13, no review activity)
  - [#534847](https://github.com/NixOS/nixpkgs/pull/534847) `0.61.1 -> 0.65.1`
    (markus1189, 2026-06-24) — green `nixpkgs-review`, but a commenter found it
    still fails on **aarch64-darwin**: one more test needs excluding
    (`open_url_runtime::tests::test_open_url_helper_ipc_succeeds_when_supervisor_approves`,
    socket path too long). Waiting on that fix + a committer.
- The package builds nono **from source** with a ~50-entry `checkFlags` skip
  list (tests assume `git`/`.git` history, `/bin/pwd`, short socket paths,
  network, HOME not under `/nix`). Every release adds new failures needing
  human triage, so bumps aren't mechanical.
- Homebrew is at 0.67.1 because its autobump bot merges after a green bottle
  build; nixpkgs deliberately traded that speed for curation.

## Contribution options, by leverage

1. **Land the stalled PR.** Comment on #534847 with the missing darwin skip, or
   open a superseding PR bumping straight to 0.67.1. Run
   `nixpkgs-review pr 534847` locally first — aarch64-darwin test results are
   the scarce resource (Linux CI can't catch these failures).
2. **Become a co-maintainer.** The package has a single maintainer (`jk`).
   Adding yourself to `meta.maintainers` is a small PR; you then get pinged on
   every r-ryantm bump and your platform-specific reviews carry weight.
3. **Fix the root cause upstream in nono** (highest leverage). PRs to
   always-further/nono making tests detect-and-skip sandboxed-build conditions
   would shrink the `checkFlags` list toward zero, turning future bumps into
   rubber stamps. Relatedly: upstream ships no official flake — contributing
   one (or a FlakeHub release) would let consumers track releases directly and
   make nixpkgs cadence stop mattering.

## Why nixpkgs doesn't auto-merge

Automation already covers PR *creation* (r-ryantm bumps version, recomputes
`src`/`cargoHash`, test-builds, opens the PR). Auto-*merge* is deliberately
absent:

- Every nixpkgs commit is human-reviewed; the tree feeds NixOS systems and
  every `flake.lock` downstream, so an auto-merged compromised release
  propagates ecosystem-wide. nono is itself a security boundary — the worst
  candidate for unreviewed bumps.
- From-source builds mean a bump can pull in new deps, new test failures, or
  platform breakage (as every recent nono bump demonstrated).
- The real bottleneck is review bandwidth for single-maintainer packages —
  which is what options 1 and 2 address.

## Fallback for this repo

If a needed nono feature is stuck in the nixpkgs queue: overlay pinning the
upstream release binary (option considered and deferred during the dev-shell
design). Otherwise `nix flake update` picks up whatever nixpkgs has merged.
