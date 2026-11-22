// Farkle line chart: dependency-free SVG with one line per player.
const FARKLE_CHART_VERSION = "1.0";

const FarkleChart = (() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const W = 640;
  const H = 280;
  const MARGIN = { left: 48, right: 16, top: 14, bottom: 30 };

  // Line colors chosen to stay readable on the cream card background, one per seat
  const COLORS = ['#1f6fb2', '#c77700', '#2e7d32', '#c2185b', '#6a3fb5', '#d84315', '#00838f', '#6d6d00', '#455a64', '#b71c1c'];

  // Creates an SVG element with attributes
  function el(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    Object.keys(attrs || {}).forEach(k => node.setAttribute(k, attrs[k]));
    return node;
  }

  // Rounds the top of the y axis up to a tidy value and returns { max, step }
  function niceScale(maxValue) {
    const target = Math.max(maxValue, 100);
    const rough = target / 4;
    const pow = Math.pow(10, Math.floor(Math.log10(rough)));
    const step = [1, 2, 2.5, 5, 10].map(m => m * pow).find(s => s >= rough);
    return { max: Math.ceil(target / step) * step, step };
  }

  // Draws the chart into the svg element.
  // data: { rounds, series: [{ name, color, values: [number|null] }] }
  function render(svg, data) {
    svg.replaceChildren();
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);

    const plotW = W - MARGIN.left - MARGIN.right;
    const plotH = H - MARGIN.top - MARGIN.bottom;
    const rounds = Math.max(1, data.rounds);
    const hasData = data.series.some(s => s.values.some(v => v !== null));

    // Horizontal position of round i; a single round sits in the middle
    const xAt = i => MARGIN.left + (rounds === 1 ? plotW / 2 : (plotW * i) / (rounds - 1));

    if (!hasData) {
      const msg = el('text', { x: W / 2, y: H / 2, class: 'chart-empty', 'text-anchor': 'middle' });
      msg.textContent = 'Scores will chart here';
      svg.appendChild(msg);
      return;
    }

    const maxValue = Math.max(...data.series.flatMap(s => s.values.filter(v => v !== null)));
    const scale = niceScale(maxValue);
    const yAt = v => MARGIN.top + plotH - (v / scale.max) * plotH;

    // Grid lines and y-axis labels
    for (let v = 0; v <= scale.max + 0.001; v += scale.step) {
      const y = yAt(v);
      svg.appendChild(el('line', { x1: MARGIN.left, x2: W - MARGIN.right, y1: y, y2: y, class: 'chart-grid' }));
      const label = el('text', { x: MARGIN.left - 8, y: y + 4, class: 'chart-label', 'text-anchor': 'end' });
      label.textContent = Math.round(v).toLocaleString();
      svg.appendChild(label);
    }

    // X-axis round labels; thinned out when there are many rounds
    const labelEvery = rounds > 16 ? 3 : rounds > 9 ? 2 : 1;
    for (let i = 0; i < rounds; i++) {
      if (i % labelEvery !== 0 && i !== rounds - 1) continue;
      const label = el('text', { x: xAt(i), y: H - 8, class: 'chart-label', 'text-anchor': 'middle' });
      label.textContent = String(i + 1);
      svg.appendChild(label);
    }

    // One line per player, broken wherever a round has no score yet
    data.series.forEach(s => {
      let path = '';
      let penDown = false;
      s.values.forEach((v, i) => {
        if (v === null) { penDown = false; return; }
        path += (penDown ? 'L' : 'M') + xAt(i).toFixed(1) + ' ' + yAt(v).toFixed(1);
        penDown = true;
      });
      svg.appendChild(el('path', { d: path, class: 'chart-line', stroke: s.color }));

      // Dots on every round, the latest one larger
      let lastIndex = -1;
      s.values.forEach((v, i) => { if (v !== null) lastIndex = i; });
      s.values.forEach((v, i) => {
        if (v === null) return;
        svg.appendChild(el('circle', {
          cx: xAt(i), cy: yAt(v), r: i === lastIndex ? 5 : 3, fill: s.color, class: 'chart-dot'
        }));
      });
    });
  }

  return { VERSION: FARKLE_CHART_VERSION, COLORS, render };
})();
