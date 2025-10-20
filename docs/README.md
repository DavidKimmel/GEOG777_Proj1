# Nitrate ↔ Cancer Explorer (Static Demo)

This is a **static demonstration version** of the Nitrate-Cancer Explorer, showcasing pre-computed IDW (Inverse Distance Weighting) analyses of the relationship between groundwater nitrate levels and cancer incidence rates.

## Live Demo

Visit the live demo: [GitHub Pages URL will be here after deployment]

## Features

This interactive map viewer includes:

- **Interactive Map**: Explore Wisconsin census tracts with cancer incidence rates visualized using Jenks natural breaks classification
- **Well Points**: View groundwater nitrate measurements from monitoring wells
- **IDW Raster Overlays**: Pre-computed nitrate interpolation surfaces for various power parameters (k = 1.0, 1.5, 2.0, 2.5, 3.0, 3.5)
- **Statistical Analysis**: OLS regression results showing the relationship between nitrate exposure and cancer rates
- **Sensitivity Analysis**: Explore how different k-values affect the interpolation and statistical relationships
- **Multiple Basemaps**: Choose between OpenStreetMap, Light, and Dark basemaps
- **Layer Controls**: Toggle layers, adjust opacity, and cluster points

## About the Data

- **Cancer Rates**: Age-adjusted cancer incidence rates per 100,000 population by census tract
- **Nitrate Data**: Groundwater nitrate concentrations (mg/L) from well monitoring stations
- **IDW Analysis**: Inverse Distance Weighting interpolation with configurable power parameter (k)
- **Parameters**: All pre-computed results use neighbors=12 and cell size=1000m

## Usage

1. **Select k-value**: Choose from the dropdown menu (1.0 to 3.5)
2. **Load Data**: Click "Load Data" to display the IDW raster and statistics
3. **Load Sensitivity**: Click "Load Sensitivity" to view sensitivity analysis results
4. **Explore**: Toggle layers, adjust opacity, and interact with the map
5. **Download**: Download CSV data or raster images for further analysis

## Full Application

This static demo showcases pre-computed results. The **full Python/Flask application** with live IDW computation, customizable parameters, and additional features is available in the source repository.

### Running the Full Application Locally

```bash
# Clone the repository
git clone https://github.com/yourusername/yourrepo.git
cd yourrepo

# Install dependencies
pip install -r requirements.txt

# Run the Flask application
python app.py
```

The full application will open in your browser at `http://localhost:3000`.

## Technical Details

**Frontend:**
- Leaflet.js for interactive mapping
- Jenks natural breaks classification for choropleth visualization
- Client-side OLS regression computation
- Responsive design with collapsible sidebar

**Data Format:**
- GeoJSON for vector data (tracts, wells)
- PNG rasters for IDW surfaces
- CSV for tabular data and statistics

**GitHub Pages Deployment:**
- Pure static HTML/CSS/JavaScript
- No server-side processing required
- All data pre-computed and bundled

## Project Information

**Created by**: David A. Kimmel
**Course**: GEOG 777, Fall 2025
**Institution**: [Your Institution]

## License

[Add your license information here]

## Acknowledgments

Data sources and acknowledgments for the nitrate and cancer datasets should be included here.
