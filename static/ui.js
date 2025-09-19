// ui.js — GEOG 577 Project 1 (Flask + Leaflet)
// end-to-end wiring for IDW → zonal → OLS with raster overlay
// Includes: raster z-order toggle (#rasterOnTop), sensitivity table rendering,
// sidebar collapse with persistence, "Clear raster" button, and runtime
// injection of missing UI controls if the template is out of sync.

(function () {
  // ---------- small helpers ----------
  const statusEl = () => document.getElementById('status');
  const setStatus = (msg) => { const el = statusEl(); if (el) el.textContent = msg; };
  const fmt = (n) => (Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 3 }) : '—');
  const safeExp = (val) => (val === null || val === undefined || isNaN(val)) ? '—' : Number(val).toExponential(1);
  const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  function setBusy(isBusy) {
    const runBtn = document.getElementById('run');
    const sensBtn = document.getElementById('runSens');
    if (runBtn)  { runBtn.disabled = isBusy;  runBtn.textContent  = isBusy ? 'Running…'  : 'Run'; }
    if (sensBtn) { sensBtn.disabled = isBusy; sensBtn.textContent = isBusy ? 'Working…' : 'Sensitivity'; }
  }
  function withTimeout(ms=60000){
    const ctrl = new AbortController();
    const t = setTimeout(()=>ctrl.abort(new Error('timeout')), ms);
    return { signal: ctrl.signal, done:()=>clearTimeout(t) };
  }

  // ---------- color helpers ----------
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
  function hexToRgb(h) { const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(h); return m ? { r: parseInt(m[1],16), g: parseInt(m[2],16), b: parseInt(m[3],16) } : {r:0,g:0,b:0}; }
  function rgbToHex(r,g,b){ return "#" + [r,g,b].map(x => x.toString(16).padStart(2,"0")).join(""); }

  // wells color helper (mg/L)
  function getWellColor(v) {
    if (!Number.isFinite(v)) return '#2c7bb6';
    if (v < 1)  return '#2c7bb6';
    if (v < 3)  return '#abd9e9';
    if (v < 5)  return '#ffffbf';
    if (v < 10) return '#fdae61';
    return '#d7191c';
  }

  // ---------- classification helpers ----------
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

  // ---------- page setup ----------
  document.addEventListener('DOMContentLoaded', async () => {
    setStatus('Booting UI…');

    // map + base layers
    const map = L.map('map', { zoomControl: true }).setView([44.5, -89.9], 7);
    const base = {
      osm:   L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',              { maxZoom: 19, attribution: '© OpenStreetMap' }),
      light: L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',  { attribution: '© OpenStreetMap, © CARTO' }),
      dark:  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',   { attribution: '© OpenStreetMap, © CARTO' })
    };
    base.osm.addTo(map);

    // Create a dedicated pane for the IDW raster
    map.createPane('idwPane');
    map.getPane('idwPane').style.zIndex = 380; // below vectors (~400) by default

    // controls/inputs
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
    const rasterOnTop   = document.getElementById('rasterOnTop');

    const kslider    = document.getElementById('k');
    const kval       = document.getElementById('kval');
    const neighborsEl= document.getElementById('neighbors');
    const cellEl     = document.getElementById('cell');
    const runBtn     = document.getElementById('run');
    const sensBtn    = document.getElementById('runSens');
    const dlCSV      = document.getElementById('dlCSV');
    const dlPNG      = document.getElementById('dlPNG');
    const dlSens     = document.getElementById('dlSens');
    const statsEl    = document.getElementById('stats');

    // Sensitivity table targets — optional; if missing, we fall back to #sensitivity text div
    const sensTable  = document.getElementById('sensTable');
    const sensTbody  = sensTable ? sensTable.querySelector('tbody') : null;
    const sensEmpty  = document.getElementById('sensEmpty');
    const sensTextDiv= document.getElementById('sensitivity'); // legacy fallback

    // --- ensure the two buttons exist even if template is old ---
    // Sidebar toggle
    let sidebarToggle = document.getElementById('sidebarToggle');
    if (!sidebarToggle) {
      const sidebar = document.getElementById('sidebar');
      if (sidebar) {
        sidebarToggle = document.createElement('button');
        sidebarToggle.id = 'sidebarToggle';
        sidebarToggle.className = 'sidebar-toggle';
        sidebarToggle.setAttribute('aria-expanded', 'true');
        sidebarToggle.setAttribute('aria-label', 'Collapse sidebar');
        sidebarToggle.textContent = '⇦';
        sidebar.prepend(sidebarToggle);
        console.info('Injected missing #sidebarToggle button into sidebar.');
      } else {
        console.warn('Sidebar (#sidebar) not found; cannot inject toggle.');
      }
    }

    // Clear raster
    let clearBtn = document.getElementById('clearRasters');
    if (!clearBtn) {
      const buttonsBar = document.querySelector('#analysis .buttons');
      if (buttonsBar) {
        clearBtn = document.createElement('button');
        clearBtn.id = 'clearRasters';
        clearBtn.className = 'clear-raster';
        clearBtn.textContent = 'Clear raster';
        buttonsBar.appendChild(clearBtn);
        console.info('Injected missing #clearRasters button into analysis buttons.');
      } else {
        console.warn('Analysis buttons container not found; cannot inject Clear raster.');
      }
    }

    if (kval && kslider) {
      kval.textContent = kslider.value;
      kslider.addEventListener('input', () => kval.textContent = kslider.value);
    }

    // vector layers state
    let tractsLayer = null, wellsLayer = null, wellsCluster = null;
    let tractsBreaks = null, tractsColors = ramp(5);

    // ---------- raster overlay (single definition) ----------
    let rasterLayer = null;
    let rasterBounds = null;

    function toLeafletBounds(b) {
      // API returns [sw_lon, sw_lat, ne_lon, ne_lat]
      return L.latLngBounds([ [b[1], b[0]], [b[3], b[2]] ]);
    }
    function ensureRasterOverlay(url, boundsArray) {
      if (!url || !Array.isArray(boundsArray) || boundsArray.length !== 4) return null;
      const finalUrl = url + (url.includes('?') ? '&' : '?') + 'v=' + Date.now(); // cache-bust
      rasterBounds = toLeafletBounds(boundsArray);
      try { if (rasterLayer) map.removeLayer(rasterLayer); } catch {}
      const op = parseFloat(rasterOpacity?.value ?? 0.6);
      rasterLayer = L.imageOverlay(finalUrl, rasterBounds, {
        opacity: Number.isFinite(op) ? op : 0.6,
        interactive: false,
        pane: 'idwPane'
      });
      return rasterLayer;
    }
    function setRasterVisible(flag) {
      if (!rasterLayer) return;
      if (flag && !map.hasLayer(rasterLayer)) rasterLayer.addTo(map);
      if (!flag && map.hasLayer(rasterLayer)) map.removeLayer(rasterLayer);
      if (rasterToggle) rasterToggle.checked = !!flag;
      applyRasterOrder();
    }
    function setRasterOpacity(value) {
      if (!rasterLayer) return;
      const op = Math.max(0, Math.min(1, Number(value)));
      rasterLayer.setOpacity(op);
    }
    function applyRasterOrder() {
      if (!rasterLayer) return;
      const pane = map.getPane('idwPane');
      if (!pane) return;
      pane.style.zIndex = (rasterOnTop && rasterOnTop.checked) ? 430 : 380;
    }

    // fit map to data bounds
    try {
      const b = await fetch('/outputs/bounds.json').then(r => r.json());
      if (Array.isArray(b) && b.length === 4) map.fitBounds(toLeafletBounds(b), { padding: [20, 20] });
    } catch {}

    // ---------- tracts loader + legend ----------
    async function loadTracts() {
      const gj = await fetch('/outputs/tracts_base.geojson').then(r => r.json());
      const vals = gj.features.map(f => Number(f.properties?.canrate)).filter(Number.isFinite);
      if (!vals.length) return;
      const min = Math.min(...vals), max = Math.max(...vals);
      const classCount = 5;
      tractsBreaks = (methodSel && methodSel.value === 'equal') ? equalBreaks(min, max, classCount) : quantiles(vals, classCount);
      tractsColors = ramp(classCount);

      if (tractsLayer) tractsLayer.remove();
      tractsLayer = L.geoJSON(gj, {
        style: f => {
          const v = Number(f.properties?.canrate);
          const idx = Number.isFinite(v) ? classify(v, tractsBreaks) : 0;
          return { color: '#000', weight: 0.5, fillColor: tractsColors[idx], fillOpacity: parseFloat(tractsOpacity?.value ?? 0.6) };
        },
        onEachFeature: (feature, layer) => {
          const v = Number(feature.properties?.canrate);
          layer.bindPopup(`<b>Tract</b> ${feature.properties?.GEOID10 ?? ''}<br/>Cancer rate: ${fmt(v)}`);
          layer.on('mouseover', () => layer.setStyle({ weight: 2 }));
          layer.on('mouseout',  () => layer.setStyle({ weight: 0.5 }));
        }
      });
      if (!tractsToggle || tractsToggle.checked) tractsLayer.addTo(map);
      renderCancerLegend(vals, tractsBreaks, tractsColors);
      applyRasterOrder();
    }

    function renderCancerLegend(values, breaks, colors) {
      const legendEl = document.getElementById('legend');
      if (!legendEl) return;
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
        return isProportion ? Math.round(v).toLocaleString()
                            : v.toLocaleString(undefined, { maximumFractionDigits: 2 });
      };

      const items = [];
      items.push(`<div><b>Cancer Incidence Rate</b> ${unitLabel}</div>`);
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

    // ---------- wells loader ----------
    async function loadWells() {
      const gj = await fetch('/outputs/wells.geojson').then(r => r.json());
      if (wellsLayer) wellsLayer.remove();
      if (wellsCluster) wellsCluster.remove();

      const size = parseInt(pointSize?.value ?? '5', 10);
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

      const clustering = !!(window.L && L.markerClusterGroup && clusterToggle && clusterToggle.checked);
      if (clustering) {
        wellsCluster = L.markerClusterGroup({ disableClusteringAtZoom: 12 });
        wellsCluster.addLayer(wellsLayer);
        if (!wellsToggle || wellsToggle.checked) wellsCluster.addTo(map);
      } else {
        if (!wellsToggle || wellsToggle.checked) wellsLayer.addTo(map);
      }

      renderWellLegend();
      applyRasterOrder();
    }

    // ---------- raster + stats consumer ----------
    function handleRunResult(data, k) {
      try {
        // raster
        if (data && Array.isArray(data.bounds) && data.bounds.length === 4 && data.png) {
          const layer = ensureRasterOverlay(data.png, data.bounds);
          if (layer) {
            if (rasterToggle) rasterToggle.checked = true;
            if (!rasterToggle || rasterToggle.checked) {
              layer.addTo(map);
              try { if (rasterBounds) map.fitBounds(rasterBounds.pad(0.05)); } catch {}
            }
            if (rasterOpacity) setRasterOpacity(rasterOpacity.value || 0.6);
            applyRasterOrder();
          }
        }

        // OLS + downloads
        if (data?.ols && statsEl) {
          const s = data.ols;
          const p = (typeof s.p_value === 'number') ? s.p_value.toExponential(1) : '—';
          let slopeTxt = `slope=${fmt(s.slope)}`;
          if (s.rate_units === 'proportion') {
            slopeTxt += ` (~${fmt((s.slope || 0) * (s.rate_scale || 100000))} per 100,000 per mg/L)`;
          }
          const ciTxt = Array.isArray(s.ci) ? `[${fmt(s.ci[0])}, ${fmt(s.ci[1])}]` : '—';
          statsEl.innerHTML =
            `<div><b>OLS:</b> n=${s.n ?? '—'}, R²=${fmt(s.r2)}, ${slopeTxt}, p=${p}, CI=${ciTxt}</div>`;
        }
        if (data?.csv && dlCSV) { dlCSV.href = data.csv; dlCSV.textContent = 'Download CSV'; }
        if (data?.png && dlPNG) { dlPNG.href = data.png; dlPNG.textContent = `Raster k=${k}`; }

      } catch (err) {
        console.error('handleRunResult runtime error', err, data);
      }
    }

    // ---------- actions ----------
    async function runIDW() {
      setBusy(true);
      try {
        setStatus('Running IDW…');
        const k = parseFloat(kslider.value);
        const neighbors = parseInt(neighborsEl.value, 10);
        const cell = parseInt(cellEl.value, 10);

        const t = withTimeout(60000);
        const res = await fetch(`${location.origin}/api/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          cache: 'no-store',
          body: JSON.stringify({ k, neighbors, cell_size: cell }),
          signal: t.signal
        });
        t.done();

        if (!res.ok) {
          const txt = await res.text().catch(()=> '');
          console.error('API /api/run error', res.status, txt);
          throw new Error(`API /api/run ${res.status}`);
        }
        const data = await res.json();
        handleRunResult(data, k);
        setStatus('Done.');
      } catch (err) {
        console.error(err);
        setStatus('Error.');
      } finally {
        setBusy(false);
      }
    }

    function renderSensitivityTable(rows) {
      // If the structured table exists, use it; else fall back to the legacy text div.
      if (!(sensTable && sensTbody && sensEmpty)) {
        if (sensTextDiv) {
          if (!rows || !rows.length) { sensTextDiv.textContent = 'No sensitivity results.'; return; }
          sensTextDiv.innerHTML = rows.map(r => {
            const p = (r.p !== undefined && r.p !== null) ? r.p
                    : (r.p_value !== undefined && r.p_value !== null) ? safeExp(r.p_value)
                    : '—';
            const lo = (r.ci_lo !== undefined) ? r.ci_lo : r.ci_low;
            const hi = (r.ci_hi !== undefined) ? r.ci_hi : r.ci_high;
            return `k=${r.k}: n=${r.n ?? '—'} R²=${fmt(r.r2)} slope=${fmt(r.slope)} p=${p} CI=[${fmt(lo)}, ${fmt(hi)}]`;
          }).join('<br/>');
        }
        return;
      }

      sensTbody.innerHTML = '';
      if (!rows || !rows.length) {
        sensTable.style.display = 'none';
        sensEmpty.style.display = 'block';
        return;
      }

      const td = (v) => `<td>${v}</td>`;
      rows.forEach(r => {
        const pVal   = (r.p !== undefined && r.p !== null) ? r.p
                     : (r.p_value !== undefined && r.p_value !== null) ? safeExp(r.p_value)
                     : '—';
        const ciLo   = (r.ci_lo !== undefined) ? r.ci_lo : r.ci_low;
        const ciHi   = (r.ci_hi !== undefined) ? r.ci_hi : r.ci_high;

        const tr = document.createElement('tr');
        tr.innerHTML = [
          td(r.k ?? '—'),
          td(r.n ?? '—'),
          td(Number.isFinite(+r.r2)   ? (+r.r2).toFixed(3)   : '—'),
          td(Number.isFinite(+r.slope)? (+r.slope).toFixed(3): '—'),
          td(pVal),
          td(Number.isFinite(+ciLo)   ? (+ciLo).toFixed(3)   : '—'),
          td(Number.isFinite(+ciHi)   ? (+ciHi).toFixed(3)   : '—')
        ].join('');
        sensTbody.appendChild(tr);
      });
      sensEmpty.style.display = 'none';
      sensTable.style.display = 'table';
    }

    // Parse text blobs like "k=1.6 n=1308 R^2=0.018 slope=0.006 p=1.2e-6 CI=[0.003, 0.008]"
    function parseSensitivityText(textBlob) {
      const rows = [];
      const re = /k\s*=\s*([\d.]+).*?n\s*=\s*(\d+).*?R\^?2\s*=\s*([\d.]+).*?slope\s*=\s*([-\d.]+).*?p\s*=\s*([0-9eE+.\-]+).*?CI\s*=\s*\[\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\]/g;
      let m;
      while ((m = re.exec(textBlob)) !== null) {
        rows.push({
          k: Number(m[1]),
          n: Number(m[2]),
          r2: Number(m[3]),
          slope: Number(m[4]),
          p: m[5],
          ci_lo: Number(m[6]),
          ci_hi: Number(m[7])
        });
      }
      return rows;
    }

    async function runSensitivity() {
      setBusy(true);
      try {
        setStatus('Running sensitivity…');
        const ks = [1.0, 1.5, 2.0, 2.5, 3.0];
        const neighbors = parseInt(neighborsEl.value, 10) || 12;
        const cell = parseInt(cellEl.value, 10) || 1000;

        const t = withTimeout(60000);
        const res = await fetch(`${location.origin}/api/sensitivity`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          cache: 'no-store',
          body: JSON.stringify({ ks, neighbors, cell_size: cell }),
          signal: t.signal
        });
        t.done();

        if (!res.ok) {
          const txt = await res.text().catch(()=> '');
          console.error('API /api/sensitivity error', res.status, txt);
          throw new Error(`API /api/sensitivity ${res.status}`);
        }
        const data = await res.json();

        let rows = Array.isArray(data.rows) ? data.rows : null;
        if (!rows) {
          const raw = data.text || data.summary || '';
          rows = parseSensitivityText(raw);
        }
        renderSensitivityTable(rows);

        if (dlSens && data.csv) {
          dlSens.href = data.csv;
          dlSens.textContent = 'Download Sensitivity CSV';
        }
        setStatus('Done.');
      } catch (err) {
        console.error(err);
        setStatus('Error.');
      } finally {
        setBusy(false);
      }
    }

    // ---------- event wiring ----------
    if (rasterToggle) rasterToggle.checked = true; // default ON so new rasters auto-show
    if (rasterOpacity) rasterOpacity.addEventListener('input', () => setRasterOpacity(rasterOpacity.value));
    if (rasterToggle)  rasterToggle.addEventListener('change', () => setRasterVisible(rasterToggle.checked));
    if (rasterOnTop)   rasterOnTop.addEventListener('change', applyRasterOrder);

    if (tractsToggle)  tractsToggle.addEventListener('change', () => {
      if (!tractsLayer) return;
      if (tractsToggle.checked) tractsLayer.addTo(map); else tractsLayer.remove();
      applyRasterOrder();
    });
    if (wellsToggle)   wellsToggle.addEventListener('change', () => {
      if (wellsToggle.checked) {
        if (clusterToggle?.checked && wellsCluster) wellsCluster.addTo(map);
        else if (wellsLayer) wellsLayer.addTo(map);
      } else {
        if (wellsCluster) wellsCluster.remove();
        if (wellsLayer) wellsLayer.remove();
      }
      renderWellLegend();
      applyRasterOrder();
    });

    if (methodSel)     methodSel.addEventListener('change', loadTracts);
    if (tractsOpacity) tractsOpacity.addEventListener('input', debounce(loadTracts, 250));
    if (pointSize)     pointSize.addEventListener('input', debounce(loadWells, 250));
    if (clusterToggle) clusterToggle.addEventListener('change', loadWells);

    document.querySelectorAll('input[name="basemap"]').forEach(r => {
      r.addEventListener('change', () => {
        Object.values(base).forEach(l => map.removeLayer(l));
        base[r.value].addTo(map);
        applyRasterOrder();
      });
    });

    if (themeToggle) themeToggle.addEventListener('change', () => {
      document.body.style.setProperty('--bg', themeToggle.checked ? '#0b0d11' : '#ffffff');
      document.body.style.setProperty('--fg', themeToggle.checked ? '#e6e6e6' : '#111111');
      map.invalidateSize();
    });

    if (runBtn)  runBtn.addEventListener('click', runIDW);
    if (sensBtn) sensBtn.addEventListener('click', runSensitivity);

    // Sidebar collapse/expand with localStorage persistence
    if (sidebarToggle) {
      // a11y attributes
      sidebarToggle.setAttribute('role', 'button');
      sidebarToggle.setAttribute('tabindex', '0');

      const collapsed = localStorage.getItem('sidebarCollapsed') === '1';
      document.body.classList.toggle('sidebar-collapsed', collapsed);
      sidebarToggle.setAttribute('aria-expanded', (!collapsed).toString());
      setTimeout(() => map.invalidateSize(), 220);

      const toggleSidebar = () => {
        const now = !document.body.classList.contains('sidebar-collapsed');
        document.body.classList.toggle('sidebar-collapsed', now);
        localStorage.setItem('sidebarCollapsed', now ? '1' : '0');
        sidebarToggle.setAttribute('aria-expanded', (!now).toString());
        setTimeout(() => map.invalidateSize(), 220);
      };
      sidebarToggle.addEventListener('click', toggleSidebar);
      sidebarToggle.addEventListener('keydown', (e) => {
        if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggleSidebar(); }
        document.addEventListener('keydown', (e) => {
          if (e.altKey && (e.key === 's' || e.key === 'S')) {
            e.preventDefault();
            toggleSidebar();
          }
        });
      });
    }

    // Clear raster button
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        if (rasterLayer) {
          map.removeLayer(rasterLayer);
          rasterLayer = null;
        }
      });
    }

    // initial loads
    await loadTracts();
    await loadWells();
    renderWellLegend();

    setStatus('Ready.');
  });
})();
