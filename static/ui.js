// Enhanced UI/UX for Project 1
(function () {
  const statusEl = () => document.getElementById('status');
  const setStatus = (msg) => { const el = statusEl(); if (el) el.textContent = msg; };
  const fmt = (n) => (Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 3 }) : '—');
  function safeExp(val) { return (val === null || val === undefined || isNaN(val)) ? '—' : Number(val).toExponential(1); }
  function debounce(fn, ms = 250) { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); }; }
  function setBusy(isBusy) {
    const runBtn = document.getElementById('run');
    const sensBtn = document.getElementById('runSens');
    if (runBtn) { runBtn.disabled = isBusy; runBtn.textContent = isBusy ? 'Running…' : 'Run'; }
    if (sensBtn) { sensBtn.disabled = isBusy; sensBtn.textContent = isBusy ? 'Working…' : 'Sensitivity'; }
  }

  // Color scales for tracts
  function ramp(n) {
    const colors = ['#f7fbff', '#deebf7', '#c6dbef', '#9ecae1', '#6baed6', '#3182bd', '#08519c'];
    if (n <= 1) return colors.slice(0, 1);
    if (n === colors.length) return colors.slice();
    const out = [];
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const idx = t * (colors.length - 1);
      const lo = Math.floor(idx), hi = Math.ceil(idx);
      const a = hexToRgb(colors[lo]), b = hexToRgb(colors[hi]);
      const mix = {
        r: Math.round(a.r + (b.r - a.r) * (idx - lo)),
        g: Math.round(a.g + (b.g - a.g) * (idx - lo)),
        b: Math.round(a.b + (b.b - a.b) * (idx - lo))
      };
      out.push(rgbToHex(mix.r, mix.g, mix.b));
    }
    return out;
  }
  function hexToRgb(h) { const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(h); return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : null; }
  function rgbToHex(r, g, b) { return "#" + [r, g, b].map(x => x.toString(16).padStart(2, "0")).join(""); }

  // Well color helper (mg/L)
  function getWellColor(v) {
    if (!Number.isFinite(v)) return '#2c7bb6';
    if (v < 1)  return '#2c7bb6';
    if (v < 3)  return '#abd9e9';
    if (v < 5)  return '#ffffbf';
    if (v < 10) return '#fdae61';
    return '#d7191c';
  }

  function quantiles(values, k) {
    const v = values.filter(Number.isFinite).sort((a, b) => a - b);
    const qs = [];
    for (let i = 1; i < k; i++) {
      const pos = (v.length - 1) * i / k;
      const base = Math.floor(pos);
      const rest = pos - base;
      qs.push(v[base] + (v[base + 1] - v[base]) * rest);
    }
    return qs;
  }
  function equalBreaks(min, max, k) {
    const out = []; const step = (max - min) / k;
    for (let i = 1; i < k; i++) out.push(min + step * i);
    return out;
  }
  function classify(value, breaks) {
    let i = 0;
    for (; i < breaks.length; i++) { if (value <= breaks[i]) return i; }
    return breaks.length;
  }

  // --- Well Legend Renderer (top-level) ---
  function renderWellLegend() {
    const box = document.getElementById('legend-wells');
    if (!box) return;

    const bins = [
      { label: '< 1 mg/L',    color: getWellColor(0.5) },
      { label: '1 – 3 mg/L',  color: getWellColor(2) },
      { label: '3 – 5 mg/L',  color: getWellColor(4) },
      { label: '5 – 10 mg/L', color: getWellColor(7) },
      { label: '≥ 10 mg/L',   color: getWellColor(12) }
    ];

    const rows = bins.map(b =>
      `<div class="legend-row">
         <span class="legend-swatch" style="background:${b.color}"></span>
         ${b.label}
       </div>`
    ).join('');

    const clusterEl = document.getElementById('clusterToggle');
    const note = (clusterEl && clusterEl.checked)
      ? `<div class="legend-note" style="margin-top:4px; color:#9aa0a6;">Note: clustering groups points visually; colors still represent individual well values.</div>`
      : '';

    box.innerHTML = `<div><b>Well Nitrate</b><br/>(mg/L)</div>${rows}${note}`;
  }

  document.addEventListener('DOMContentLoaded', async () => {
    setStatus('Booting UI…');

    const map = L.map('map', { zoomControl: true }).setView([44.5, -89.9], 7);

    // Basemaps
    const base = {
      osm:   L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }),
      light: L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { attribution: '© OpenStreetMap, © CARTO' }),
      dark:  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',  { attribution: '© OpenStreetMap, © CARTO' })
    };
    base.osm.addTo(map);

    // Controls
    const themeToggle   = document.getElementById('themeToggle');
    const tractsToggle  = document.getElementById('toggleTracts');
    const wellsToggle   = document.getElementById('toggleWells');
    const rasterToggle  = document.getElementById('toggleRaster');
    const tractsOpacity = document.getElementById('tractsOpacity');
    const methodSel     = document.getElementById('choroplethMethod');
    const pointSize     = document.getElementById('pointSize');
    const clusterToggle = document.getElementById('clusterToggle');
    if (clusterToggle) clusterToggle.checked = false; // default clustering OFF
    const rasterOpacity = document.getElementById('rasterOpacity');

    const kslider    = document.getElementById('k');
    const kval       = document.getElementById('kval');
    const neighborsEl= document.getElementById('neighbors');
    const cellEl     = document.getElementById('cell');
    const runBtn     = document.getElementById('run');
    const sensBtn    = document.getElementById('runSens');
    const dlCSV      = document.getElementById('dlCSV');
    const dlPNG      = document.getElementById('dlPNG');
    const legendEl   = document.getElementById('legend');
    const statsEl    = document.getElementById('stats');

    kval.textContent = kslider.value;
    kslider.addEventListener('input', () => kval.textContent = kslider.value);

    // Layers
    let tractsLayer = null, wellsLayer = null, wellsCluster = null;
    let tractsBreaks = null, tractsColors = ramp(5);

    // --- Raster state ---
    let rasterOverlay = null;
    let rasterBounds = null;

    function ensureRasterOverlay(pngUrl, boundsArray) {
      if (!pngUrl || !Array.isArray(boundsArray) || boundsArray.length !== 4) return null;
      if (rasterOverlay) { try { map.removeLayer(rasterOverlay); } catch {} rasterOverlay = null; }
      const sw = [boundsArray[1], boundsArray[0]];
      const ne = [boundsArray[3], boundsArray[2]];
      rasterBounds = L.latLngBounds(sw, ne);
      const op = parseFloat(rasterOpacity?.value ?? 0.6);
      rasterOverlay = L.imageOverlay(pngUrl, rasterBounds, { opacity: isFinite(op) ? op : 0.6, interactive: false });
      return rasterOverlay;
    }
    function setRasterVisible(flag) {
      if (!rasterOverlay) return;
      if (flag && !map.hasLayer(rasterOverlay)) rasterOverlay.addTo(map);
      if (!flag && map.hasLayer(rasterOverlay)) map.removeLayer(rasterOverlay);
      if (rasterToggle) rasterToggle.checked = !!flag;
    }
    function setRasterOpacity(value) {
      if (!rasterOverlay) return;
      const op = Math.max(0, Math.min(1, Number(value)));
      rasterOverlay.setOpacity(op);
    }

    // Fit to bounds if available
    try {
      const b = await fetch('/outputs/bounds.json').then(r => r.json());
      if (Array.isArray(b) && b.length === 4) {
        const sw = [b[1], b[0]];
        const ne = [b[3], b[2]];
        map.fitBounds([sw, ne], { padding: [20, 20] });
      }
    } catch {}

    // Load tracts (choropleth)
    async function loadTracts() {
      const gj = await fetch('/outputs/tracts_base.geojson').then(r => r.json());
      const vals = gj.features.map(f => Number(f.properties?.canrate)).filter(Number.isFinite);
      const min = Math.min(...vals), max = Math.max(...vals);
      const classCount = 5;
      tractsBreaks = (methodSel.value === 'equal') ? equalBreaks(min, max, classCount) : quantiles(vals, classCount);
      tractsColors = ramp(classCount);

      if (tractsLayer) tractsLayer.remove();
      tractsLayer = L.geoJSON(gj, {
        style: f => {
          const v = Number(f.properties?.canrate);
          const idx = Number.isFinite(v) ? classify(v, tractsBreaks) : 0;
          return { color: '#000', weight: 0.5, fillColor: tractsColors[idx], fillOpacity: parseFloat(tractsOpacity.value) };
        },
        onEachFeature: (feature, layer) => {
          const v = Number(feature.properties?.canrate);
          layer.bindPopup(`<b>Tract</b> ${feature.properties?.GEOID10 ?? ''}<br/>Cancer rate: ${fmt(v)}`);
          layer.on('mouseover', () => layer.setStyle({ weight: 2 }));
          layer.on('mouseout',  () => layer.setStyle({ weight: 0.5 }));
        }
      });
      if (tractsToggle?.checked !== false) tractsLayer.addTo(map);
      renderLegend(vals, tractsBreaks, tractsColors);
    }

    // Load wells
    async function loadWells() {
      const gj = await fetch('/outputs/wells.geojson').then(r => r.json());
      if (wellsLayer) wellsLayer.remove();
      if (wellsCluster) wellsCluster.remove();

      const size = parseInt(pointSize.value, 10);
      const makeMarker = (f, latlng) => {
        const v = Number(f.properties?.nitr_ran);
        const color = getWellColor(v);
        return L.circleMarker(latlng, {
          radius: size,
          weight: 0.5,
          color: '#000',
          fillColor: color,
          fillOpacity: 0.9
        }).bindPopup(`<b>Well</b><br/>Nitrate: ${fmt(v)} mg/L`);
      };

      wellsLayer = L.geoJSON(gj, { pointToLayer: makeMarker });

      if (clusterToggle.checked) {
        wellsCluster = L.markerClusterGroup({ disableClusteringAtZoom: 12 });
        wellsCluster.addLayer(wellsLayer);
        if (wellsToggle?.checked !== false) wellsCluster.addTo(map);
      } else {
        if (wellsToggle?.checked !== false) wellsLayer.addTo(map);
      }

      renderWellLegend();
    }

    // Cancer rate legend
    function renderLegend(values, breaks, colors) {
      if (!Array.isArray(breaks) || !breaks.length) {
        legendEl.innerHTML = '<b>Cancer Incidence Rate</b><br/>No data';
        return;
      }
      const maxVal = Math.max(...values);
      const isProportion = maxVal <= 1;
      const scale = isProportion ? 100000 : 1;
      const unitLabel = isProportion ? '(cases per 100,000)' : '(rate)';
      const fmtLegend = (x) => {
        const v = x * scale;
        return isProportion
          ? Math.round(v).toLocaleString()
          : v.toLocaleString(undefined, { maximumFractionDigits: 2 });
      };

      const items = [];
      items.push(`<div><b>Cancer Incidence Rate</b><br/>${unitLabel}</div>`);
      for (let i = 0; i <= breaks.length; i++) {
        let label;
        if (i === 0) label = `< ${fmtLegend(breaks[0])}`;
        else if (i === breaks.length) label = `> ${fmtLegend(breaks[i - 1])}`;
        else label = `${fmtLegend(breaks[i - 1])} – ${fmtLegend(breaks[i])}`;
        const swatch = colors[i] ?? colors[colors.length - 1];
        items.push(
          `<div class="legend-row">
             <span class="legend-swatch" style="background:${swatch}"></span>
             ${label}
           </div>`
        );
      }
      legendEl.innerHTML = items.join('');
    }

    // --- Raster controls ---
    if (rasterToggle) rasterToggle.checked = true; // default ON so new rasters auto-show
    rasterOpacity.addEventListener('input', () => setRasterOpacity(rasterOpacity.value));
    rasterToggle.addEventListener('change', () => setRasterVisible(rasterToggle.checked));

    // --- Vector toggles ---
    tractsToggle.addEventListener('change', () => {
      if (!tractsLayer) return;
      if (tractsToggle.checked) tractsLayer.addTo(map); else tractsLayer.remove();
    });

    wellsToggle.addEventListener('change', () => {
      if (wellsToggle.checked) {
        if (clusterToggle.checked && wellsCluster) wellsCluster.addTo(map);
        else if (wellsLayer) wellsLayer.addTo(map);
      } else {
        if (wellsCluster) wellsCluster.remove();
        if (wellsLayer) wellsLayer.remove();
      }
      renderWellLegend();
    });

    document.getElementById('choroplethMethod').addEventListener('change', loadTracts);
    tractsOpacity.addEventListener('input', debounce(loadTracts, 250));
    pointSize.addEventListener('input', debounce(loadWells, 250));
    clusterToggle.addEventListener('change', loadWells);

    // Basemap change
    document.querySelectorAll('input[name="basemap"]').forEach(r => {
      r.addEventListener('change', () => {
        Object.values(base).forEach(l => map.removeLayer(l));
        base[r.value].addTo(map);
      });
    });

    // Theme toggle
    themeToggle?.addEventListener('change', () => {
      document.body.style.setProperty('--bg', themeToggle.checked ? '#0b0d11' : '#ffffff');
      document.body.style.setProperty('--fg', themeToggle.checked ? '#e6e6e6' : '#111111');
    });

    // Analysis actions
    async function runIDW() {
      setBusy(true);
      try {
        setStatus('Running IDW…');
        const k = parseFloat(kslider.value);
        const neighbors = parseInt(neighborsEl.value, 10);
        const cell = parseInt(cellEl.value, 10);
        const res = await fetch('/api/run', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ k, neighbors, cell_size: cell, fast: true })
        });
        if (!res.ok) { setStatus('Error'); throw new Error('API error'); }
        const data = await res.json();
        handleRunResult(data, k);
        setStatus('Done.');
      } finally {
        setBusy(false);
      }
    }

    async function runSensitivity() {
      setBusy(true);
      try {
        setStatus('Running sensitivity…');
        const ks = [1.0, 1.5, 2.0, 2.5, 3.0];
        const rows = [];
        for (const k of ks) {
          const res = await fetch('/api/run', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ k, neighbors: 12, cell_size: 1000, fast: true })
          });
          const data = await res.json();
          rows.push({ k, r2: (data?.ols?.r2 ?? null), slope: (data?.ols?.slope ?? null), p: safeExp(data?.ols?.p_value) });
        }
        statsEl.innerHTML = '<b>Sensitivity:</b><br>' + rows.map(r => `k=${r.k}: R²=${fmt(r.r2)} slope=${fmt(r.slope)} p=${r.p}`).join('<br>');
        setStatus('Done.');
      } finally {
        setBusy(false);
      }
    }

    function handleRunResult(data, k) {
      // Raster
      if (data && Array.isArray(data.bounds) && data.bounds.length === 4 && data.png) {
        const layer = ensureRasterOverlay(data.png, data.bounds);
        if (layer) {
          if (rasterToggle) rasterToggle.checked = true;
          if (rasterToggle?.checked) {
            layer.addTo(map);
            try { if (rasterBounds) map.fitBounds(rasterBounds.pad(0.05)); } catch {}
          }
          if (rasterOpacity) setRasterOpacity(rasterOpacity.value);
        }
      }

      // OLS + downloads
      if (data?.ols) {
        const s = data.ols;
        const r2 = (s.r2 ?? null), slope = (s.slope ?? null), p = safeExp(s.p_value);
        document.getElementById('stats').innerHTML =
          `<div><b>OLS:</b> R²=${fmt(r2)} slope=${fmt(slope)} p=${p}</div>`;
      }
      if (data?.csv) { dlCSV.href = data.csv; dlCSV.textContent = 'Download CSV'; }
      if (data?.png) { dlPNG.href = data.png; dlPNG.textContent = `Raster k=${k}`; }
    }

    // Wire buttons
    runBtn.addEventListener('click', runIDW);
    sensBtn.addEventListener('click', runSensitivity);

    // Initial loads
    await loadTracts();
    await loadWells();
    renderWellLegend();

    setStatus('Ready.');
  });
})();
