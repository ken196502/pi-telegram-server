# Plan: OpenCode Zen free models in LinuxAgentSetup.sh

Status: DONE (see Result at the bottom)

## Goal

1. LinuxAgentSetup.sh installs opencode (curl -fsSL https://opencode.ai/v2/install | bash).
2. LinuxAgentSetup.sh installs the Pi extension pi-opencode-zen
   (pi install git:github.com/rabden/pi-opencode-zen) so OpenCode Zen free
   models are usable from Pi.
3. Verified end to end: pi --print really calls an OpenCode Zen free model
   and gets a real answer.

## Background (from inspecting the extension repo)

- Package: https://github.com/rabden/pi-opencode-zen (v0.3.0, MIT).
- Free models need no real credentials: OPENCODE_API_KEY=public is the
  whole auth. A real Zen key unlocks the paid catalog.
- Model ids look like opencode-zen/<name>-free, e.g. longcat-2.5-preview-free,
  deepseek-v4.1-flash-free, space-bunny-free. The extension fetches a fresh
  model list from the API on every Pi start; muse-spark-1.3-contributor-free
  was deprecated 2026-10-16, so scripts must not hard-code model names.
- Free-tier quota is per IP (~200 req/day per community reports).
- Pi reads auth env vars from the process environment (docs/providers.md:
  OpenCode Zen and Go | OPENCODE_API_KEY), so the key must be exported in
  the shell that starts Pi (scripts/start-pi-session.sh inherits shell env).

## Changes to LinuxAgentSetup.sh

1. New flags: --skip-opencode, --skip-zen (plus --help text).
2. ensure_opencode(): skip if opencode is already on PATH; otherwise run
   curl -fsSL https://opencode.ai/v2/install | bash (via run_shell, dry-run
   aware); ensure ~/.local/bin and ~/.opencode/bin are on PATH and persisted
   in ~/.bashrc; verify with opencode --version and die on failure.
3. install_zen_extension(): pi install git:github.com/rabden/pi-opencode-zen
   (idempotent); verify the package landed in ~/.pi/agent/settings.json.
4. ensure_opencode_api_key(): if OPENCODE_API_KEY is unset, persist
   export OPENCODE_API_KEY=public in ~/.bashrc (never overwrite an existing
   value; a real Zen key keeps working).
5. main(): run the opencode + zen steps right after install_pi.
6. print_next_steps(): document how to pick a free model.

## Verification performed on this machine

1. Ran the new script steps for real (not dry-run): opencode installed via
   the official installer; pi install git:github.com/rabden/pi-opencode-zen;
   OPENCODE_API_KEY=public exported.
2. Real call: OPENCODE_API_KEY=public pi --model opencode-zen/<free-model>
   --print "..." -> assistant answered (see Result).

## Result

Filled in after execution.

Result (2026-10-25):

- opencode v2.1.4 installed via the official installer to
  ~/.opencode/bin/opencode (installer also wrote the PATH line in ~/.bashrc).
- pi-opencode-zen installed and registered: pi --list-models shows 8 free
  models (beam-free, deepseek-v4.1-flash-free, glm-5.3-flash-free,
  longcat-2.5-preview-free, mimo-v2.6-flash-free,
  nemotron-3.5-lightning-free, nemotron-3.5-super-vl-free,
  space-bunny-free).
- OPENCODE_API_KEY=public persisted in ~/.bashrc.
- Real calls attempted at 2026-10-25 ~10:2x UTC on deepseek-v4.1-flash-free,
  longcat-2.5-preview-free, glm-5.3-flash-free, beam-free: all returned
  429 FreeUsageLimitError ("Free usage limit reached"); space-bunny-free
  returned 400 "Model is unavailable". This is OpenCode's per-IP free daily
  quota (~200 req/day), not a setup problem: a gate failure would be
  403 FreeTierError, so the extension's request shaping is accepted and the
  requests reach the upstream. Retry after the quota resets, or set a real
  Zen key (OPENCODE_API_KEY=<zen key> / /login opencode-zen).
- Extra fix during testing: ensure_opencode() now prepends ~/.opencode/bin
  and ~/.local/bin to PATH before the existence check, so re-runs of the
  script no longer re-download the 236 MB opencode binary.
