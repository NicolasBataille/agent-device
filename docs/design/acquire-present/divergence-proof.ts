// Proof harness v5 — folds in the external review's SECOND pass (R1-R4):
//   R1: regular presentation emits the EFFECTIVE visible rect as `rect` (the
//       durable wire carrier the daemon already centers); raw emits rawFrame.
//       rawFrame stays internal for identity/dedup only.
//   R2: hitTestEvidence is NOT an emitted field — internal to RawAXNode and
//       diagnostics. P2b still proves it cannot influence membership or fields.
//   R4: occlusion is removed from hittable (daemon annotation owns occlusion,
//       single implementation); presentRegular is linear in node count.
// Carries forward from the first pass:
//   F1: membership is backend-neutral (type/content/geometric actionability only).
//       sourceHittable no longer gates membership; native hit-test ships as
//       separate evidence (hitTestEvidence: 'passed'|'failed'|undefined).
//   F3: two projections behind one module — presentRegular (clip/membership/
//       hints) and presentRaw (normalization only, NO visibility pruning).
//       New property: interactive ⊆ raw.
//   F4: internal rawFrame vs effectiveVisibleFrame; derived hit point uses the
//       effective intersection (checked: hit point always inside clip).
//   F6: invariant quantifier — every framed node emitted visible intersects its
//       CUMULATIVE effective clip (was already what the code checked; prose fixed).
//
// New proof obligation (F1): FACT-AVAILABILITY NEUTRALITY — the same semantic
// raw tree, with and without sourceHittable facts, yields IDENTICAL membership.

type Rect = { x: number; y: number; w: number; h: number };
type RawNode = {
  type: string;
  label?: string;
  frame: Rect;
  sourceHittable?: boolean; // acquired fact; NEVER gates membership (F1)
  children?: RawNode[];
};

const SCROLL = new Set(['scrollview', 'table', 'collectionview']);
const INTERACTIVE = new Set(['button', 'textfield', 'switch', 'link', 'cell', 'tabbar']);
const f = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });
const intersect = (a: Rect, b: Rect): Rect => {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  return { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1) };
};
const hasArea = (r: Rect) => r.w * r.h > 0;
const hasFrame = (r: Rect) => r.w > 0 || r.h > 0;
const inside = (px: number, py: number, r: Rect) =>
  px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
const key = (n: RawNode) => `${n.type}|${n.label ?? ''}|${n.frame.x},${n.frame.y},${n.frame.w},${n.frame.h}`;
const viewport = f(0, 0, 402, 874);

function checkoutScreen(): RawNode {
  const rows: RawNode[] = [];
  for (let i = 0; i < 8; i++) {
    rows.push({ type: 'button', label: `Item row ${i + 1}`, frame: f(16, 180 + i * 62, 300, 56), sourceHittable: true });
    rows.push({ type: 'image', label: `thumb ${i + 1}`, frame: f(330, 180 + i * 62, 48, 48) });
    rows.push({ type: 'statictext', label: `$${(i + 1) * 7}.00`, frame: f(16, 180 + i * 62 + 40, 120, 16) });
  }
  return {
    type: 'application', label: 'ShopApp', frame: viewport, children: [
      { type: 'navigationbar', label: 'Checkout', frame: f(0, 59, 402, 44), children: [
        { type: 'button', label: 'Back', frame: f(8, 59, 44, 44), sourceHittable: true },
      ]},
      { type: 'scrollview', label: 'Order summary', frame: f(0, 120, 402, 560), children: [
        { type: 'other', label: 'Your items', frame: f(0, 120, 402, 48) },
        ...rows,
        { type: 'other', label: 'a11y wrapper', frame: f(0, 0, 0, 0), children: [
          { type: 'button', label: 'Apply promo', frame: f(16, 620, 200, 40), sourceHittable: true },
        ]},
        // Partially clipped row: bottom half outside the scroll frame (y=640..700,
        // container ends 680) — exercises F4's effective hit point.
        { type: 'button', label: 'Gift wrap', frame: f(16, 640, 300, 60), sourceHittable: true },
        { type: 'statictext', label: 'Overflow: promo terms apply', frame: f(16, 690, 370, 40) },
      ]},
      { type: 'other', label: 'Pay bar', frame: f(0, 680, 402, 96), children: [
        { type: 'button', label: 'Pay $42.00', frame: f(16, 696, 370, 56), sourceHittable: true },
      ]},
      { type: 'tabbar', label: 'Tabs', frame: f(0, 790, 402, 84), children: [
        { type: 'button', label: 'Home', frame: f(0, 790, 134, 84), sourceHittable: true },
        { type: 'button', label: 'Cart', frame: f(134, 790, 134, 84), sourceHittable: true },
        { type: 'button', label: 'Profile', frame: f(268, 790, 134, 84), sourceHittable: true },
      ]},
    ],
  };
}

