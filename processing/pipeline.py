# processing/pipeline.py
import math
import json
import time
from pathlib import Path

import numpy as np
import fiona
from shapely.geometry import shape, mapping, Point, Polygon, MultiPolygon
from shapely.ops import unary_union
from scipy.spatial import cKDTree
from pyproj import CRS, Transformer
from rasterio.transform import from_origin
from rasterio import features
from PIL import Image
import statsmodels.api as sm
import pandas as pd

# --- Coordinate systems ---
#  - CRS_DATA: input shapefiles (provided as NAD83 / EPSG:4269)
#  - CRS_METERS: analysis CRS in meters (Wisconsin TM / EPSG:3071)
#  - CRS_LL: output for web display (WGS84 / EPSG:4326)
CRS_LL     = CRS.from_epsg(4326)
CRS_DATA   = CRS.from_epsg(4269)
CRS_METERS = CRS.from_epsg(3071)

# Transformers (always_xy=True means (lon, lat) order)
TF_DATA_TO_M = Transformer.from_crs(CRS_DATA,   CRS_METERS, always_xy=True)
TF_M_TO_LL   = Transformer.from_crs(CRS_METERS, CRS_LL,     always_xy=True)
TF_DATA_TO_LL= Transformer.from_crs(CRS_DATA,   CRS_LL,     always_xy=True)

# --- Attribute fields ---
TRACT_ID_FIELD = "GEOID10"
CANCER_FIELD   = "canrate"
NITRATE_FIELD  = "nitr_ran"

def _geom_to_meters(geom):
    """Reproject a shapely Polygon/MultiPolygon from CRS_DATA to CRS_METERS (XY order)."""
    def _re_xy(g):
        if isinstance(g, Polygon):
            ext = [TF_DATA_TO_M.transform(x, y) for (x, y) in g.exterior.coords]
            ints = [[TF_DATA_TO_M.transform(x, y) for (x, y) in r.coords] for r in g.interiors]
            return Polygon(ext, ints)
        if isinstance(g, MultiPolygon):
            return MultiPolygon([_re_xy(p) for p in g.geoms])
        return g
    return _re_xy(geom)

def _geom_to_ll_from_data(geom):
    """Reproject a shapely Polygon/MultiPolygon from CRS_DATA to CRS_LL (WGS84) for GeoJSON output."""
    def _re_xy(g):
        if isinstance(g, Polygon):
            ext = [TF_DATA_TO_LL.transform(x, y) for (x, y) in g.exterior.coords]
            ints = [[TF_DATA_TO_LL.transform(x, y) for (x, y) in r.coords] for r in g.interiors]
            return Polygon(ext, ints)
        if isinstance(g, MultiPolygon):
            return MultiPolygon([_re_xy(p) for p in g.geoms])
        return g
    return _re_xy(geom)

