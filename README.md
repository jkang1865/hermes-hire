# hermes-hire

CLI wizard for spinning up new [Hermes Agent](https://github.com/hermes-agent) profiles
and registering them in [Paperclip](https://github.com/anthropics/paperclip). Built for
multi-tenant machines — each business venture gets its own profile group, all sharing the
same Hermes installation.

## Quick start

**Interactive mode** — answers questions one-by-one:

```bash
node ~/hermes-hire/index.js
```

**Non-interactive mode** — pass everything via flags (ideal for Telegram triggers):

```bash
node ~/hermes-hire/index.js \
  --role cmo \
  --title "Chief Marketing Officer" \
  --purpose "Handles ASO and social content" \
  --toolsets web,file,browser \
  --budget 5 \
  --telegram-token "123456:ABC" \
  --donor shelfscout-coder \
  --company-prefix shelfscout
```

## What it does

1. **Discovers donor profile** — lists `~/.hermes/profiles/` and extracts model/provider/API keys
2. **Collects configuration** — role, title, purpose, toolsets, budget, Telegram token
3. **Creates the profile** — clones from donor, writes SOUL.md, sets toolsets, configures terminal cwd
4. **Registers in Paperclip** — POSTs agent metadata to `http://localhost:3100/api/agents`
5. **Prints a summary** — profile name, model, toolsets, gateway status, Telegram bot handle

## Options

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--role` | Yes (non-interactive) | — | Agent role slug (e.g. `cmo`, `cro`) |
| `--title` | Yes | — | Full job title |
| `--purpose` | Yes | — | 1-2 sentence purpose → first line of SOUL.md |
| `--toolsets` | No | `web,file` | Comma-separated toolset names |
| `--budget` | No | `5` | Monthly budget in USD |
| `--telegram-token` | No | — | Telegram bot token. If omitted, gateway setup is skipped |
| `--donor` | Yes | — | Existing profile to clone from |
| `--company-prefix` | Yes (non-interactive) | — | All profiles named `<prefix>-<role>` |
| `--help`, `-h` | — | — | Show help and exit |

## Dependencies

- Node.js (uses `fs`, `path`, `os`, `child_process`, `readline/promises`)
- [`js-yaml`](https://www.npmjs.com/package/js-yaml) — YAML manipulation for config.yaml
- [`hermes`](https://github.com/hermes-agent) CLI installed on PATH
- Telegram Bot API reachability (for username verification via `getMe`)

## Profile Isolation Notes

### The `~` trap in multi-profile Hermes environments

When an agent runs, Hermes redirects `$HOME` so that `~` expands to a **nested profile
workspace**, not the real system home:

```
~ → ~/.hermes/profiles/<profile-name>/home     (HERMES_HOME)
    → /home/<user>/.hermes/profiles/foo/home   (example)
```

`os.homedir()` and `process.env.HOME` return this same nested path because Hermes
modifies HOME at process start.

### Implications for profile provisioning

1. **`terminal.cwd = "~"` is silently broken** — the agent's terminal subprocess starts
   in the nested workspace (`~/.hermes/profiles/foo/home/`), making it impossible to
   `cd`, `ls`, or run commands in real system directories.

2. **`os.homedir()` is equally wrong** — it returns the same nested workspace path,
   not `/home/<user>`. Do not use it for `terminal.cwd`.

3. **Don't blindly clone the donor's `terminal.cwd`** — if the donor profile has
   `terminal.cwd: "~"` or `terminal.cwd: "~/"`, that was already broken for the same
   reason. Treat any tilde-based cwd as a known antipattern.

4. **Resolve the real system home at provision time** — this tool uses `getRealHome()`,
   which walks up from `$HOME` looking for a parent directory containing
   `.hermes/profiles`. That parent is the actual system home:

   ```
   /foo/home → /foo → /bar/.hermes/profiles/ exists → returns parent "/bar"
   ```

   On a normal machine where `$HOME` is not redirected, this returns `$HOME` unchanged.

5. **The gateway needs absolute paths** — systemd service files embed `HERMES_HOME`
   and `ExecStart` with absolute paths only. If the cwd is a tilde-path, the service
   starts in the wrong directory.

### Verified fix

This was discovered during provisioning of `john-pm-job-hunter`. The donor had
`terminal.cwd: "~"` which resolved to
`/home/sneedemfeedem/.hermes/profiles/shelfscout-coder/home` instead of
`/home/sneedemfeedem/`. The agent's terminal tool could not access the host filesystem.

Fix: set `terminal.cwd` to the absolute real home path (`REAL_HOME`), resolved via the
`getRealHome()` walk-up algorithm.

## License

MIT