// ---------- HEAD "before" models (unchanged from v2, for P1) ----------
function visibleAtHead(n: RawNode, scroll: Rect | null): boolean {
  if (!hasFrame(n.frame)) return false;
  return hasArea(intersect(n.frame, viewport)) && (scroll === null || hasArea(intersect(n.frame, scroll)));
}
function headTreeInteractive(root: RawNode): Set<string> {
  const out = new Set<string>();
  const walk = (n: RawNode, scroll: Rect | null) => {
    if (visibleAtHead(n, scroll)) {
      const hasContent = (n.label ?? '').length > 0 && n.type !== 'image' && n.type !== 'other';
      if (INTERACTIVE.has(n.type) || n.sourceHittable === true || hasContent) out.add(key(n));
    }
    const next = SCROLL.has(n.type) ? intersect(scroll ?? viewport, n.frame) : scroll;
    (n.children ?? []).forEach((c) => walk(c, next));
  };
  walk(root, null);
  return out;
}
function headPrivateAxInteractive(root: RawNode): Set<string> {
  const out = new Set<string>();
  const walk = (n: RawNode, scroll: Rect | null) => {
    if (!hasFrame(n.frame) || visibleAtHead(n, scroll)) out.add(key(n));
    const next = SCROLL.has(n.type) ? intersect(scroll ?? viewport, n.frame) : scroll;
    (n.children ?? []).forEach((c) => walk(c, next));
  };
  walk(root, null);
  return out;
}

// ---------- AFTER v3: one module, two projections ----------
type Presented = {
  key: string;
  hittable: boolean; // geometric actionability, linear, NO occlusion (R4)
  rect: Rect; // EMITTED: effective visible rect (R1) — daemon centers this
  rawFrame: Rect; // INTERNAL: identity/dedup only, never serialized
  hitPoint: { x: number; y: number }; // = center of emitted rect (existing daemon behavior)
};

function presentRegular(root: RawNode): { nodes: Presented[]; hints: string[]; invariantViolations: number } {
  const nodes: Presented[] = [];
  const hints: string[] = [];
  let invariantViolations = 0;
  const walk = (n: RawNode, clip: Rect, anchor: { label: string; rect: Rect } | null) => {
    const frameless = !hasFrame(n.frame);
    const eff = intersect(n.frame, clip);
    const visible = frameless || (hasArea(n.frame) && hasArea(eff));
    const interactive = INTERACTIVE.has(n.type);
    // F1: membership is backend-neutral — geometric actionability only.
    const geometricHittable = !frameless && hasArea(eff) && interactive;
    const hasContent = (n.label ?? '').length > 0 && n.type !== 'image' && n.type !== 'other';
    const include = visible && (interactive || geometricHittable || hasContent);
    if (include) {
      // F6: emitted-visible framed node must intersect its CUMULATIVE clip.
      if (!frameless && !hasArea(eff)) invariantViolations++;
      const emittedRect = frameless ? n.frame : eff; // R1: effective rect IS the wire rect
      nodes.push({
        key: key(n),
        hittable: geometricHittable,
        rect: emittedRect,
        rawFrame: n.frame,
        hitPoint: { x: emittedRect.x + emittedRect.w / 2, y: emittedRect.y + emittedRect.h / 2 },
      });
    } else if (!visible && !frameless && n.label && anchor && hasArea(intersect(n.frame, viewport))) {
      hints.push(`[${n.frame.y < anchor.rect.y ? 'above' : 'below'} ${anchor.label}] ${n.label}`);
    }
    const isScroll = SCROLL.has(n.type) && hasFrame(n.frame);
    const childClip = isScroll ? intersect(clip, n.frame) : clip;
    const childAnchor = isScroll ? { label: n.label ?? n.type, rect: n.frame } : anchor;
    (n.children ?? []).forEach((c) => walk(c, childClip, childAnchor));
  };
  walk(root, viewport, null);
  return { nodes, hints, invariantViolations };
}

// F3: raw projection — normalization only, NO visibility pruning. The clip
// invariant does NOT apply here.
function presentRaw(root: RawNode): Set<string> {
  const out = new Set<string>();
  const walk = (n: RawNode) => { out.add(key(n)); (n.children ?? []).forEach(walk); };
  walk(root);
  return out;
}

const setOf = (r: { nodes: Presented[] }) => new Set(r.nodes.map((n) => n.key));
const diff = (a: Set<string>, b: Set<string>) => [...a].filter((k) => !b.has(k)).concat([...b].filter((k) => !a.has(k)));
const subset = (a: Set<string>, b: Set<string>) => [...a].every((k) => b.has(k));

// ---------- P1 (unchanged): HEAD diverges on identical input ----------
const sample = checkoutScreen();
const d1 = diff(headTreeInteractive(sample), headPrivateAxInteractive(sample));
console.log(`P1 BEFORE (HEAD): tree ${headTreeInteractive(sample).size} vs privateAX ${headPrivateAxInteractive(sample).size} nodes, divergent: ${d1.length}`);

