# sftools MCP server

Lets an MCP client (Claude Code, Claude Desktop) list, read, edit and solve the plans of the
Satisfactory Tools **desktop app**, using the app's own solver (`../headless/solve.ts`).

## Build

```bash
npm ci --prefix ..        # the app's dependencies (solver, highs)
npm ci
npm run build             # -> dist/server.mjs
npm run check             # type-check
node smoke.mjs <sftools-data folder> "<plan name>"   # runs every tool against a temp copy
```

## Register

```bash
claude mcp add sftools -- node <path-to>/mcp/dist/server.mjs
```

## Tools

| Tool | What |
|---|---|
| `list_plans` | Every plan: id, name, version id, requests. |
| `get_plan` | Settings, requests and inputs of one plan. |
| `find_game_data` | Search items / recipes / buildings of a plan's version, to get classNames. |
| `solve_plan` | Solve, optionally with what-if `settings` / `requests` overrides that are not saved. Returns buildings, raw resources vs limits, power, objective breakdown. |
| `update_plan` | Write `name`, `settings` (merged per key, `null` removes) and/or `requests` (replaced). Backs up the file first. |

## Things to know

- The app reads `sftools-data` **once at startup** and keeps it in memory. After `update_plan`:
  reload the app (Ctrl+R) or restart it, open the plan, press **Calculate** (opening a plan does not re-solve).
  Editing the plan in the app before reloading makes the app overwrite the change.
- Backups go to `%LOCALAPPDATA%\sftools-mcp\backups`, outside `sftools-data` (the app loads every `.json` in there).
- Game data comes from the public API per version and is cached in `%LOCALAPPDATA%\sftools-mcp\cache`.
- Not supported: subplans and shared resource pools (folders); signed-in accounts whose plans sync to the server.

| Env var | Default |
|---|---|
| `SFTOOLS_DATA_DIR` | `%APPDATA%\com.satisfactorytools.desktop\sftools-data` |
| `SFTOOLS_BACKUP_DIR` | `%LOCALAPPDATA%\sftools-mcp\backups` |
| `SFTOOLS_MOD_FILES` | `;`-separated mod JSON files applied to every version, to try a mod locally |
