import xarray as xr
import numpy as np

def analyze(model_dir, label):
    print(f'\n========== {label} ==========')
    for mm in ['050mm', '100mm', '150mm', '200mm']:
        path = f'{model_dir}/scenario_{mm}/sfincs_map.nc'
        ds = xr.open_dataset(path)
        if len(ds.time) != 121:
            print(f'{mm}: INCOMPLETE - only {len(ds.time)} of 121 timesteps')
            ds.close()
            continue
        h = ds.h.values  # (time, n, m)
        n_time = h.shape[0]
        flat = h.reshape(n_time, -1)

        # Metric 1: raw global max (sensitive to a single stuck sink cell)
        max_per_step = np.nanmax(flat, axis=1)

        # Metric 2: 99.5th percentile of wet cells at each step (robust to
        # a handful of anomalous single-cell sinks skewing the true signal)
        p995_per_step = np.nanpercentile(np.where(flat > 0.03, flat, np.nan), 99.5, axis=1)

        # Metric 3: total flooded volume proxy = sum of depth over all wet
        # cells (catches "is water draining out of the domain overall")
        vol_per_step = np.nansum(np.where(flat > 0.03, flat, 0), axis=1)

        def peak_and_recession(series):
            pk = int(np.argmax(series))
            pkval = series[pk]
            post = series[pk:]
            recession = pkval - float(np.min(post))
            pct = recession / pkval * 100 if pkval > 0 else 0
            return pk, pkval, recession, pct

        pk1, v1_, r1, r1p = peak_and_recession(max_per_step)
        pk2, v2_, r2, r2p = peak_and_recession(p995_per_step)
        pk3, v3_, r3, r3p = peak_and_recession(vol_per_step)

        print(f'{mm}:')
        print(f'  global max     : peak={v1_:.2f}m @ step{pk1}, recession={r1:.2f}m ({r1p:.1f}%)')
        print(f'  99.5pct depth  : peak={v2_:.2f}m @ step{pk2}, recession={r2:.2f}m ({r2p:.1f}%)')
        print(f'  total flood vol: peak={v3_:.0f} @ step{pk3}, recession={r3:.0f} ({r3p:.1f}%)')
        print(f'  vol last 10 steps: {[round(float(v),0) for v in vol_per_step[-10:]]}')
        ds.close()

analyze('C:/NDMA/FLOOD_SIMULATION/mardan_full_real_model_FILLED', 'V1 (_FILLED)')
analyze('C:/NDMA/FLOOD_SIMULATION/mardan_full_real_model_FILLED_v2', 'V2 (_FILLED_v2)')
