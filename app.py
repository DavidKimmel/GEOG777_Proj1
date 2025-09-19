# app.py — Flask backend for GEOG 577 Project 1

from pathlib import Path
import os
import json
import time
import threading
import webbrowser
import traceback

from flask import Flask, request, jsonify, send_from_directory

# --- Config ---
ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
OUTPUTS = ROOT / "outputs"
SHPS = STATIC / "shapefiles"

HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", 3000))

# Lazily created singleton for data/pipeline
_project_data = None

def get_project_data():
    """Singleton accessor for ProjectData."""
    global _project_data
    if _project_data is None:
        from processing.pipeline import ProjectData
        _project_data = ProjectData(SHPS, OUTPUTS)
    return _project_data

def _open_browser_once():
    # Only open in the Werkzeug reloader's main process (prevents double tabs)
    if os.environ.get("WERKZEUG_RUN_MAIN") == "true":
        def _open():
            time.sleep(0.8)
            webbrowser.open(f"http://{HOST}:{PORT}")
        threading.Thread(target=_open, daemon=True).start()

app = Flask(__name__, static_folder=str(STATIC), static_url_path="/static")

# ---------- Static pages ----------
@app.get("/")
def index():
    return app.send_static_file("index.html")

# Serve generated outputs (PNG/CSV/GeoJSON/etc.)
@app.get("/outputs/<path:filename>")
def outputs(filename):
    return send_from_directory(str(OUTPUTS), filename, conditional=True)

# ---------- API: Run (single k) ----------
@app.post("/api/run")
def api_run():
    payload   = request.get_json(silent=True) or {}
    k         = float(payload.get("k", 2.0))
    neighbors = int(payload.get("neighbors", 12))
    cell_size = int(payload.get("cell_size", 1000))
    print(f"[api_run] start k={k} neighbors={neighbors} cell={cell_size}", flush=True)

    pd = get_project_data()

    # Optional: short-circuit if precomputed files exist
    tag = f"{float(k):.1f}"
    png_path = OUTPUTS / f"nitrate_k{tag}.png"
    csv_path = OUTPUTS / f"tract_table_k{tag}.csv"
    gj_path  = OUTPUTS / f"tracts_k{tag}.geojson"
    bounds_path = OUTPUTS / "bounds.json"

    try:
        if png_path.exists() and csv_path.exists() and gj_path.exists():
            # Recompute OLS quickly from CSV to keep fields in sync with fresh path
            import pandas as _pd
            import numpy as _np
            import statsmodels.api as _sm

            df  = _pd.read_csv(csv_path)
            dfc = df.dropna(subset=["mean_nitrate", "canrate"]).copy()
            n_obs = int(len(dfc))

            # Unit inference (proportion vs raw/per-100k)
            try:
                max_rate = float(_np.nanmax(df["canrate"].to_numpy()))
            except Exception:
                max_rate = float("nan")
            is_proportion = bool(_np.isfinite(max_rate) and max_rate <= 1.0)
            rate_units = "proportion" if is_proportion else "raw"
            rate_scale = 100000 if is_proportion else 1

            if n_obs >= 2:
                X = _sm.add_constant(dfc["mean_nitrate"].to_numpy())
                y = dfc["canrate"].to_numpy()
                model = _sm.OLS(y, X).fit()
                slope = float(model.params[1])
                intercept = float(model.params[0])
                r2 = float(model.rsquared)
                p = float(model.pvalues[1])
                conf = model.conf_int()
                ci = conf[1, :].tolist()
            else:
                slope = float("nan"); intercept = float("nan"); r2 = float("nan"); p = float("nan"); ci = [float("nan"), float("nan")]

            ols = {
                "slope": slope,
                "intercept": intercept,
                "r2": r2,
                "p_value": p,
                "ci": ci,
                "n": n_obs,
                "rate_units": rate_units,
                "rate_scale": rate_scale,
            }

            res = {
                "png": f"/outputs/{png_path.name}",
                "bounds": json.loads(bounds_path.read_text()) if bounds_path.exists() else None,
                "csv": f"/outputs/{csv_path.name}",
                "geojson": f"/outputs/{gj_path.name}",
                "ols": ols,
            }
            print(f"[api_run] cache-hit k={k} r2={ols['r2']:.4f}", flush=True)
            return jsonify(res)

        # Heavy path with timing
        t0 = time.time()
        out = pd.run_pipeline(k=k, neighbors=neighbors, cell_size=cell_size)
        res = {
            "png": f"/outputs/{Path(out['png']).name}",
            "bounds": out["bounds"],
            "csv": f"/outputs/{Path(out['csv']).name}",
            "geojson": f"/outputs/{Path(out['geojson']).name}",
            "ols": out["ols"],
        }
        print(f"[api_run] done k={k} r2={res['ols']['r2']:.4f} in {time.time()-t0:.2f}s", flush=True)
        return jsonify(res)

    except Exception as e:
        print("[api_run] ERROR", repr(e), flush=True)
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

# Force no-store so PNG refreshes on re-runs
@app.after_request
def _no_cache(resp):
    resp.headers["Cache-Control"] = "no-store"
    return resp

# ---------- API: Sensitivity (sweep over k) ----------
@app.post("/api/sensitivity")
def api_sensitivity():
    try:
        payload = request.get_json(force=True) or {}
        ks = payload.get("ks", [1.0, 1.5, 2.0, 2.5, 3.0])
        neighbors = int(payload.get("neighbors", 12))
        cell_size = int(payload.get("cell_size", 1000))

        pd = get_project_data()
        rows = []

        for k in ks:
            print(f"[api_sensitivity] k={k} neighbors={neighbors} cell={cell_size}", flush=True)
            # FAST: skip writing PNG/CSV/GeoJSON for each k
            result = pd.run_pipeline(k=float(k), neighbors=neighbors, cell_size=cell_size, write_outputs=False)
            s = result.get("ols", {})
            ci = s.get("ci") or [None, None]
            rows.append({
                "k": float(k),
                "r2": s.get("r2"),
                "slope": s.get("slope"),
                "intercept": s.get("intercept"),
                "p_value": s.get("p_value"),
                "ci_low": ci[0],
                "ci_high": ci[1],
                "n": s.get("n"),
            })

        # One small CSV for the whole sweep
        out_csv = OUTPUTS / f"sensitivity_neighbors{neighbors}_cell{cell_size}.csv"
        import csv
        with open(out_csv, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=["k","r2","slope","intercept","p_value","ci_low","ci_high","n"])
            w.writeheader()
            w.writerows(rows)

        return jsonify({"rows": rows, "csv": f"/outputs/{out_csv.name}"})

    except Exception as e:
        print("[api_sensitivity] ERROR", repr(e), flush=True)
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

# ---------- Main ----------
if __name__ == "__main__":
    _open_browser_once()
    app.run(host=HOST, port=PORT, debug=True, threaded=True)
