# Industrial Evolution (MkPlus) for Satisfactory Tools

`industrial-evolution.json` is a Satisfactory Tools mod file (the mod editor's `{data, metadata}` format). It adds
the mod's faster machine and generator tiers, and lists them in `producedIn` of every recipe the vanilla machine makes,
so the solver picks between tiers itself.

| Tier (planner className infix) | Machines | Generators |
|---|---|---|
| `MkPlusLite_Mk2` - "Mk.2 (IE Lite)" | 2× speed, 2× power | 2× |
| `MkPlus_Mk2` - "Mk.2 (IE)" | 3× speed, 3× power | 4× |
| `MkPlus_Mk3` - "Mk.3 (IE)" | 5× speed, 5× power | 8× |

Power scales linearly with clock speed (`powerUsageExponent: 1`, the mod's default "Linear" overclock mode).
Covered: Constructor, Smelter, Assembler, Foundry, Manufacturer, Refinery, Packager, Blender; Coal, Fuel, Nuclear and
automated Biomass generators. Not covered: Converter, Particle Accelerator, Quantum Encoder (variable power), extractors
(the planner models mining as resource limits, not machines), geothermal (a plan setting).

Lite and full MkPlus reuse the same in-game class names (`/MkPlus/.../Build_Constructor_Mk2_C` and
`/MkPlusLite/.../Build_Constructor_Mk2_C`), so the planner ids are prefixed with the tier, e.g.
`Desc_MkPlus_Mk3_ConstructorMk1_C`.

## Where the numbers come from

MkPlus multipliers are per-save "Mod Savegame Settings". The defaults (Mk2 3×, Mk3 5×, generators 4× / 8×) come from the
setting tooltips in the mod's pak; Lite is fixed at 2×. Both were checked against a save's live machine power draw:
a full Mk2 Constructor at 100% draws 12 MW, a Lite Assembler Mk2 30 MW, and draw is linear in clock speed.
If your save uses other values, edit `TIERS` in `build.ts` and rebuild.

## Build

```bash
../../node_modules/.bin/esbuild build.ts --bundle --platform=node --format=esm --outfile=dist/build.mjs --tsconfig=../../tsconfig.json
node dist/build.mjs <base version data file> industrial-evolution.json
```

The base data file is the version's `GET <api>/<dataPath>`; the MCP server caches it in `%LOCALAPPDATA%\sftools-mcp\cache`.
The output is checked with the app's own `ModDataValidator`.

## Use

- **Headless / MCP:** start the MCP server with `SFTOOLS_MOD_FILES=<path>\industrial-evolution.json`.
- **In the app:** create a mod (needs sign-in), paste the file in its mod editor, then create a custom version with
  the mod (and your world, via *Load from save…* on `feat/world-from-save`).

Plan settings that matter with more than one tier:

- `disabledMachines` now works per machine (fix in `ProductionSolverService.allowedRecipes`), so tiers you have not
  unlocked can be switched off. Machines you disabled in vanilla (e.g. Blender) need their tiers disabled too.
- Generators are picked by `enabledFuels`, keyed per generator - add the tier generators there.
- With the default goals (resources + power) tiers tie with vanilla on power per output, so the solver may stay on
  vanilla machines. Enable the machine-count goal to prefer the fewest, fastest machines.
