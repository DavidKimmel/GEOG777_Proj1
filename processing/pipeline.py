# processing/pipeline.py
import math, json
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

# --- Constants & paths ---
CRS_LL     = CRS.from_epsg(4326)   # lat/lon for Leaflet
CRS_DATA   = CRS.from_epsg(4269)   # your shapefiles
CRS_METERS = CRS.from_epsg(3071)   # Wisconsin TM (meters)

tf_data_to_m = Transformer.from_crs(CRS_DATA,   CRS_METERS, always_xy=True)
tf_m_to_ll   = Transformer.from_crs(CRS_METERS, CRS_LL,     always_xy=True)

TRACT_ID_FIELD = "GEOID10"
CANCER_FIELD   = "canrate"
NITRATE_FIELD  = "nitr_ran"

class ProjectData:
    def __init__(self, shp_dir: Path, out_dir: Path):
        self.shp_dir = Path(shp_dir)
        self.out_dir = Path(out_dir)
        self.out_dir.mkdir(parents=True, exist_ok=True)

        # Load wells (to meters)
        self.wells_xy_m, self.wells_vals = self._load_wells(self.shp_dir / "well_nitrate.shp")
        self.kdtree = cKDTree(self.wells_xy_m)

        # Load tracts (to meters)
        self.tract_polys_m, self.tract_ids, self.tract_rates = self._load_tracts(self.shp_dir / "cancer_tracts.shp")
        self.union_bounds = unary_union(self.tract_polys_m).bounds

        # quick lookup for cancer rate per GEOID
        self.rate_by_gid = dict(zip(self.tract_ids, self.tract_rates))

    def _load_wells(self, path):
        xy, vals = [], []
        with fiona.open(path) as src:
            for f in src:
                g = shape(f["geometry"])
                x, y = tf_data_to_m.transform(g.x, g.y)
                xy.append((x, y))
                vals.append(float(f["properties"][NITRATE_FIELD]))
        return np.array(xy, dtype=float), np.array(vals, dtype=float)

    def _load_tracts(self, path):
        polys_m, gids, rates = [], [], []
        with fiona.open(path) as src:
            for f in src:
                g  = shape(f["geometry"])
                gid = f["properties"][TRACT_ID_FIELD]
                rate = float(f["properties"][CANCER_FIELD])
                # transform polygon/multipolygon to meters
                def xy_iter(geom):
                    if isinstance(geom, Polygon):
                        exterior = [tf_data_to_m.transform(x, y) for x, y in geom.exterior.coords]
                        interiors = [[tf_data_to_m.transform(x, y) for x, y in ring.coords] for ring in geom.interiors]
                        return Polygon(exterior, interiors)
                    if isinstance(geom, MultiPolygon):
                        return MultiPolygon([xy_iter(p) for p in geom.geoms])
                    raise TypeError("Unexpected geometry")
                gm = xy_iter(g)
                polys_m.append(gm); gids.append(gid); rates.append(rate)
        return polys_m, gids, rates

    # ---------- Core analysis ----------
    def idw_grid(self, k=2.0, neighbors=16, cell_size=300):
        minx, miny, maxx, maxy = self.union_bounds
        width  = int(math.ceil((maxx - minx) / cell_size))
        height = int(math.ceil((maxy - miny) / cell_size))
        xs = minx + (np.arange(width) + 0.5) * cell_size
        ys = maxy - (np.arange(height) + 0.5) * cell_size

        gx, gy = np.meshgrid(xs, ys)                # (h,w)
        pts = np.column_stack([gx.ravel(), gy.ravel()])

        dists, idxs = self.kdtree.query(pts, k=neighbors, workers=-1)
        if neighbors == 1:
            dists = dists[:, None]; idxs = idxs[:, None]
        dists = np.maximum(dists, 1.0)              # epsilon
        w = 1.0 / (dists ** float(k))
        z = self.wells_vals[idxs]
        pred = (w * z).sum(axis=1) / w.sum(axis=1)
        raster = pred.reshape((ys.size, xs.size))
        return raster, xs, ys

    def rasterize_tract_labels(self, xs, ys):
        from rasterio.transform import from_origin
        from rasterio import features

        cell = float(xs[1] - xs[0])
        minx = xs[0] - 0.5 * cell
        maxy = ys[0] + 0.5 * cell
        transform = from_origin(minx, maxy, cell, cell)
        H, W = len(ys), len(xs)

        # Sequential labels: 1..N (tiny integers)
        shapes = []
        label_to_gid = {}
        for i, (gid, poly) in enumerate(zip(self.tract_ids, self.tract_polys_m), start=1):
            shapes.append((mapping(poly), int(i)))
            label_to_gid[int(i)] = gid

        labels = features.rasterize(
            shapes=shapes,
            out_shape=(H, W),
            transform=transform,
            fill=0,
            dtype="uint32",   # keep it small
        )
        return labels, label_to_gid


    def zonal_means(self, raster, xs, ys):
        labels, label_to_gid = self.rasterize_tract_labels(xs, ys)

        valid = np.isfinite(raster) & (labels != 0)
        lab = labels[valid].astype(np.int64)
        val = raster[valid].astype(float)

        # Densify labels → 0..M-1 to keep bincount tiny
        uniq, inv = np.unique(lab, return_inverse=True)
        sum_by = np.bincount(inv, weights=val)
        cnt_by = np.bincount(inv)
        mean_by = sum_by / np.maximum(cnt_by, 1)

        means = {}
        for idx, lbl in enumerate(uniq):
            gid = label_to_gid.get(int(lbl))
            if gid:
                means[gid] = float(mean_by[idx])
        return means


    def write_png_overlay(self, raster, k):
        # stretch to 2–98% range; make semi-transparent overlay
        finite = np.isfinite(raster)
        vmin = float(np.nanpercentile(raster, 2)) if finite.any() else 0.0
        vmax = float(np.nanpercentile(raster, 98)) if finite.any() else 1.0
        if vmax <= vmin: vmax = vmin + 1e-6
        norm = np.zeros_like(raster, np.uint8)
        norm[finite] = np.clip((raster[finite] - vmin) / (vmax - vmin) * 255, 0, 255).astype(np.uint8)

        alpha = np.where(finite, 180, 0).astype(np.uint8)
        # simple blue→yellow look without external colormaps
        rgba = np.dstack([norm*0, norm, 255-norm, alpha])
        out_png = self.out_dir / f"nitrate_k{float(k):.1f}.png"
        Image.fromarray(rgba, mode="RGBA").save(out_png)
        return out_png

    def bounds_ll(self):
        minx, miny, maxx, maxy = self.union_bounds
        sw_lon, sw_lat = tf_m_to_ll.transform(minx, miny)
        ne_lon, ne_lat = tf_m_to_ll.transform(maxx, maxy)
        return [sw_lon, sw_lat, ne_lon, ne_lat]

    def run_pipeline(self, k=2.0, neighbors=16, cell_size=300):
        # 1) IDW
        raster, xs, ys = self.idw_grid(k=k, neighbors=neighbors, cell_size=cell_size)
        png_path = self.write_png_overlay(raster, k)

        # 2) Zonal means per tract
        mean_by_gid = self.zonal_means(raster, xs, ys)

        # 3) Merge with cancer rate + OLS
        rows = []
        for gid in self.tract_ids:
            rows.append({
                "GEOID10": gid,
                "mean_nitrate": mean_by_gid.get(gid, np.nan),
                "canrate": self.rate_by_gid.get(gid, np.nan),
            })
        import pandas as pd
        df = pd.DataFrame(rows)
        df_clean = df.dropna(subset=["mean_nitrate", "canrate"]).copy()

        X = sm.add_constant(df_clean["mean_nitrate"].to_numpy())
        y = df_clean["canrate"].to_numpy()
        model = sm.OLS(y, X).fit()
        slope, intercept = float(model.params[1]), float(model.params[0])
        r2, p = float(model.rsquared), float(model.pvalues[1])
        conf = model.conf_int()            # ndarray
        ci = conf[1, :].tolist()           # slope confidence interval


        # 4) Write CSV + GeoJSON (tract polygons with attributes), in WGS84
        csv_path = self.out_dir / f"tract_table_k{float(k):.1f}.csv"
        df.to_csv(csv_path, index=False)

        # write GeoJSON by streaming original tracts and adding props
        gj_path = self.out_dir / f"tracts_k{float(k):.1f}.geojson"
        feats = []
        # rewind Fiona once to get original (in 4269) and transform to 4326 for output
        with fiona.open(self.shp_dir/"cancer_tracts.shp") as src:
            for f in src:
                gid = f["properties"][TRACT_ID_FIELD]
                props = {
                    TRACT_ID_FIELD: gid,
                    "canrate": self.rate_by_gid.get(gid, None),
                    "mean_nitrate": mean_by_gid.get(gid, None)
                }
                geom = shape(f["geometry"])
                # reproject geometry to 4326
                def re_xy(g):
                    if isinstance(g, Polygon):
                        ext = [Transformer.from_crs(CRS_DATA, CRS_LL, always_xy=True).transform(x,y) for x,y in g.exterior.coords]
                        ints = [[Transformer.from_crs(CRS_DATA, CRS_LL, always_xy=True).transform(x,y) for x,y in r.coords] for r in g.interiors]
                        return Polygon(ext, ints)
                    if isinstance(g, MultiPolygon):
                        return MultiPolygon([re_xy(p) for p in g.geoms])
                    return g
                geom_ll = re_xy(geom)
                feats.append({"type":"Feature", "geometry": mapping(geom_ll), "properties": props})
        with open(gj_path, "w") as f:
            json.dump({"type":"FeatureCollection", "features": feats}, f)

        return {
            "png": str(png_path),
            "bounds": self.bounds_ll(),
            "geojson": str(gj_path),
            "csv": str(csv_path),
            "ols": {"slope": slope, "intercept": intercept, "r2": r2, "p_value": p, "ci": ci}
        }
