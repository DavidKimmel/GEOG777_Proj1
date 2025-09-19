from pathlib import Path
import json
import os
import time
import threading
import webbrowser
import urllib.request

from flask import Flask, request, jsonify, send_from_directory

HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", 3000))

def _open_browser_once():
    # Only open in the Werkzeug reloader's main process (prevents double tabs)
    if os.environ.get("WERKZEUG_RUN_MAIN") == "true":
        def _wait_and_open():
            # Poll until the server responds, then open a tab
            url = f"http://{HOST}:{PORT}"
            ping = f"{url}/api/ping"
            for _ in range(40):  # up to ~8 seconds
                try:
                    urllib.request.urlopen(ping, timeout=0.2)
                    break
                except Exception:
                    time.sleep(0.2)
            webbrowser.open(url)
        threading.Thread(target=_wait_and_open, daemon=True).start()

# ---- Paths ----
APP_ROOT = Path(__file__).resolve().parent
STATIC   = APP_ROOT / "static"
OUTPUTS  = APP_ROOT / "outputs"

app = Flask(__name__, static_folder=str(STATIC), static_url_path="/static")

# ---- Routes ----
@app.get("/api/ping")
def ping():
    return jsonify(ok=True)

@app.get("/")
def index():
    # Serve the main page with correct headers
    return send_from_directory(STATIC, "index.html")

@app.get("/outputs/<path:filename>")
def get_output(filename: str):
    # Serve rasters, csvs, and any generated artifacts
    return send_from_directory(OUTPUTS, filename, conditional=True)

@app.post("/api/run")
def api_run():
    """
    Minimal analysis endpoint.
    If 'fast' is true, return a pre-rendered raster and bounds.
    This keeps the UI snappy while the heavy compute path is under construction.
    """
    t0 = time.time()
    payload   = request.get_json(silent=True) or {}
    k         = float(payload.get("k", 2.0))
    neighbors = int(payload.get("neighbors", 12))   # accepted but unused in fast mode
    cell_size = int(payload.get("cell_size", 1000)) # accepted but unused in fast mode
    fast      = bool(payload.get("fast", True))

    # --- FAST PATH ---
    if fast:
        # Look for pre-rendered rasters, otherwise fall back to placeholder
        k_tag = f"{k:.1f}"
        png_name = f"nitrate_k{k_tag}.png"
        png_path = OUTPUTS / png_name
        if not png_path.exists():
            png_name = "placeholder_raster.png"
            png_path = OUTPUTS / png_name

        # Load bounds
        bounds_path = OUTPUTS / "bounds.json"
        bounds = None
        if bounds_path.exists():
            try:
                bounds = json.loads(bounds_path.read_text(encoding="utf-8"))
            except Exception as e:
                print("[API] failed to read bounds.json:", e)

        res = {
            "png": f"/outputs/{png_name}",
            "bounds": bounds,   # [xmin, ymin, xmax, ymax]
            "ols": { "r2": None, "slope": None, "p_value": None },
            "csv": "/outputs/placeholder_table.csv"
        }
        print("[API] fast path served in", round(time.time()-t0, 2), "s")
        return jsonify(res)

    # --- HEAVY PATH (stub) ---
    res = {
        "png": "/outputs/placeholder_raster.png",
        "bounds": json.loads((OUTPUTS / "bounds.json").read_text(encoding="utf-8")) if (OUTPUTS / "bounds.json").exists() else None,
        "ols": { "r2": None, "slope": None, "p_value": None },
        "csv": "/outputs/placeholder_table.csv"
    }
    print("[API] heavy stub served in", round(time.time()-t0, 2), "s")
    return jsonify(res)

if __name__ == "__main__":
    _open_browser_once()
    app.run(host=HOST, port=PORT, debug=True, threaded=True)
