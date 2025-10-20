// ui.js — GEOG 577 Project 1 (Flask + Leaflet)
// IDW → zonal → OLS with raster overlay
// Jenks(5) choropleth, raster z-order toggle, sensitivity table,
// sidebar collapse, zoom on right, on-map hamburger panel with Legend + OLS summary + sparkline.

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
    const spin = document.getElementById('spinner');
    if (runBtn)  { runBtn.disabled = isBusy;  runBtn.textContent  = isBusy ? 'Running...'  : 'Run'; }
    if (sensBtn) { sensBtn.disabled = isBusy; sensBtn.textContent = isBusy ? 'Working...' : 'Sensitivity'; }
    if (spin) {
      spin.classList.toggle('show', !!isBusy);
      spin.setAttribute('aria-hidden', (!isBusy).toString());
    }
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

  // ---------- classification ----------
  function classify(value, breaks) {
    let i = 0;
    for (; i < breaks.length; i++) { if (value <= breaks[i]) return i; }
    return breaks.length;
  }
  function jenksThresholds(values, k) {
    const data = values.filter(Number.isFinite).slice().sort((a,b)=>a-b);
    const n = data.length;
    if (!n || k < 2) return [];
    if (k > n) k = n;

    const mat1 = Array.from({length: n+1}, () => Array(k+1).fill(0));
    const mat2 = Array.from({length: n+1}, () => Array(k+1).fill(0));

    for (let i=1; i<=k; i++) {
      mat1[0][i] = 1; mat2[0][i] = 0;
      for (let j=1; j<=n; j++) mat2[j][i] = Infinity;
    }
    for (let j=1; j<=n; j++) { mat1[j][1] = 1; mat2[j][1] = 0; }

    for (let l=2; l<=n; l++) {
      let s1=0, s2=0, w=0;
      for (let m=1; m<=l; m++) {
        const i3 = l - m + 1;
        const val = data[i3-1];
        s1 += val; s2 += val*val; w += 1;
        const v = s2 - (s1*s1)/w;
        if (i3 !== 1) {
          for (let j=2; j<=k; j++) {
            if (mat2[l][j] >= (v + mat2[i3-1][j-1])) {
              mat1[l][j] = i3; mat2[l][j] = v + mat2[i3-1][j-1];
            }
          }
        }
      }
      mat1[l][1] = 1; mat2[l][1] = s2 - (s1*s1)/w;
    }

    const breaks = Array(k+1).fill(0);
    breaks[k] = data[n-1]; breaks[0] = data[0];
    let countNum = k, kclass = n;
    while (countNum > 1) {
      const id = mat1[kclass][countNum] - 2;
      breaks[countNum-1] = data[id];
      kclass = mat1[kclass][countNum] - 1;
      countNum--;
    }
    const uniq = [];
    for (let i=1; i<breaks.length-1; i++) {
      const b = breaks[i]; if (!uniq.length || b !== uniq[uniq.length-1]) uniq.push(b);
    }
    while (uniq.length > k-1) uniq.pop();
    while (uniq.length < k-1) uniq.push(breaks[breaks.length-2]);
    return uniq;
  }

  function setHTML(idList, html) {
    idList.forEach(id => { const el = document.getElementById(id); if (el) el.innerHTML = html; });
  }

  // ---------- page setup ----------
  document.addEventListener('DOMContentLoaded', async () => {
    setStatus('Booting UI...');

    // map + base layers
    const map = L.map('map', { zoomControl: false }).setView([44.5, -89.9], 7);
    const base = {
      osm:   L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',              { maxZoom: 19, attribution: '© OpenStreetMap' }),
      light: L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',  { attribution: '© OpenStreetMap, © CARTO' }),
      dark:  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',   { attribution: '© OpenStreetMap, © CARTO' })
    };
    base.osm.addTo(map);
    L.control.zoom({ position: 'topright' }).addTo(map);

    // pane for IDW raster
    map.createPane('idwPane');
    map.getPane('idwPane').style.zIndex = 380; // below vectors by default

    // controls/inputs
    const themeToggle   = document.getElementById('themeToggle');
    const tractsToggle  = document.getElementById('toggleTracts');
    const wellsToggle   = document.getElementById('toggleWells');
    const rasterToggle  = document.getElementById('toggleRaster');
    const tractsOpacity = document.getElementById('tractsOpacity');
    const pointSize     = document.getElementById('pointSize');
    const clusterToggle = document.getElementById('clusterToggle');
    if (clusterToggle) clusterToggle.checked = false; // default OFF
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

    // sensitivity table targets
    const sensTable  = document.getElementById('sensTable');
    const sensTbody  = sensTable ? sensTable.querySelector('tbody') : null;
    const sensEmpty  = document.getElementById('sensEmpty');
    const sensTextDiv= document.getElementById('sensitivity'); // legacy fallback

    if (kval && kslider) {
      kval.textContent = kslider.value;
      kslider.addEventListener('input', () => kval.textContent = kslider.value);
    }

    // vector layers state
    let tractsLayer = null, wellsLayer = null, wellsCluster = null;
    let tractsBreaks = null, tractsColors = ramp(5);

    // ---------- on-map info panel + hamburger ----------
    const infoPanel = document.createElement('div');
    infoPanel.className = 'map-panel';
    infoPanel.innerHTML = `
      <div class="section">
        <h4>Legend</h4>
        <div id="map-legend-tracts"></div>
        <div id="map-legend-wells" style="margin-top:8px;"></div>
      </div>
      <div class="section">
        <h4>Analysis summary</h4>
        <div id="map-ols"></div>
        <div id="sens-sparkline" class="sparkline" aria-label="Sensitivity sparkline"></div>
        <details>
          <summary>What do these mean?</summary>
          <div style="font-size:.9rem; color: var(--muted); line-height:1.35;">
            <b>k</b> IDW power • <b>n</b> tracts • <b>R²</b> variance explained •
            <b>Slope</b> Δ cancer rate per 1 mg/L nitrate •
            <b>p</b> significance • <b>CI</b> 95% confidence interval for the slope.
          </div>
        </details>
      </div>`;
    const mapContainer = map.getContainer();
    if (getComputedStyle(mapContainer).position === 'static') {
      mapContainer.style.position = 'relative';
    }
    mapContainer.appendChild(infoPanel);

    const InfoControl = L.Control.extend({
      onAdd: function() {
        const btn = L.DomUtil.create('button', 'map-toggle');
        btn.type = 'button';
        btn.title = 'Map overlay';
        btn.setAttribute('aria-label','Map overlay');
        btn.innerHTML = '☰';
        L.DomEvent.on(btn, 'click', (e) => {
          L.DomEvent.stopPropagation(e);
          infoPanel.classList.toggle('open');
          setTimeout(()=>map.invalidateSize(),200);
        });
        return btn;
      }, onRemove: function() {}
    });
    map.addControl(new InfoControl({ position: 'bottomleft' }));
    L.DomEvent.disableClickPropagation(infoPanel);
    L.DomEvent.on(infoPanel, 'mousewheel', L.DomEvent.stopPropagation);
    map.on('click', () => infoPanel.classList.remove('open'));

    // ---------- raster overlay ----------
    let rasterLayer = null;
    let rasterBounds = null;

    function toLeafletBounds(b) { return L.latLngBounds([ [b[1], b[0]], [b[3], b[2]] ]); }
    function ensureRasterOverlay(url, boundsArray) {
      if (!url || !Array.isArray(boundsArray) || boundsArray.length !== 4) return null;
      const finalUrl = url + (url.includes('?') ? '&' : '?') + 'v=' + Date.now();
      rasterBounds = toLeafletBounds(boundsArray);
      try { if (rasterLayer) map.removeLayer(rasterLayer); } catch {}
      const op = parseFloat(rasterOpacity?.value ?? 0.6);
      rasterLayer = L.imageOverlay(finalUrl, rasterBounds, { opacity: Number.isFinite(op) ? op : 0.6, interactive: false, pane: 'idwPane' });
      return rasterLayer;
    }
    function setRasterVisible(flag) {
      if (!rasterLayer) return;
      if (flag && !map.hasLayer(rasterLayer)) rasterLayer.addTo(map);
      if (!flag && map.hasLayer(rasterLayer)) map.removeLayer(rasterLayer);
      if (rasterToggle) rasterToggle.checked = !!flag;
      applyRasterOrder();
    }
    function setRasterOpacity(value) { if (rasterLayer) rasterLayer.setOpacity(Math.max(0, Math.min(1, Number(value)))); }
    function applyRasterOrder() {
      if (!rasterLayer) return;
      const pane = map.getPane('idwPane'); if (!pane) return;
      pane.style.zIndex = (rasterOnTop && rasterOnTop.checked) ? 430 : 380;
    }

    // fit to bounds if present
    try {
      const b = await fetch('/outputs/bounds.json').then(r => r.json());
      if (Array.isArray(b) && b.length === 4) map.fitBounds(toLeafletBounds(b), { padding: [20, 20] });
    } catch {}

    // ---------- tracts loader + legend (Jenks 5) ----------
    async function loadTracts() {
      const gj = await fetch('/outputs/tracts_base.geojson').then(r => r.json());
      const vals = gj.features.map(f => Number(f.properties?.canrate)).filter(Number.isFinite);
      if (!vals.length) return;
      const classCount = 5;
      tractsBreaks = jenksThresholds(vals, classCount);
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
        }
      });
      if (!tractsToggle || tractsToggle.checked) tractsLayer.addTo(map);
      renderCancerLegend(vals, tractsBreaks, tractsColors);
      applyRasterOrder();
    }

    function renderCancerLegend(values, breaks, colors) {
      if (!Array.isArray(breaks) || !breaks.length) {
        setHTML(['map-legend-tracts'], '<b>Cancer Incidence Rate</b><br/>No data');
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
      items.push(`<div><b>Cancer Incidence Rate</b> ${unitLabel} — Jenks (5)</div>`);
      for (let i = 0; i <= breaks.length; i++) {
        let label;
        if (i === 0) label = `< ${fmtLegend(breaks[0])}`;
        else if (i === breaks.length) label = `> ${fmtLegend(breaks[i - 1])}`;
        else label = `${fmtLegend(breaks[i - 1])} – ${fmtLegend(breaks[i])}`;
        const swatch = colors[i] ?? colors[colors.length - 1];
        items.push(`<div class="legend-row"><span class="legend-swatch" style="background:${swatch}"></span>${label}</div>`);
      }
      setHTML(['map-legend-tracts'], items.join(''));
    }

    function renderWellLegend() {
      const bins = [
        { label: '< 1 mg/L',    color: getWellColor(0.5) },
        { label: '1 – 3 mg/L',  color: getWellColor(2) },
        { label: '3 – 5 mg/L',  color: getWellColor(4) },
        { label: '5 – 10 mg/L', color: getWellColor(7) },
        { label: '≥ 10 mg/L',   color: getWellColor(12) }
      ];
      const rows = bins.map(b =>
        `<div class="legend-row"><span class="legend-swatch" style="background:${b.color}"></span>${b.label}</div>`
      ).join('');
      const clusterEl = document.getElementById('clusterToggle');
      const note = (clusterEl && clusterEl.checked)
        ? `<div class="legend-note" style="margin-top:4px; color:#9aa0a6;">Note: clustering groups points visually; colors still represent individual well values.</div>`
        : '';
      const html = `<div><b>Well Nitrate</b><br/>(mg/L)</div>${rows}${note}`;
      setHTML(['map-legend-wells'], html);
    }

    // ---------- wells loader ----------
    async function loadWells() {
      const gj = await fetch('/outputs/wells.geojson').then(r => r.json());
      if (wellsLayer) wellsLayer.remove();
      if (wellsCluster) wellsCluster.remove();

      const size = parseInt(pointSize?.value ?? '4', 10);
      const makeMarker = (f, latlng) => {
        const v = Number(f.properties?.nitr_ran);
        const color = getWellColor(v);
        return L.circleMarker(latlng, {
          radius: size, weight: 0.5, color: '#000', fillColor: color, fillOpacity: 0.9
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

        // OLS + downloads (sidebar text)
        if (data?.ols && statsEl) {
          const s = data.ols;
          const p = (typeof s.p_value === 'number') ? s.p_value.toExponential(1) : '—';
          let slopeTxt = `slope=${fmt(s.slope)}`;
          if (s.rate_units === 'proportion') {
            slopeTxt += ` (~${fmt((s.slope || 0) * (s.rate_scale || 100000))} per 100,000 per mg/L)`;
          }
          const ciTxt = Array.isArray(s.ci) ? `[${fmt(s.ci[0])}, ${fmt(s.ci[1])}]`
                                            : `[${fmt(s.ci_low ?? s.ci_lo)}, ${fmt(s.ci_high ?? s.ci_hi)}]`;
          statsEl.innerHTML = `<div><b>OLS:</b> n=${s.n ?? '—'}, R²=${fmt(s.r2)}, ${slopeTxt}, p=${p}, CI=${ciTxt}</div>`;

          // mirror compact summary into on-map panel
          const mapOls = document.getElementById('map-ols');
          if (mapOls) {
            const ciShort = Array.isArray(s.ci)
              ? `[${fmt(s.ci[0])}, ${fmt(s.ci[1])}]`
              : `[${fmt(s.ci_low ?? s.ci_lo)}, ${fmt(s.ci_high ?? s.ci_hi)}]`;
            let slopeShort = `${fmt(s.slope)}`;
            if (s.rate_units === 'proportion') {
              const per100k = Number.isFinite(s.slope) ? s.slope * (s.rate_scale || 100000) : null;
              if (per100k !== null) slopeShort += ` (~${fmt(per100k)} per 100,000/mg·L)`;
            }
            mapOls.innerHTML = `k=${fmt(s.k ?? k)} • n=${s.n ?? '—'} • R²=${fmt(s.r2)} • slope=${slopeShort} • p=${p} • CI=${ciShort}`;
          }
        }
        if (data?.csv && dlCSV) { dlCSV.href = data.csv; dlCSV.textContent = 'Download CSV'; }
        if (data?.png && dlPNG) { dlPNG.href = data.png; dlPNG.textContent = `Raster k=${k}`; }

      } catch (err) { console.error('handleRunResult runtime error', err, data); }
    }

    // ---------- sensitivity UI ----------
    function renderSensitivityTable(rows) {
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
      if (!rows || !rows.length) { sensTable.style.display = 'none'; sensEmpty.style.display = 'block'; return; }
      const td = (v) => `<td>${v}</td>`;
      rows.forEach(r => {
        const pVal = (r.p !== undefined && r.p !== null) ? r.p
                  : (r.p_value !== undefined && r.p_value !== null) ? safeExp(r.p_value) : '—';
        const ciLo = (r.ci_lo !== undefined) ? r.ci_lo : r.ci_low;
        const ciHi = (r.ci_hi !== undefined) ? r.ci_hi : r.ci_high;
        const tr = document.createElement('tr');
        tr.innerHTML = [
          td(r.k ?? '—'),
          td(r.n ?? '—'),
          td(Number.isFinite(+r.r2)    ? (+r.r2).toFixed(3)    : '—'),
          td(Number.isFinite(+r.slope) ? (+r.slope).toFixed(3) : '—'),
          td(pVal),
          td(Number.isFinite(+ciLo)    ? (+ciLo).toFixed(3)    : '—'),
          td(Number.isFinite(+ciHi)    ? (+ciHi).toFixed(3)    : '—')
        ].join('');
        sensTbody.appendChild(tr);
      });
      sensEmpty.style.display = 'none';
      sensTable.style.display = 'table';
    }

    // Tiny inline sparkline for slope vs k (≈120×28)
    function renderSensitivitySparkline(rows) {
      const host = document.getElementById('sens-sparkline');
      if (!host) return;
      host.innerHTML = '';
      if (!Array.isArray(rows) || rows.length === 0) return;

      const pts = rows
        .map(r => ({ k: Number(r.k), slope: Number(r.slope) }))
        .filter(p => Number.isFinite(p.k) && Number.isFinite(p.slope))
        .sort((a,b)=>a.k-b.k);
      if (!pts.length) return;

      const W = 120, H = 28, pad = 4;
      const ks = pts.map(p=>p.k);
      const ss = pts.map(p=>p.slope);
      const kMin = Math.min(...ks), kMax = Math.max(...ks);
      const sMin = Math.min(...ss), sMax = Math.max(...ss);
      const x = (v)=> pad + (W-2*pad) * ((v - kMin) / (kMax - kMin || 1));
      const y = (v)=> {
        if (sMax === sMin) return H/2;
        return H - pad - (H-2*pad) * ((v - sMin) / (sMax - sMin));
      };

      // Polyline path
      const path = pts.map((p,i)=> (i? 'L':'M') + x(p.k).toFixed(1) + ',' + y(p.slope).toFixed(1)).join(' ');

      // Optional baseline at y=0
      const zeroInRange = (sMin <= 0 && sMax >= 0);
      const zeroY = y(0);

      const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      svg.setAttribute('width', W);
      svg.setAttribute('height', H);
      svg.setAttribute('role','img');
      svg.setAttribute('aria-label','Slope vs k sparkline');

      if (zeroInRange) {
        const base = document.createElementNS(svg.namespaceURI,'line');
        base.setAttribute('x1', pad); base.setAttribute('x2', W-pad);
        base.setAttribute('y1', zeroY.toFixed(1)); base.setAttribute('y2', zeroY.toFixed(1));
        base.setAttribute('stroke', 'rgba(255,255,255,0.25)');
        base.setAttribute('stroke-width','1');
        svg.appendChild(base);
      }

      const pl = document.createElementNS(svg.namespaceURI,'path');
      pl.setAttribute('d', path);
      pl.setAttribute('fill','none');
      pl.setAttribute('stroke','rgba(77,163,255,0.9)');
      pl.setAttribute('stroke-width','1.5');
      svg.appendChild(pl);

      // tiny end dots for readability
      pts.forEach(p=>{
        const c = document.createElementNS(svg.namespaceURI,'circle');
        c.setAttribute('cx', x(p.k).toFixed(1));
        c.setAttribute('cy', y(p.slope).toFixed(1));
        c.setAttribute('r','1.8');
        c.setAttribute('fill','rgba(77,163,255,0.9)');
        svg.appendChild(c);
      });

      host.appendChild(svg);
    }

    function parseSensitivityText(textBlob) {
      const rows = [];
      const re = /k\s*=\s*([\d.]+).*?n\s*=\s*(\d+).*?R\^?2\s*=\s*([\d.]+).*?slope\s*=\s*([-\d.]+).*?p\s*=\s*([0-9eE+.\-]+).*?CI\s*=\s*\[\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\]/g;
      let m;
      while ((m = re.exec(textBlob)) !== null) {
        rows.push({ k: +m[1], n: +m[2], r2: +m[3], slope: +m[4], p: m[5], ci_lo: +m[6], ci_hi: +m[7] });
      }
      return rows;
    }

    async function runSensitivity() {
      setBusy(true);
      try {
        setStatus('Running sensitivity...');
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

        if (!res.ok) throw new Error(`API /api/sensitivity ${res.status}`);
        const data = await res.json();

        let rows = Array.isArray(data.rows) ? data.rows : null;
        if (!rows) rows = parseSensitivityText(data.text || data.summary || '');
        renderSensitivityTable(rows);
        renderSensitivitySparkline(rows);

        if (dlSens && data.csv) { dlSens.href = data.csv; dlSens.textContent = 'Download Sensitivity CSV'; }
        setStatus('Done.');
      } catch (err) { console.error(err); setStatus('Error.'); }
      finally { setBusy(false); }
    }

    // ---------- events ----------
    if (rasterToggle) rasterToggle.checked = true;
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

    if (runBtn)  runBtn.addEventListener('click', async () => {
      await runIDW();
      // after a run, keep overlay honest (legend & summary already update)
    });
    if (sensBtn) sensBtn.addEventListener('click', runSensitivity);

    // Sidebar collapse/expand (button, peek, hotkey, persistence)
    const sidebar       = document.getElementById('sidebar');
    const sidebarToggle = document.getElementById('sidebarToggle');
    const sidebarPeek   = document.getElementById('sidebarPeek');

    function isCollapsed() {
      return document.body.classList.contains('sidebar-collapsed');
    }
    function setSidebar(collapsed) {
      document.body.classList.toggle('sidebar-collapsed', !!collapsed);
      if (sidebarToggle) {
        sidebarToggle.setAttribute('aria-expanded', (!collapsed).toString());
        sidebarToggle.textContent = collapsed ? '⇨' : '⇦';
        sidebarToggle.title = collapsed ? 'Open sidebar' : 'Collapse sidebar';
      }
      try { localStorage.setItem('sidebarCollapsed', collapsed ? '1' : '0'); } catch {}
      if (typeof map !== 'undefined' && map && map.invalidateSize) {
        setTimeout(() => map.invalidateSize(), 220);
      }
    }
    if (sidebarToggle) sidebarToggle.addEventListener('click', () => setSidebar(!isCollapsed()));
    if (sidebarPeek)   sidebarPeek.addEventListener('click',   () => setSidebar(false));
    document.addEventListener('keydown', (e) => {
      if (e.altKey && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        setSidebar(!isCollapsed());
      }
    });
    try {
      const saved = localStorage.getItem('sidebarCollapsed');
      setSidebar(saved === '1');
    } catch { setSidebar(false); }

    // Clear raster (ensure button exists)
    let clearBtn = document.getElementById('clearRasters');
    if (!clearBtn) {
      const buttonsBar = document.querySelector('#analysis .buttons');
      if (buttonsBar) {
        clearBtn = document.createElement('button');
        clearBtn.id = 'clearRasters';
        clearBtn.className = 'clear-raster';
        clearBtn.textContent = 'Clear raster';
        buttonsBar.appendChild(clearBtn);
      }
    }
    if (clearBtn) clearBtn.addEventListener('click', () => { if (rasterLayer) { map.removeLayer(rasterLayer); rasterLayer = null; } });

    // initial loads
    await loadTracts();
    await loadWells();
    renderWellLegend();

    setStatus('Ready.');

    // About modal wiring
    (function(){
      const aboutBtn = document.getElementById('aboutBtn');
      const modal = document.getElementById('aboutModal');
      const close = document.getElementById('aboutClose');
      if (aboutBtn && modal) {
        aboutBtn.addEventListener('click', (e)=>{ e.preventDefault(); modal.setAttribute('aria-hidden','false'); });
      }
      if (close && modal) {
        close.addEventListener('click', ()=> modal.setAttribute('aria-hidden','true'));
      }
      if (modal) {
        modal.addEventListener('click', (e)=>{ if (e.target === modal) modal.setAttribute('aria-hidden','true'); });
        document.addEventListener('keydown', (e)=>{ if (e.key === 'Escape') modal.setAttribute('aria-hidden','true'); });
      }
    })();

    // helper defined after use:
    async function runIDW() {
      setBusy(true);
      try {
        setStatus('Running IDW...');
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

        if (!res.ok) throw new Error(`API /api/run ${res.status}`);
        const data = await res.json();
        handleRunResult(data, k);
        setStatus('Done.');
      } catch (err) {
        console.error(err); setStatus('Error.');
      } finally { setBusy(false); }
    }

  });
})();