class ProjectData:
    """
    Loads shapefiles, builds a KDTree for wells in meters,
    computes IDW grids, zonal means by tract, and OLS between
    tract mean nitrate and cancer rate. Writes PNG/CSV/GeoJSON outputs.
    """
    def __init__(self, shp_dir: Path, out_dir: Path):
        self.shp_dir = Path(shp_dir)
        self.out_dir = Path(out_dir)
        self.out_dir.mkdir(parents=True, exist_ok=True)

        # --- Load wells ---
        t0 = time.time()
        print("[pipeline] loading wells...", flush=True)
        self.wells_xy_m, self.wells_vals = self._load_wells(self.shp_dir / "well_nitrate.shp")
        self.kdtree = cKDTree(self.wells_xy_m) if len(self.wells_xy_m) else None
        print(f"[pipeline] wells: {len(self.wells_vals)} loaded in {time.time()-t0:.2f}s", flush=True)

        # --- Load tracts ---
        t1 = time.time()
        print("[pipeline] loading tracts...", flush=True)
        self.tract_polys_m, self.tract_ids, self.rate_by_gid = self._load_tracts(self.shp_dir / "cancer_tracts.shp")
        print(f"[pipeline] tracts: {len(self.tract_ids)} loaded in {time.time()-t1:.2f}s", flush=True)

        # --- Union bounds in meters for grid extent ---
        union_poly = unary_union(self.tract_polys_m) if self.tract_polys_m else None
        if union_poly is None or union_poly.is_empty:
            raise RuntimeError("No tract polygons found; cannot define analysis extent.")
        self.union_bounds = union_poly.bounds  # (minx, miny, maxx, maxy)

        # Save bounds for frontend (Leaflet expects [sw_lon, sw_lat, ne_lon, ne_lat])
        bounds_path = self.out_dir / "bounds.json"
        if not bounds_path.exists():
            with open(bounds_path, "w", encoding="utf-8") as f:
                json.dump(self.bounds_ll(), f)

    # ---------------------- Loading ----------------------

    def _load_wells(self, wells_path: Path):
        """Return (xy_meters: Nx2 float64, nitrate_vals: N float64)."""
        xs_m, ys_m, vals = [], [], []
        if not wells_path.exists():
            raise FileNotFoundError(f"Missing wells shapefile: {wells_path}")
        with fiona.open(wells_path) as src:
            for feat in src:
                geom = shape(feat["geometry"])
                if geom.is_empty:
                    continue
                # wells are points
                if isinstance(geom, Point):
                    x_data, y_data = geom.x, geom.y
                else:
                    # If geometry isn't Point, take centroid
                    c = geom.centroid
                    x_data, y_data = c.x, c.y

                x_m, y_m = TF_DATA_TO_M.transform(x_data, y_data)
                v = feat["properties"].get(NITRATE_FIELD, None)
                if v is None:
                    continue
                try:
                    fv = float(v)
                except Exception:
                    continue
                if math.isfinite(fv):
                    xs_m.append(x_m)
                    ys_m.append(y_m)
                    vals.append(fv)

        if not xs_m:
            raise RuntimeError("No valid well points with nitrate values were found.")
        xy_m = np.column_stack([np.asarray(xs_m, dtype=np.float64),
                                np.asarray(ys_m, dtype=np.float64)])
        vals = np.asarray(vals, dtype=np.float64)
        return xy_m, vals

    def _load_tracts(self, shp_path: Path):
        """Load tract polygons and a population-normalized cancer rate.
        Prefers CANCER_FIELD ('canrate'). If missing, tries cases/pop using common field names.
        Returns (polys_in_meters, tract_ids, rate_by_gid_dict) and sets self.union_bounds.
        """
        from shapely.ops import transform as shp_transform
        # Local transformer so we don't depend on any outer-scope variable name
        to_m = Transformer.from_crs(CRS_DATA, CRS_METERS, always_xy=True)

        polys_m: list = []
        tract_ids: list = []
        rate_by_gid: dict = {}

        # Fallback field guesses if canrate is absent
        CASE_KEYS = ["cases", "count", "cancer", "incidences", "case_cnt", "num_cases"]
        POP_KEYS  = ["pop", "population", "pop2010", "tot_pop", "total_pop", "pop_total"]

        with fiona.open(shp_path) as src:
            for f in src:
                props = f.get("properties") or {}

                # Robust GEOID
                gid = (
                    props.get(TRACT_ID_FIELD)
                    or props.get("GEOID")
                    or props.get("geoid")
                    or props.get("GEOID10")
                    or props.get("geoid10")
                )
                if not gid:
                    continue
                gid = str(gid)

                # 1) Prefer existing rate
                rate = props.get(CANCER_FIELD)

                # 2) Else compute cases/pop if we can find them
                if rate is None:
                    cases = next((props.get(k) for k in CASE_KEYS if props.get(k) is not None), None)
                    pop   = next((props.get(k) for k in POP_KEYS  if props.get(k) is not None), None)
                    try:
                        cases = float(cases) if cases is not None else None
                        pop   = float(pop)   if pop   is not None else None
                    except Exception:
                        cases, pop = None, None
                    if cases is not None and pop and pop > 0:
                        rate = cases / pop  # proportion

                # Coerce to float or None
                try:
                    rate = float(rate) if rate is not None else None
                except Exception:
                    rate = None

                # Geometry → meters (EPSG:3071)
                geom = shape(f["geometry"])
                # Use lambda to be compatible with Shapely's (x,y[,z]) signature
                geom_m = shp_transform(lambda x, y, z=None: to_m.transform(x, y), geom)

                polys_m.append(geom_m)
                tract_ids.append(gid)
                rate_by_gid[gid] = rate

        # Update bounds for IDW grid and return
        self.union_bounds = unary_union(polys_m).bounds
        return polys_m, tract_ids, rate_by_gid



    # ---------------------- IDW ----------------------

    def idw_grid(self, k=2.0, neighbors=16, cell_size=1000):
        """
        Compute an IDW grid over the union of tracts (in meters).
        Returns (raster[H,W], xs[W], ys[H]) in meters.
        """
        if self.kdtree is None:
            raise RuntimeError("KDTree not initialized; wells missing?")

        minx, miny, maxx, maxy = self.union_bounds
        width  = max(1, int(math.ceil((maxx - minx) / float(cell_size))))
        height = max(1, int(math.ceil((maxy - miny) / float(cell_size))))

        xs = minx + (np.arange(width, dtype=np.float64) + 0.5) * float(cell_size)
        ys = maxy - (np.arange(height, dtype=np.float64) + 0.5) * float(cell_size)

        t0 = time.time()
        print(f"[idw] start k={k} neighbors={neighbors} cell_size={cell_size} -> grid {width}x{height}", flush=True)

        gx, gy = np.meshgrid(xs, ys)  # gy: (H,W), gx: (H,W)
        pts = np.column_stack([gx.ravel(), gy.ravel()])  # (H*W, 2)

        # cKDTree query; older SciPy lacks 'workers', so guard it
        try:
            dists, idxs = self.kdtree.query(pts, k=neighbors, workers=-1)
        except TypeError:
            dists, idxs = self.kdtree.query(pts, k=neighbors)

        # Ensure 2D shapes even when neighbors==1
        if neighbors == 1:
            dists = dists[:, None]
            idxs = idxs[:, None]

        # Avoid divide by zero: floor distances at small epsilon
        d = np.maximum(dists.astype(np.float64), 1.0)
        w = 1.0 / (d ** float(k))

        # Gather neighbor well values
        z = self.wells_vals[idxs]  # (N, neighbors)
        pred = (w * z).sum(axis=1) / np.maximum(w.sum(axis=1), 1e-12)

        raster = pred.reshape((height, width))
        print(f"[idw] computed in {time.time()-t0:.2f}s", flush=True)
        return raster, xs, ys

    # ---------------------- Zonal means ----------------------

    def rasterize_tract_labels(self, xs, ys):
        """
        Rasterize tract polygons to label image aligned to (xs, ys) grid.
        Returns (labels[H,W], label_to_gid dict).
        """
        cell = float(xs[1] - xs[0]) if len(xs) > 1 else 1.0
        minx = xs[0] - 0.5 * cell
        maxy = ys[0] + 0.5 * cell
        H, W = len(ys), len(xs)
        transform = from_origin(minx, maxy, cell, cell)

        shapes = []
        label_to_gid = {}
        for i, (gid, poly_m) in enumerate(zip(self.tract_ids, self.tract_polys_m), start=1):
            shapes.append((mapping(poly_m), int(i)))
            label_to_gid[int(i)] = gid

        labels = features.rasterize(
            shapes=shapes,
            out_shape=(H, W),
            transform=transform,
            fill=0,
            dtype="uint32",
        )
        return labels, label_to_gid

    def zonal_means(self, raster, xs, ys):
        """
        Compute mean raster value per tract.
        Returns dict {GEOID: mean_value}
        """
        labels, label_to_gid = self.rasterize_tract_labels(xs, ys)
        valid = np.isfinite(raster) & (labels != 0)
        if not np.any(valid):
            return {}

        lab = labels[valid].astype(np.int64)
        val = raster[valid].astype(np.float64)

        uniq, inv = np.unique(lab, return_inverse=True)
        sum_by = np.bincount(inv, weights=val)
        cnt_by = np.bincount(inv)
        mean_by = sum_by / np.maximum(cnt_by, 1)

        means = {}
        for idx, lbl in enumerate(uniq):
            gid = label_to_gid.get(int(lbl))
            if gid is not None:
                means[gid] = float(mean_by[idx])
        return means

    # ---------------------- Outputs ----------------------

    def write_png_overlay(self, raster, k):
        """
        Write a semi-transparent PNG overlay (RGBA) using a simple
        blue<->yellow ramp based on robust 2-98 percentile stretch.
        """
        finite = np.isfinite(raster)
        if not finite.any():
            # Make an empty transparent image
            rgba = np.zeros(raster.shape + (4,), dtype=np.uint8)
            out_png = self.out_dir / f"nitrate_k{float(k):.1f}.png"
            Image.fromarray(rgba, mode="RGBA").save(out_png)
            return out_png

        vmin = float(np.nanpercentile(raster[finite], 2))
        vmax = float(np.nanpercentile(raster[finite], 98))
        if vmax <= vmin:
            vmax = vmin + 1e-6

        norm = np.zeros_like(raster, dtype=np.uint8)
        scaled = (np.clip((raster - vmin) / (vmax - vmin), 0.0, 1.0) * 255.0).astype(np.uint8)
        norm[finite] = scaled[finite]

        # Simple gradient: R=0, G=norm, B=255-norm, A=180 where finite
        R = np.zeros_like(norm, dtype=np.uint8)
        G = norm
        B = (255 - norm).astype(np.uint8)
        A = np.where(finite, 180, 0).astype(np.uint8)
        rgba = np.dstack([R, G, B, A])

        out_png = self.out_dir / f"nitrate_k{float(k):.1f}.png"
        Image.fromarray(rgba, mode="RGBA").save(out_png)
        return out_png

    def bounds_ll(self):
        """Return [sw_lon, sw_lat, ne_lon, ne_lat] for Leaflet fitBounds."""
        minx, miny, maxx, maxy = self.union_bounds
        sw_lon, sw_lat = TF_M_TO_LL.transform(minx, miny)
        ne_lon, ne_lat = TF_M_TO_LL.transform(maxx, maxy)
        return [sw_lon, sw_lat, ne_lon, ne_lat]

    # ---------------------- Main pipeline ----------------------

    def run_pipeline(self, k=2.0, neighbors=16, cell_size=300, write_outputs=True):
        t0 = time.time()
        # 1) IDW
        raster, xs, ys = self.idw_grid(k=k, neighbors=neighbors, cell_size=cell_size)

        # 2) Zonal means per tract
        mean_by_gid = self.zonal_means(raster, xs, ys)

        # 3) Build table + OLS
        import pandas as pd
        rows = []
        for gid in self.tract_ids:
            rows.append({
                "GEOID10": gid,
                "mean_nitrate": mean_by_gid.get(gid, np.nan),
                "canrate": self.rate_by_gid.get(gid, np.nan),
            })
        df = pd.DataFrame(rows)
        df_clean = df.dropna(subset=["mean_nitrate", "canrate"]).copy()

        X = sm.add_constant(df_clean["mean_nitrate"].to_numpy())
        y = df_clean["canrate"].to_numpy()
        model = sm.OLS(y, X).fit()
        slope, intercept = float(model.params[1]), float(model.params[0])
        r2, p = float(model.rsquared), float(model.pvalues[1])
        ci = model.conf_int()[1, :].tolist()  # slope CI
        n_obs = int(len(df_clean))

        # Unit inference (proportion vs raw/per-100k)
        try:
            max_rate = float(np.nanmax(df["canrate"].to_numpy()))
            is_proportion = np.isfinite(max_rate) and max_rate <= 1.0
        except Exception:
            is_proportion = False
        rate_units = "proportion" if is_proportion else "raw"
        rate_scale = 100000 if is_proportion else 1

        png_path = None
        csv_path = None
        gj_path  = None

        if write_outputs:
            # PNG overlay
            png_path = self.write_png_overlay(raster, k)
            # CSV
            csv_path = self.out_dir / f"tract_table_k{float(k):.1f}.csv"
            df.to_csv(csv_path, index=False)
            # GeoJSON (tract polygons + attributes) reprojected to 4326
            to_ll = Transformer.from_crs(CRS_DATA, CRS_LL, always_xy=True)
            gj_path = self.out_dir / f"tracts_k{float(k):.1f}.geojson"
            feats = []
            with fiona.open(self.shp_dir / "cancer_tracts.shp") as src:
                for f in src:
                    gid = f["properties"].get(TRACT_ID_FIELD)
                    if gid is None:
                        continue
                    geom = shape(f["geometry"])
                    from shapely.ops import transform as shp_transform
                    geom_ll = shp_transform(lambda x, y, z=None: to_ll.transform(x, y), geom)
                    props = {
                        TRACT_ID_FIELD: gid,
                        "canrate": self.rate_by_gid.get(gid, None),
                        "mean_nitrate": mean_by_gid.get(gid, None),
                    }
                    feats.append({"type": "Feature", "geometry": mapping(geom_ll), "properties": props})
            with open(gj_path, "w", encoding="utf-8") as f:
                json.dump({"type": "FeatureCollection", "features": feats}, f)

        return {
            "png": str(png_path) if png_path else None,
            "bounds": self.bounds_ll(),
            "geojson": str(gj_path) if gj_path else None,
            "csv": str(csv_path) if csv_path else None,
            "ols": {
                "slope": slope,
                "intercept": intercept,
                "r2": r2,
                "p_value": p,
                "ci": ci,
                "n": n_obs,
                "rate_units": rate_units,
                "rate_scale": rate_scale,
            },
        }


# ---------------------- Standalone test harness ----------------------

if __name__ == "__main__":
    # Run the pipeline directly (bypasses Flask) to validate the environment and data paths
    root = Path(__file__).resolve().parents[1]   # project root containing /static and /outputs
    shp_dir = root / "static" / "shapefiles"
    out_dir = root / "outputs"
    print(f"[main] shp_dir={shp_dir}")
    print(f"[main] out_dir={out_dir}")
    pdj = ProjectData(shp_dir, out_dir)
    result = pdj.run_pipeline(k=2.0, neighbors=12, cell_size=2000)
    print(json.dumps({
        "png": result["png"],
        "csv": result["csv"],
        "geojson": result["geojson"],
        "ols": result["ols"]
    }, indent=2))
