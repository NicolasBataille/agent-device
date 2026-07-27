// Zero-dependency canvas viewer. Layout coordinates arrive precomputed from
// scripts/depgraph/build.ts, so this file only ever renders, hit-tests, and filters —
// no physics runs on the device.

(() => {
  const data = JSON.parse(document.getElementById('graph-data').textContent);
  const nodes = data.nodes;
  const edges = data.edges;
  const zones = data.zones;

  const KIND = ['value', 'type', 'dynamic'];
  const FLAG_BACK = 1;
  const FLAG_REDUNDANT = 2;
  const FLAG_TYPE_INVERSION = 4;

  const outEdges = nodes.map(() => []);
  const inEdges = nodes.map(() => []);
  edges.forEach((edge, index) => {
    outEdges[edge[0]].push(index);
    inEdges[edge[1]].push(index);
  });

  const edgeByPair = new Map();
  edges.forEach((edge, index) => edgeByPair.set(`${edge[0]},${edge[1]}`, index));

  const cycleEdges = new Set();
  const cycleNodes = new Set();
  for (const cycle of data.cycles) {
    for (let index = 0; index < cycle.path.length; index++) {
      cycleNodes.add(cycle.path[index]);
      const next = cycle.path[index + 1];
      if (next === undefined) continue;
      const edgeIndex = edgeByPair.get(`${cycle.path[index]},${next}`);
      if (edgeIndex !== undefined) cycleEdges.add(edgeIndex);
    }
  }

  const cyclesByNode = new Map();
  data.cycles.forEach((cycle, index) => {
    for (const node of cycle.path) {
      if (!cyclesByNode.has(node)) cyclesByNode.set(node, index);
    }
  });

  const state = {
    layout: 'cluster',
    size: 'degree',
    showBack: false,
    showCycles: false,
    showRedundant: false,
    showTypeInversion: false,
    hideWeak: false,
    labels: true,
    query: '',
    hiddenZones: new Set(),
    selected: null,
    hover: null,
  };

  const canvas = document.getElementById('canvas');
  const context = canvas.getContext('2d');
  const tooltip = document.getElementById('tooltip');
  const camera = { x: 0, y: 0, k: 1 };
  let width = 0;
  let height = 0;
  let ratio = 1;
  let frame = null;

  const palette = {};
  function readPalette() {
    const styles = getComputedStyle(document.documentElement);
    for (let rank = 0; rank <= 6; rank++) {
      palette[rank] = styles.getPropertyValue(`--rank-${rank}`).trim();
    }
    palette.none = styles.getPropertyValue('--rank-none').trim();
    palette.edge = styles.getPropertyValue('--edge').trim();
    palette.edgeWeak = styles.getPropertyValue('--edge-weak').trim();
    palette.critical = styles.getPropertyValue('--critical').trim();
    palette.warning = styles.getPropertyValue('--warning').trim();
    palette.ink = styles.getPropertyValue('--ink').trim();
    palette.inkFaint = styles.getPropertyValue('--ink-faint').trim();
    palette.accent = styles.getPropertyValue('--accent').trim();
    palette.halo = styles.getPropertyValue('--halo').trim();
  }

  // Rank carries the hue; zones sharing a rank are separated by lightness, and unranked
  // zones get a muted wheel of their own so twelve of them are still tellable apart
  // without ever competing with the ramp.
  let zoneColors = [];

  function parseColor(value) {
    const hex = value.replace('#', '').trim();
    const full =
      hex.length === 3
        ? hex
            .split('')
            .map((character) => character + character)
            .join('')
        : hex;
    return [
      parseInt(full.slice(0, 2), 16),
      parseInt(full.slice(2, 4), 16),
      parseInt(full.slice(4, 6), 16),
    ];
  }

  function shade(value, amount) {
    const [red, green, blue] = parseColor(value);
    const target = amount > 0 ? 255 : 0;
    const weight = Math.abs(amount);
    const mix = (channel) => Math.round(channel + (target - channel) * weight);
    return `rgb(${mix(red)},${mix(green)},${mix(blue)})`;
  }

  function computeZoneColors() {
    const [red, green, blue] = parseColor(
      getComputedStyle(document.documentElement).getPropertyValue('--ground'),
    );
    const dark = (red * 0.299 + green * 0.587 + blue * 0.114) / 255 < 0.5;
    const byRank = new Map();
    for (let index = 0; index < zones.length; index++) {
      const rank = zones[index].rank;
      const list = byRank.get(rank) ?? [];
      list.push(index);
      byRank.set(rank, list);
    }
    zoneColors = new Array(zones.length);
    for (const [rank, list] of byRank) {
      list.sort((left, right) => zones[left].id.localeCompare(zones[right].id));
      list.forEach((zoneIndex, position) => {
        if (rank === null) {
          const hue = (28 + (position * 320) / Math.max(list.length, 1)) % 360;
          const lightness = (dark ? 58 : 42) + (position % 2 === 0 ? 7 : -7);
          zoneColors[zoneIndex] = `hsl(${hue.toFixed(0)} 26% ${lightness}%)`;
          return;
        }
        const offset = list.length === 1 ? 0 : (position / (list.length - 1) - 0.5) * 0.44;
        zoneColors[zoneIndex] = shade(palette[rank], dark ? offset : -offset);
      });
    }
  }

  function zoneColor(zoneIndex) {
    return zoneColors[zoneIndex] ?? palette.none;
  }

  // ---------- geometry ----------

  function position(node) {
    return state.layout === 'cluster' ? { x: node.cx, y: node.cy } : { x: node.lx, y: node.ly };
  }

  // Transition positions when the layout changes, so the eye can follow a node across
  // the two views instead of re-finding it.
  let morph = null;
  function livePosition(node) {
    const target = position(node);
    if (!morph) return target;
    const from =
      morph.layout === 'cluster' ? { x: node.cx, y: node.cy } : { x: node.lx, y: node.ly };
    return {
      x: from.x + (target.x - from.x) * morph.t,
      y: from.y + (target.y - from.y) * morph.t,
    };
  }

  function radius(node) {
    if (state.size === 'loc') return 2 + Math.sqrt(node.loc) * 0.42;
    if (state.size === 'in') return 2.4 + Math.sqrt(node.in) * 1.5;
    return 2.4 + Math.sqrt(node.in + node.out) * 1.15;
  }

  function screenRadius(node) {
    return Math.max(1.5, radius(node) * Math.min(Math.max(camera.k, 0.45), 3));
  }

  function toScreen(point) {
    return {
      x: (point.x - camera.x) * camera.k + width / 2,
      y: (point.y - camera.y) * camera.k + height / 2,
    };
  }

  function visible(index) {
    return !state.hiddenZones.has(nodes[index].z);
  }

  function matched(index) {
    return state.query === '' || nodes[index].id.toLowerCase().includes(state.query);
  }

  function neighbourhood(index) {
    if (index === null) return null;
    const set = new Set([index]);
    for (const edge of outEdges[index]) set.add(edges[edge][1]);
    for (const edge of inEdges[index]) set.add(edges[edge][0]);
    return set;
  }

  // ---------- rendering ----------

  function resize() {
    ratio = Math.min(window.devicePixelRatio || 1, 2);
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    schedule();
  }

  function schedule() {
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      draw();
    });
  }

  function edgeStyle(index) {
    const edge = edges[index];
    const kind = edge[2];
    if (state.hideWeak && kind !== 0) return null;
    if (state.showBack && edge[3] & FLAG_BACK) return 'critical';
    if (state.showTypeInversion && edge[3] & FLAG_TYPE_INVERSION) return 'warning';
    if (state.showCycles && cycleEdges.has(index)) return 'critical';
    if (state.showRedundant && edge[3] & FLAG_REDUNDANT) return 'warning';
    return kind === 0 ? 'base' : 'weak';
  }

  function draw() {
    context.clearRect(0, 0, width, height);
    const anchor = state.selected ?? state.hover;
    const focus = neighbourhood(anchor);
    const buckets = { weak: [], base: [], warning: [], critical: [], focus: [] };

    for (let index = 0; index < edges.length; index++) {
      const edge = edges[index];
      if (!visible(edge[0]) || !visible(edge[1])) continue;
      const style = edgeStyle(index);
      if (style === null) continue;
      // With a node selected, its own edges are the whole story: overlay colouring stays
      // on that node's edges and everything else drops out rather than competing.
      if (focus) {
        if (edge[0] !== anchor && edge[1] !== anchor) continue;
        buckets[style === 'critical' || style === 'warning' ? style : 'focus'].push(index);
        continue;
      }
      buckets[style].push(index);
    }

    const strokes = {
      weak: { color: palette.edgeWeak, width: 0.6, alpha: 0.7 },
      base: { color: palette.edge, width: 0.7, alpha: 1 },
      warning: { color: palette.warning, width: 1.1, alpha: 0.75 },
      critical: { color: palette.critical, width: 1.4, alpha: 0.9 },
      focus: { color: palette.accent, width: 1.3, alpha: 0.95 },
    };

    for (const name of ['weak', 'base', 'warning', 'critical', 'focus']) {
      const list = buckets[name];
      if (list.length === 0) continue;
      const stroke = strokes[name];
      context.globalAlpha = stroke.alpha;
      context.strokeStyle = stroke.color;
      context.lineWidth = Math.max(stroke.width, stroke.width * Math.min(camera.k, 2.2));
      context.beginPath();
      for (const index of list) {
        const from = toScreen(livePosition(nodes[edges[index][0]]));
        const to = toScreen(livePosition(nodes[edges[index][1]]));
        context.moveTo(from.x, from.y);
        context.lineTo(to.x, to.y);
      }
      context.stroke();
    }
    context.globalAlpha = 1;

    const labels = [];
    for (let index = 0; index < nodes.length; index++) {
      if (!visible(index)) continue;
      const node = nodes[index];
      const point = toScreen(livePosition(node));
      const size = screenRadius(node);
      if (point.x < -40 || point.y < -40 || point.x > width + 40 || point.y > height + 40) continue;

      const isMatch = matched(index);
      const inFocus = !focus || focus.has(index);
      const flagged =
        (state.showCycles && cycleNodes.has(index)) ||
        (state.showBack && outEdges[index].some((edge) => edges[edge][3] & FLAG_BACK)) ||
        (state.showTypeInversion &&
          outEdges[index].some((edge) => edges[edge][3] & FLAG_TYPE_INVERSION));

      context.globalAlpha = isMatch ? (inFocus ? 1 : 0.22) : 0.08;
      context.beginPath();
      context.arc(point.x, point.y, size, 0, Math.PI * 2);
      context.fillStyle = flagged ? palette.critical : zoneColor(node.z);
      context.fill();

      if (index === state.selected || (isMatch && state.query !== '')) {
        context.lineWidth = 1.5;
        context.strokeStyle = index === state.selected ? palette.ink : palette.accent;
        context.stroke();
      }

      if (
        state.labels &&
        isMatch &&
        inFocus &&
        (index === state.selected || (camera.k > 1.1 && size > 4) || size > 11)
      ) {
        labels.push({ point, size, node, strong: index === state.selected });
      }
      context.globalAlpha = 1;
    }

    labels.sort((left, right) => right.size - left.size);
    context.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    context.textBaseline = 'middle';
    for (const label of labels.slice(0, 220)) {
      const text = label.strong ? label.node.id : label.node.id.split('/').pop();
      const x = label.point.x + label.size + 4;
      const metrics = context.measureText(text);
      context.globalAlpha = 0.82;
      context.fillStyle = palette.halo;
      context.fillRect(x - 2, label.point.y - 7, metrics.width + 4, 14);
      context.globalAlpha = 1;
      context.fillStyle = label.strong ? palette.ink : palette.inkFaint;
      context.fillText(text, x, label.point.y);
    }
  }

  // ---------- camera ----------

  function bounds() {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let index = 0; index < nodes.length; index++) {
      if (!visible(index)) continue;
      const point = position(nodes[index]);
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
    if (minX === Infinity) return { minX: -100, minY: -100, maxX: 100, maxY: 100 };
    return { minX, minY, maxX, maxY };
  }

  // The rail and the detail panel float over the canvas, so framing has to target the
  // clear area rather than the viewport — otherwise "fit" hides a third of the graph
  // behind the controls.
  function insets() {
    const wide = window.innerWidth > 860;
    return {
      left: wide ? 314 : 12,
      right: wide && detail.classList.contains('open') ? 366 : 12,
      top: wide ? 58 : 92,
      bottom: wide ? 26 : 72,
    };
  }

  function fit() {
    const box = bounds();
    const inset = insets();
    const availableWidth = Math.max(width - inset.left - inset.right, 80);
    const availableHeight = Math.max(height - inset.top - inset.bottom, 80);
    const spanX = Math.max(box.maxX - box.minX, 1);
    const spanY = Math.max(box.maxY - box.minY, 1);
    camera.k = Math.min(availableWidth / spanX, availableHeight / spanY);
    camera.x = (box.minX + box.maxX) / 2 - (inset.left + availableWidth / 2 - width / 2) / camera.k;
    camera.y =
      (box.minY + box.maxY) / 2 - (inset.top + availableHeight / 2 - height / 2) / camera.k;
    schedule();
  }

  function zoomBy(factor, anchorX = width / 2, anchorY = height / 2) {
    const before = {
      x: (anchorX - width / 2) / camera.k + camera.x,
      y: (anchorY - height / 2) / camera.k + camera.y,
    };
    camera.k = Math.max(0.02, Math.min(camera.k * factor, 24));
    const after = {
      x: (anchorX - width / 2) / camera.k + camera.x,
      y: (anchorY - height / 2) / camera.k + camera.y,
    };
    camera.x += before.x - after.x;
    camera.y += before.y - after.y;
    schedule();
  }

  function focusNode(index, zoom = true) {
    const point = position(nodes[index]);
    camera.x = point.x;
    camera.y = point.y;
    if (zoom) camera.k = Math.max(camera.k, 2.2);
    select(index);
  }

  function pick(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    let best = null;
    let bestDistance = Infinity;
    for (let index = 0; index < nodes.length; index++) {
      if (!visible(index) || !matched(index)) continue;
      const point = toScreen(livePosition(nodes[index]));
      const size = screenRadius(nodes[index]);
      const distance = (point.x - x) ** 2 + (point.y - y) ** 2;
      const threshold = Math.max(size + 7, 12) ** 2;
      if (distance < threshold && distance < bestDistance) {
        best = index;
        bestDistance = distance;
      }
    }
    return best;
  }

  // ---------- detail panel ----------

  const detail = document.getElementById('detail');

  // Everything below builds DOM nodes and sets `textContent` rather than assembling an
  // HTML string. The graph payload is read out of the page (`textContent` of an inline
  // JSON block), which makes any interpolation of it into `innerHTML` a text-to-HTML
  // reinterpretation — CodeQL flagged four, and hand-escaping only moves the problem to
  // "did every interpolation remember to escape". With no HTML sink there is nothing to
  // escape: a file path containing `<` renders as that path.
  function el(tag, props, children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props ?? {})) {
      if (value === undefined || value === false) continue;
      if (key === 'text') node.textContent = String(value);
      else if (key === 'class') node.className = value;
      else if (key === 'style') node.setAttribute('style', value);
      else if (key.startsWith('data-') || key.startsWith('aria-')) {
        node.setAttribute(key, String(value));
      } else node[key] = value;
    }
    for (const child of children ?? []) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child);
    }
    return node;
  }

  function replaceChildren(target, children) {
    target.replaceChildren(...children.filter(Boolean));
  }

  function edgeTags(edge, index) {
    const tags = [];
    if (edge[2] !== 0)
      tags.push(el('span', { class: `tag ${KIND[edge[2]]}`, text: KIND[edge[2]] }));
    if (edge[3] & FLAG_BACK) tags.push(el('span', { class: 'tag back', text: 'back-edge' }));
    if (edge[3] & FLAG_TYPE_INVERSION) {
      tags.push(el('span', { class: 'tag redundant', text: 'type inversion' }));
    }
    if (edge[3] & FLAG_REDUNDANT) {
      tags.push(el('span', { class: 'tag redundant', text: 'redundant' }));
    }
    if (cycleEdges.has(index)) tags.push(el('span', { class: 'tag back', text: 'cycle' }));
    return tags;
  }

  function depList(title, edgeIndices, endpoint) {
    const heading = el('h3', { text: `${title} — ${edgeIndices.length}` });
    if (edgeIndices.length === 0) {
      return el('div', { class: 'deps' }, [heading, el('p', { class: 'empty', text: 'none' })]);
    }
    const rows = edgeIndices
      .map((index) => ({ index, other: edges[index][endpoint] }))
      .sort((left, right) => nodes[left.other].id.localeCompare(nodes[right.other].id))
      .map(({ index, other }) =>
        el('li', {}, [
          el('button', { type: 'button', 'data-goto': other }, [
            el('span', { text: nodes[other].id }),
            ...edgeTags(edges[index], index),
          ]),
        ]),
      );
    return el('div', { class: 'deps' }, [heading, el('ul', {}, rows)]);
  }

  function fact(term, value) {
    return el('div', { class: 'fact' }, [
      el('dt', { text: term }),
      el('dd', { text: String(value) }),
    ]);
  }

  function select(index) {
    state.selected = index;
    if (index === null) {
      detail.classList.remove('open');
      detail.replaceChildren();
      syncToggle();
      schedule();
      return;
    }

    const node = nodes[index];
    const zone = zones[node.z];
    const cycleIndex = cyclesByNode.get(index);
    const backOut = outEdges[index].filter((edge) => edges[edge][3] & FLAG_BACK).length;
    const redundantOut = outEdges[index].filter((edge) => edges[edge][3] & FLAG_REDUNDANT).length;

    const pills = [
      el('span', {
        class: 'pill rank',
        text: `${zone.id}${zone.rank === null ? ' · unranked' : ` · rank ${zone.rank}`}`,
      }),
    ];
    if (cycleIndex !== undefined) {
      pills.push(
        el('span', { class: 'pill critical', text: `${data.cycles[cycleIndex].kind} cycle` }),
      );
    }
    if (backOut > 0) {
      pills.push(el('span', { class: 'pill critical', text: `${backOut} back-edge` }));
    }
    if (redundantOut > 0) {
      pills.push(el('span', { class: 'pill warning', text: `${redundantOut} redundant` }));
    }

    replaceChildren(detail, [
      el('div', { class: 'detail-head' }, [
        el('h2', { text: `src/${node.id}` }),
        el('button', {
          type: 'button',
          class: 'close',
          'data-close': '',
          'aria-label': 'Close details',
          text: '×',
        }),
      ]),
      el('div', {}, pills),
      el('dl', { class: 'facts' }, [
        fact('Dependents', node.in),
        fact('Dependencies', node.out),
        fact('Lines', node.loc),
        fact('Depth to sink', node.lvl),
      ]),
      depList('Imported by', inEdges[index], 0),
      depList('Imports', outEdges[index], 1),
    ]);
    detail.classList.add('open');
    syncToggle();
    schedule();
  }

  detail.addEventListener('click', (event) => {
    const goto = event.target.closest('[data-goto]');
    if (goto) {
      focusNode(Number(goto.dataset.goto), false);
      return;
    }
    if (event.target.closest('[data-close]')) select(null);
  });

  // ---------- chrome ----------

  function renderStats() {
    const backEdges = edges.filter((edge) => edge[3] & FLAG_BACK).length;
    const redundant = edges.filter((edge) => edge[3] & FLAG_REDUNDANT).length;
    const typeInversions = edges.filter((edge) => edge[3] & FLAG_TYPE_INVERSION).length;
    const valueCycles = data.cycles.filter((cycle) => cycle.kind === 'value').length;
    const weakCycles = data.cycles.length - valueCycles;
    const cells = [
      { label: 'files', value: data.generated.files, tone: '' },
      { label: 'edges', value: data.generated.edges, tone: '' },
      { label: 'zones', value: zones.length, tone: '' },
      {
        label: 'back-edges',
        value: backEdges,
        tone: backEdges === 0 ? 'is-ok' : 'is-critical',
      },
      {
        label: 'value cycles',
        value: valueCycles,
        tone: valueCycles === 0 ? 'is-ok' : 'is-critical',
      },
      {
        label: 'type/dynamic cycles',
        value: weakCycles,
        tone: weakCycles === 0 ? 'is-ok' : 'is-warning',
      },
      {
        label: 'type inversions (R6)',
        value: typeInversions,
        tone: typeInversions === 0 ? 'is-ok' : 'is-warning',
      },
      {
        label: 'redundant edges',
        value: redundant,
        tone: redundant === 0 ? 'is-ok' : 'is-warning',
      },
    ];
    replaceChildren(
      document.getElementById('stats'),
      cells.map((cell) =>
        el('div', { class: `stat ${cell.tone}` }, [
          el('b', { text: String(cell.value) }),
          document.createTextNode(cell.label),
        ]),
      ),
    );
    document.getElementById('commit').textContent = `@ ${data.generated.commit}`;
  }

  function renderLegend() {
    const ordered = [...zones.keys()].sort((left, right) => {
      const rankLeft = zones[left].rank ?? 99;
      const rankRight = zones[right].rank ?? 99;
      return rankLeft - rankRight || zones[left].id.localeCompare(zones[right].id);
    });
    replaceChildren(
      document.getElementById('legend'),
      ordered.map((index) => {
        const zone = zones[index];
        const rank = zone.rank === null ? 'unranked' : `rank ${zone.rank}`;
        return el(
          'button',
          {
            type: 'button',
            class: 'legend-row',
            'data-zone': index,
            'aria-pressed': String(!state.hiddenZones.has(index)),
          },
          [
            el('span', { class: 'swatch', style: `background:${zoneColor(index)}` }),
            el('span', { class: 'zone' }, [
              document.createTextNode(`${zone.id} `),
              el('i', { text: rank }),
            ]),
            el('span', { class: 'count', text: String(zone.files) }),
          ],
        );
      }),
    );
  }

  function renderHotspots() {
    const top = [...nodes.keys()]
      .sort((left, right) => nodes[right].in - nodes[left].in || nodes[right].out - nodes[left].out)
      .slice(0, 14);
    replaceChildren(
      document.getElementById('hotspots'),
      top.map((index) =>
        el('button', { type: 'button', class: 'hotspot', 'data-focus': index }, [
          el('span', { text: nodes[index].id }),
          el('span', { class: 'metric', text: String(nodes[index].in) }),
        ]),
      ),
    );
  }

  const layoutHint = document.getElementById('layout-hint');
  function renderLayoutHint() {
    layoutHint.textContent =
      state.layout === 'cluster'
        ? 'Force-directed: folders pull together, so tight blobs are cohesive modules and long bridges are cross-module coupling.'
        : 'Layered by depth to a leaf over static value imports: sinks on the left, entrypoints on the right. Every edge should point leftwards.';
  }

  document.getElementById('legend').addEventListener('click', (event) => {
    const row = event.target.closest('[data-zone]');
    if (!row) return;
    const index = Number(row.dataset.zone);
    if (state.hiddenZones.has(index)) state.hiddenZones.delete(index);
    else state.hiddenZones.add(index);
    row.setAttribute('aria-pressed', String(!state.hiddenZones.has(index)));
    schedule();
  });

  document.getElementById('hotspots').addEventListener('click', (event) => {
    const button = event.target.closest('[data-focus]');
    if (button) focusNode(Number(button.dataset.focus));
  });

  function bindSegmented(id, key, onChange) {
    const container = document.getElementById(id);
    container.addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (!button) return;
      const value = button.dataset[key];
      if (!value) return;
      for (const sibling of container.querySelectorAll('button')) {
        sibling.setAttribute('aria-pressed', String(sibling === button));
      }
      onChange(value);
    });
  }

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  bindSegmented('layout-mode', 'layout', (value) => {
    if (value === state.layout) return;
    const previous = state.layout;
    state.layout = value;
    renderLayoutHint();
    if (reduceMotion) {
      fit();
      return;
    }
    const start = performance.now();
    morph = { layout: previous, t: 0 };
    const step = (now) => {
      const progress = Math.min((now - start) / 420, 1);
      morph.t = progress < 0.5 ? 2 * progress * progress : 1 - (-2 * progress + 2) ** 2 / 2;
      draw();
      if (progress < 1) requestAnimationFrame(step);
      else {
        morph = null;
        fit();
      }
    };
    requestAnimationFrame(step);
    // Reframe onto the incoming layout's bounds while the morph plays, so the transition
    // ends framed instead of off-screen.
    fit();
  });

  bindSegmented('size-mode', 'size', (value) => {
    state.size = value;
    schedule();
  });

  for (const [id, key] of [
    ['show-back', 'showBack'],
    ['show-cycles', 'showCycles'],
    ['show-redundant', 'showRedundant'],
    ['show-type-inversion', 'showTypeInversion'],
    ['hide-weak', 'hideWeak'],
    ['show-labels', 'labels'],
  ]) {
    document.getElementById(id).addEventListener('change', (event) => {
      state[key] = event.target.checked;
      schedule();
    });
  }

  const search = document.getElementById('search');
  const searchHint = document.getElementById('search-hint');
  search.addEventListener('input', () => {
    state.query = search.value.trim().toLowerCase();
    const count = state.query === '' ? 0 : nodes.filter((_, index) => matched(index)).length;
    searchHint.textContent =
      state.query === ''
        ? 'Drag to pan, pinch or scroll to zoom, tap a node for detail.'
        : `${count} file${count === 1 ? '' : 's'} match — everything else dims.`;
    schedule();
  });
  search.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    const first = nodes.findIndex((_, index) => matched(index) && visible(index));
    if (first >= 0) focusNode(first);
  });

  document.getElementById('zoom-in').addEventListener('click', () => zoomBy(1.4));
  document.getElementById('zoom-out').addEventListener('click', () => zoomBy(1 / 1.4));
  document.getElementById('zoom-fit').addEventListener('click', () => fit());

  const rail = document.getElementById('rail');
  const railToggle = document.getElementById('rail-toggle');

  // The opener chip would otherwise float over whichever sheet is up.
  function syncToggle() {
    const covered = rail.classList.contains('open') || detail.classList.contains('open');
    railToggle.style.display = covered ? 'none' : '';
  }

  function setRail(open) {
    rail.classList.toggle('open', open);
    railToggle.setAttribute('aria-expanded', String(open));
    syncToggle();
  }

  railToggle.addEventListener('click', () => setRail(true));
  document.getElementById('rail-done').addEventListener('click', () => setRail(false));

  // ---------- pointer input ----------

  const pointers = new Map();
  let dragged = false;
  let pinch = null;

  canvas.addEventListener('pointerdown', (event) => {
    canvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    dragged = false;
    if (pointers.size === 2) {
      const [first, second] = [...pointers.values()];
      pinch = { distance: Math.hypot(first.x - second.x, first.y - second.y) };
    }
    canvas.classList.add('dragging');
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!pointers.has(event.pointerId)) {
      if (event.pointerType === 'mouse') hoverAt(event.clientX, event.clientY);
      return;
    }
    const previous = pointers.get(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointers.size === 2 && pinch) {
      const [first, second] = [...pointers.values()];
      const distance = Math.hypot(first.x - second.x, first.y - second.y);
      const rect = canvas.getBoundingClientRect();
      if (pinch.distance > 0) {
        zoomBy(
          distance / pinch.distance,
          (first.x + second.x) / 2 - rect.left,
          (first.y + second.y) / 2 - rect.top,
        );
      }
      pinch.distance = distance;
      dragged = true;
      return;
    }

    const dx = event.clientX - previous.x;
    const dy = event.clientY - previous.y;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) dragged = true;
    camera.x -= dx / camera.k;
    camera.y -= dy / camera.k;
    schedule();
  });

  function endPointer(event) {
    if (!pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) {
      canvas.classList.remove('dragging');
      if (!dragged) {
        const hit = pick(event.clientX, event.clientY);
        select(hit);
        if (hit !== null && window.innerWidth <= 860) setRail(false);
      }
    }
  }

  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      zoomBy(
        Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0016)),
        event.clientX - rect.left,
        event.clientY - rect.top,
      );
    },
    { passive: false },
  );

  function hoverAt(clientX, clientY) {
    const hit = pick(clientX, clientY);
    if (hit !== state.hover) {
      state.hover = hit;
      schedule();
    }
    if (hit === null) {
      tooltip.style.display = 'none';
      return;
    }
    tooltip.textContent = `src/${nodes[hit].id} · in ${nodes[hit].in} · out ${nodes[hit].out}`;
    tooltip.style.display = 'block';
    const box = tooltip.getBoundingClientRect();
    tooltip.style.left = `${Math.min(clientX + 12, window.innerWidth - box.width - 8)}px`;
    tooltip.style.top = `${Math.max(clientY - box.height - 10, 8)}px`;
  }

  canvas.addEventListener('pointerleave', () => {
    tooltip.style.display = 'none';
    if (state.hover !== null) {
      state.hover = null;
      schedule();
    }
  });

  window.addEventListener('keydown', (event) => {
    if (event.target === search) return;
    if (event.key === 'Escape') select(null);
    if (event.key === '+' || event.key === '=') zoomBy(1.3);
    if (event.key === '-') zoomBy(1 / 1.3);
    if (event.key === 'f') fit();
  });

  window.addEventListener('resize', resize);
  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
  function applyTheme() {
    readPalette();
    computeZoneColors();
    renderLegend();
    schedule();
  }
  darkQuery.addEventListener('change', applyTheme);
  new MutationObserver(applyTheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });

  readPalette();
  computeZoneColors();
  renderStats();
  renderLegend();
  renderHotspots();
  renderLayoutHint();
  resize();
  fit();
})();
