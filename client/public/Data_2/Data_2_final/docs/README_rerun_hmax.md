# rerun_hmax -- SFINCS rerun with native depth (hmax) output

## Why this folder exists
The original 11-scenario batch produced `sfincs_map.nc` files **without** any
native depth variable (`zs/zsmax/zb` only), because no depth-output flag was
set. Peak depth had to be derived as `max(zsmax) - zb`, and the per-building
exposure analysis built on derived rasters ended up with corrupted
`design_T10/T25/T50` columns (proven: stored values contradict their own .nc
files; T5 matches exactly, T100 approximately).

These reruns are **byte-identical inputs** to the originals except two added
lines at the end of each `sfincs.inp`:

```
storehsubgrid        = 1     -> writes 'hmax' (= zsmax - z_zmin from the
                                 subgrid table) every dtmaxout = 24h band
storehmean           = 1     -> also writes the volume-mean variant
```

Physics, grid, forcing, timing are unchanged. Source of the flag semantics:
SFINCS docs, "Input parameters" -> storehsubgrid / storehmean.

Note the docs' own caveat: `storehsubgrid` hmax uses z_zmin (finest elevation
in each 100 m cell), so it is biased HIGH inside channel cells;
`storehmean` gives the volume-mean variant which avoids most of that bias.
Having both lets the exposure analysis pick/compare honestly.

## How to run
1. Open Docker Desktop.
2. Double-click `02_run_all_scenarios_hmax_docker.bat` (same logic as the
   original batch script; just points at this folder's `scenarios\`).
3. When all 11 finish: `python verify_hmax_rerun.py` and review
   `verify_hmax_report.json`. It checks status, presence/bands of hmax,
   agreement vs the derived field, design-storm monotonicity, and spot-checks
   the exact building pair that exposed the original bug.
4. Only after PASS should the building-exposure pipeline be re-run against
   these outputs.

Expected runtime: similar to the originals (~10-15 min/design storm,
~45-55 min for each historic event; several hours total).

## Which of the ORIGINAL scripts does what (the "3 scripts" question)
| Script | Purpose | Use again? |
|---|---|---|
| `..\02_run_all_scenarios_docker.bat` | Full batch via Docker (`deltares/sfincs-cpu`). **This is what actually produced the current 11 runs.** | Not for reruns - use this folder's version instead |
| `..\02_run_all_scenarios.bat` | Same batch via a LOCAL `sfincs.exe` (expects `C:\SFINCS\sfincs.exe`, downloaded from Deltares). | Never used here; ignore unless Docker is unavailable |
| `..\rerun_fixed_precip\03_rerun_underfilled_scenarios.bat` | One-off fix for the 4 precip-stop bug scenarios (P50/P75/P90/illustrative); copies corrected `sfincs.precip` then re-runs just those 4. | Already served its purpose 24 Aug - do NOT run again |

Rule of thumb: for any new full-model rerun, use a Docker variant pointing at
a fresh scenario-folder set (like this folder). The `.exe` variant only works
with a local Deltares release installed, and the precip-fix script must never
be re-applied (it would overwrite the corrected precip files with identical
copies - harmless but pointless).

## Contents
- `assemble_rerun_hmax.py` - builds `scenarios\<id>\` from the originals and
  patches the inp files (kept for provenance; already executed).
- `02_run_all_scenarios_hmax_docker.bat` - the batch runner.
- `verify_hmax_rerun.py` + `verify_hmax_report.json` - post-run verification.
- `scenarios\<id>\` - the 11 patched model roots (inputs only).
