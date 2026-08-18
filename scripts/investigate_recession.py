import xarray as xr
import numpy as np

MODEL_DIR = 'C:/NDMA/FLOOD_SIMULATION/mardan_full_real_model_FILLED'

for mm in ['050mm', '100mm', '150mm', '200mm']:
    ds = xr.open_dataset(f'{MODEL_DIR}/scenario_{mm}/sfincs_map.nc')
    h = ds.h.values  # (time, n, m)
    n_time = h.shape[0]

    # Global max depth at every one of the 121 real timesteps (not downsampled)
    max_per_step = np.nanmax(h.reshape(n_time, -1), axis=1)
    argmax_flat = np.nanargmax(h.reshape(n_time, -1), axis=1)  # which cell is the max, per step

    peak_idx = int(np.argmax(max_per_step))
    peak_val = max_per_step[peak_idx]
    final_val = max_per_step[-1]
    # recession = max value dropping meaningfully after the peak
    post_peak = max_per_step[peak_idx:]
    recession_amount = peak_val - float(np.min(post_peak))
    recession_pct = recession_amount / peak_val * 100 if peak_val > 0 else 0

    unique_argmax_cells = len(set(argmax_flat[peak_idx:].tolist()))

    print(f'=== {mm} ===')
    print(f'  peak at step {peak_idx}/{n_time-1} (t={ds.time.values[peak_idx]}), depth={peak_val:.3f}m')
    print(f'  final step depth={final_val:.3f}m')
    print(f'  min depth AFTER peak={float(np.min(post_peak)):.3f}m -> recession={recession_amount:.3f}m ({recession_pct:.1f}% of peak)')
    print(f'  distinct grid cells holding the global-max after peak: {unique_argmax_cells} (1 = stuck at one fixed cell)')
    print('  last 15 steps (global max depth):', [round(float(v), 3) for v in max_per_step[-15:]])
    ds.close()
