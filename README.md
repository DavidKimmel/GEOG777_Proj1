# GEOG 577 Project 1 — Nitrate ↔ Cancer (Flask + Leaflet)

## Quick start
1) `pip install -r requirements.txt`
2) `python app.py`
3) Open http://127.0.0.1:5000

## Next
- Replace placeholder outputs by wiring processing/idw.py, zonal.py, regress.py
- Implement POST /idw to compute a PNG raster and return bounds
- Implement POST /zonal_regress to compute tract GeoJSON + OLS stats
