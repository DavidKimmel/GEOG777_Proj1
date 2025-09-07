
Field audit:
- cancer_tracts.shp: rows=1401, columns=['GEOID10', 'canrate']
  - Join key candidate: GEOID10
  - Cancer rate field: canrate (float)

- cancer_county.shp: rows=72, columns=['COUNTY_FIP', 'canrate']
  - County FIPS: COUNTY_FIP
  - Cancer rate field: canrate (float)

- well_nitrate.shp: rows=1866, columns=['TARGET_FID', 'nitr_ran']
  - Nitrate value field: nitr_ran (float)

CRS:
- All three layers report EPSG:4269 (NAD83 geographic degrees). We'll reproject to a Wisconsin meters CRS for IDW (e.g., EPSG:3071 or 7590).