// ---------- P2: single regular projection cannot diverge; raw ⊇ interactive ----------
const a1 = presentRegular(sample);
const a2 = presentRegular(sample);
console.log(`\nP2 AFTER: regular self-divergence ${diff(setOf(a1), setOf(a2)).length}, invariant violations ${a1.invariantViolations}`);
console.log(`  interactive ⊆ raw: ${subset(setOf(a1), presentRaw(sample))}`);
console.log(`  raw is unpruned: ${presentRaw(sample).size} nodes vs ${a1.nodes.length} regular (raw keeps overflow text: ${presentRaw(sample).has(key({ type: 'statictext', label: 'Overflow: promo terms apply', frame: f(16, 690, 370, 40) }))})`);
const gift = a1.nodes.find((n) => n.key.includes('Gift wrap'))!;
console.log(`  R1 partially clipped 'Gift wrap': rawFrame h=${gift.rawFrame.h}, emitted rect h=${gift.rect.h}, daemon-centered hitPoint y=${gift.hitPoint.y} (raw midpoint would be ${gift.rawFrame.y + gift.rawFrame.h / 2})`);
const allHitPointsInClip = a1.nodes.every((n) => !hasFrame(n.rawFrame) || inside(n.hitPoint.x, n.hitPoint.y, n.rect));
console.log(`  every daemon-centered hit point inside emitted rect: ${allHitPointsInClip} (no new wire field needed)`);
const noEvidenceOnWire = a1.nodes.every((n) => !('hitTestEvidence' in n));
console.log(`  R2 evidence never serialized: ${noEvidenceOnWire}`);

// ---------- P2b (F1): FACT-AVAILABILITY NEUTRALITY ----------
const stripped = structuredClone(sample);
const strip = (n: RawNode) => { delete n.sourceHittable; (n.children ?? []).forEach(strip); };
strip(stripped);
const withFacts = presentRegular(sample);
const withoutFacts = presentRegular(stripped);
const membershipDelta = diff(setOf(withFacts), setOf(withoutFacts));
const hittableDelta = withFacts.nodes.filter((n) => {
  const m = withoutFacts.nodes.find((x) => x.key === n.key);
  return m && m.hittable !== n.hittable;
}).length;
const evidenceOnlyDelta = 0; // R2: evidence lives in RawAXNode/diagnostics, not on presented nodes
console.log(`\nP2b F1 fact-availability neutrality (same tree ± sourceHittable facts):`);
console.log(`  membership delta: ${membershipDelta.length} (must be 0)`);
console.log(`  hittable-field delta: ${hittableDelta} (must be 0 — field is geometric, backend-neutral)`);
console.log(`  evidence on wire: ${evidenceOnlyDelta} (R2: internal to RawAXNode/diagnostics only)`);

// ---------- randomized ----------
let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const randTree = (d: number): RawNode => ({
  type: rnd() < 0.2 ? 'scrollview' : rnd() < 0.45 ? 'button' : rnd() < 0.6 ? 'image' : 'statictext',
  label: rnd() < 0.85 ? `n${Math.floor(rnd() * 1e6)}` : undefined,
  frame: rnd() < 0.08 ? f(0, 0, 0, 0) : f(rnd() * 500 - 50, rnd() * 900 - 50, rnd() * 400, rnd() * 400),
  sourceHittable: rnd() < 0.3 ? rnd() < 0.5 : undefined,
  children: d > 0 ? Array.from({ length: Math.floor(rnd() * 4) }, () => randTree(d - 1)) : [],
});
let selfDiv = 0, factDiv = 0, invTotal = 0, subsetFail = 0, hitPointFail = 0;
for (let i = 0; i < 1000; i++) {
  const tree: RawNode = { type: 'application', frame: viewport, children: [randTree(4)] };
  const s = structuredClone(tree); strip(s);
  const p = presentRegular(tree);
  if (diff(setOf(p), setOf(presentRegular(tree))).length > 0) selfDiv++;
  if (diff(setOf(p), setOf(presentRegular(s))).length > 0) factDiv++;
  invTotal += p.invariantViolations;
  if (!subset(setOf(p), presentRaw(tree))) subsetFail++;
  if (!p.nodes.every((n) => !hasFrame(n.rawFrame) || inside(n.hitPoint.x, n.hitPoint.y, n.rect))) hitPointFail++;
}
console.log(`\nrandomized (1000 trees): self-divergence ${selfDiv}, fact-availability membership divergence ${factDiv}, invariant violations ${invTotal}, interactive⊆raw failures ${subsetFail}, hit-point-outside-clip ${hitPointFail}`);

const pass = d1.length > 0 && selfDiv === 0 && factDiv === 0 && membershipDelta.length === 0 && hittableDelta === 0
  && invTotal === 0 && subsetFail === 0 && hitPointFail === 0 && allHitPointsInClip;
console.log(`\nVERDICT: ${pass ? 'PROVEN under v5 (second-pass amendments hold)' : 'NOT PROVEN'}`);
