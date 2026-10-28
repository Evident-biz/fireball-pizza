// Small single-series charts built from HTML so text stays crisp at any width.
// One hue (ember), thin bars with rounded data-ends, a hairline baseline, hover/focus
// tooltips, and direct labels only on the bars that matter (the highlighted one and the peak).

import { html } from './ui.js';

function niceMax(value) {
  if (value <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(value)));
  const n = value / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}

export function compact(n, prefix = '') {
  const abs = Math.abs(n);
  if (abs >= 1000000) return prefix + (n / 1000000).toFixed(abs >= 10000000 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (abs >= 1000) return prefix + (n / 1000).toFixed(abs >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'K';
  return prefix + Math.round(n);
}

// data: [{ label, value, tooltip }]
export function columnChart(data, { title, format = (v) => String(v), axisPrefix = '', highlight = -1, height = 180 } = {}) {
  const max = niceMax(Math.max(0, ...data.map((d) => d.value)));
  const peak = data.reduce((best, d, i) => (d.value > (data[best]?.value ?? -1) ? i : best), 0);
  return html`
    <figure class="chart" aria-label="${title}">
      <div class="chart-plot" style="height:${height}px">
        <div class="chart-grid">
          <span class="chart-tick" style="bottom:100%">${compact(max, axisPrefix)}</span>
          <span class="chart-tick" style="bottom:50%">${compact(max / 2, axisPrefix)}</span>
          <span class="chart-tick" style="bottom:0">${compact(0, axisPrefix)}</span>
        </div>
        <div class="chart-cols">
          ${data.map((d, i) => {
            const pct = max ? (d.value / max) * 100 : 0;
            const labelled = d.value > 0 && (i === highlight || i === peak);
            return html`
              <div class="chart-col ${i === highlight ? 'is-current' : ''}" tabindex="0" role="img" aria-label="${d.label}: ${format(d.value)}">
                <div class="chart-bar-wrap">
                  ${labelled ? html`<span class="chart-value" style="bottom:calc(${pct}% + 4px)">${compact(d.value, axisPrefix)}</span>` : ''}
                  <div class="chart-bar" style="height:${pct}%"></div>
                </div>
                <span class="chart-tip" role="tooltip"><strong>${d.label}</strong>${format(d.value)}${d.tooltip ? html`<br><span>${d.tooltip}</span>` : ''}</span>
              </div>`;
          })}
        </div>
      </div>
      <div class="chart-labels">${data.map((d, i) => html`<span class="${i === highlight ? 'is-current' : ''}">${d.label}</span>`)}</div>
    </figure>`;
}

// Horizontal bars for ranked categories or funnel stages. rows: [{ label, value, display, sub }]
export function barList(rows, { format = (v) => String(v), max } = {}) {
  const top = max ?? Math.max(1, ...rows.map((r) => r.value));
  return html`
    <ul class="barlist">
      ${rows.map((r) => html`
        <li>
          <div class="barlist-head"><span>${r.label}</span><strong>${r.display ?? format(r.value)}</strong></div>
          <div class="barlist-track"><div class="barlist-bar" style="width:${Math.max(r.value > 0 ? 1.5 : 0, (r.value / top) * 100)}%"></div></div>
          ${r.sub ? html`<div class="barlist-sub">${r.sub}</div>` : ''}
        </li>`)}
    </ul>`;
}
