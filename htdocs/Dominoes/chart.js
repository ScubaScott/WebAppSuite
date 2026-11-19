// Dominoes line chart: dependency-free SVG with one line per player.
const DOMINO_CHART_VERSION = "1.0";

const DominoChart = (() => {
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const W = 640;
    const H = 280;
    const MARGIN = { left: 42, right: 16, top: 14, bottom: 30 };

    // Creates an SVG element with attributes
    function el(tag, attrs) {
        const node = document.createElementNS(SVG_NS, tag);
        Object.keys(attrs || {}).forEach(k => node.setAttribute(k, attrs[k]));
        return node;
    }

    // Rounds the top of the y axis up to a tidy value and returns { max, step }
    function niceScale(maxValue) {
        const target = Math.max(maxValue, 10);
        const rough = target / 4;
        const pow = Math.pow(10, Math.floor(Math.log10(rough)));
        const step = [1, 2, 2.5, 5, 10].map(m => m * pow).find(s => s >= rough);
        return { max: Math.ceil(target / step) * step, step };
    }

    // Draws the chart into the svg element.
    // data: { rounds, series: [{ id, name, color, values: [number|null] }], selected, onRoundClick }
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

        // Selected-round highlight band sits behind everything else
        if (data.selected >= 0 && data.selected < rounds) {
            const bandW = rounds === 1 ? plotW : plotW / (rounds - 1);
            const x = Math.max(MARGIN.left, xAt(data.selected) - bandW / 2);
            const w = Math.min(bandW, MARGIN.left + plotW - x);
            svg.appendChild(el('rect', { x, y: MARGIN.top, width: w, height: plotH, class: 'chart-band' }));
        }

        // Grid lines and y-axis labels
        for (let v = 0; v <= scale.max + 0.001; v += scale.step) {
            const y = yAt(v);
            svg.appendChild(el('line', { x1: MARGIN.left, x2: W - MARGIN.right, y1: y, y2: y, class: 'chart-grid' }));
            const label = el('text', { x: MARGIN.left - 8, y: y + 4, class: 'chart-label', 'text-anchor': 'end' });
            label.textContent = String(Math.round(v * 10) / 10);
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

        // One line per player, broken wherever a round has no score
        data.series.forEach(s => {
            let path = '';
            let penDown = false;
            s.values.forEach((v, i) => {
                if (v === null) { penDown = false; return; }
                path += (penDown ? 'L' : 'M') + xAt(i).toFixed(1) + ' ' + yAt(v).toFixed(1);
                penDown = true;
            });
            svg.appendChild(el('path', { d: path, class: 'chart-line', stroke: s.color }));

            let lastIndex = -1;
            s.values.forEach((v, i) => { if (v !== null) lastIndex = i; });
            s.values.forEach((v, i) => {
                if (v === null) return;
                svg.appendChild(el('circle', {
                    cx: xAt(i), cy: yAt(v), r: i === lastIndex ? 5 : 3, fill: s.color, class: 'chart-dot'
                }));
            });
        });

        // Transparent columns capture taps on a round
        if (typeof data.onRoundClick === 'function') {
            const colW = rounds === 1 ? plotW : plotW / (rounds - 1);
            for (let i = 0; i < rounds; i++) {
                const x = Math.max(0, xAt(i) - colW / 2);
                const col = el('rect', {
                    x, y: MARGIN.top, width: Math.min(colW, W - x), height: plotH + MARGIN.bottom, class: 'chart-hit'
                });
                col.addEventListener('click', () => data.onRoundClick(i));
                svg.appendChild(col);
            }
        }
    }

    return { VERSION: DOMINO_CHART_VERSION, render };
})();
