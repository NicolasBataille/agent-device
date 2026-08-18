// Divergence proof harness for the acquire/present snapshot design (#1797, #1832).
//
// This is a MODEL of the design, not the production code path. It transcribes the two
// `-i`/hittable interpretation policies shipped at HEAD (3020195) and the amended
// single-presentation design, then checks the model obligations below. The final verdict is
// deliberately labeled MODEL OBLIGATIONS PASS — not "proven" — because several contracts are
// out of the model's reach (see the coverage table the script prints).
//
// Obligations:
//  P1  — the shipped per-backend policies diverge on IDENTICAL raw input (interpretation-caused).
//  P2  — the single regular projection cannot diverge on identical input; interactive ⊆ raw;
//        the raw projection is unpruned; every daemon-centered hit point lands inside the
//        emitted (effective) rect; the cumulative-clip invariant holds.
//  P2b — fact-availability neutrality (C1): the same tree with and without native hit-test
//        facts yields identical membership and derived fields; evidence is never serialized.
//  P3  — with DELIBERATELY different raw trees, every presented delta is attributable to an
//        owning raw-input delta; interpretation contributes zero unattributed differences.
//
// Membership policy modeled (external review pass 3 finding 3, content definition corrected in
// the verification pass): membership is `interactive-type OR semantic content`, where semantic
// content = non-empty label OR identifier OR value, REGARDLESS of element type — matching the
// shipped tree's definition (Snapshot.swift:883). Labeled images, labeled Other containers, and
// identifier/value-only nodes are all members; decorative means UNLABELED, never a type. The
// ONLY intended membership delta vs the shipped tree policy is dropping the hittable-non-other
// branch (an unlabeled, non-interactive-typed but hittable node). Geometric actionability feeds
// ONLY the emitted `hittable` field, never membership.
//
// Frame emptiness follows CGRect semantics: a rect with EITHER dimension zero is empty, and
// empty-frame nodes take the frameless escape hatch (presentation-visible when they carry
// content, never hittable, never clipping). The random generator emits both zero-frames and
// one-axis-degenerate frames to exercise the hatch accurately.

type Rect = { x: number; y: number; w: number; h: number };
type RawNode = {
  type: string;
  label?: string;
  identifier?: string;
  value?: string;
  frame: Rect;
  sourceHittable?: boolean; // acquired fact; never gates membership; never serialized
  children?: RawNode[];
};

// Shipped-tree content rule (Snapshot.swift:883): any non-empty label, identifier, or value,
// regardless of type. ONE definition, shared by the HEAD model and the after-model.
const hasSemanticContent = (n: RawNode) =>
  Boolean(n.label?.trim() || n.identifier?.trim() || n.value?.trim());

const SCROLL = new Set(['scrollview', 'table', 'collectionview']);
const INTERACTIVE = new Set(['button', 'textfield', 'switch', 'link', 'cell', 'tabbar']);
const f = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });
const intersect = (a: Rect, b: Rect): Rect => {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  return { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1) };
};
const hasArea = (r: Rect) => r.w * r.h > 0;
// CGRect-style emptiness: either zero dimension ⇒ empty ⇒ frameless hatch.
const hasFrame = (r: Rect) => r.w > 0 && r.h > 0;
const inside = (px: number, py: number, r: Rect) =>
  px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
const key = (n: RawNode) =>
  `${n.type}|${n.label ?? ''}|${n.identifier ?? ''}|${n.value ?? ''}|${n.frame.x},${n.frame.y},${n.frame.w},${n.frame.h}`;
const viewport = f(0, 0, 402, 874);

function checkoutScreen(): RawNode {
  const rows: RawNode[] = [];
  for (let i = 0; i < 8; i++) {
    rows.push({ type: 'button', label: `Item row ${i + 1}`, frame: f(16, 180 + i * 62, 300, 56), sourceHittable: true });
    // Genuinely decorative: UNLABELED image (decorative is a labeling fact, not a type).
    rows.push({ type: 'image', frame: f(330, 180 + i * 62, 48, 48) });
    rows.push({ type: 'statictext', label: `$${(i + 1) * 7}.00`, frame: f(16, 180 + i * 62 + 40, 120, 16) });
  }
  return {
    type: 'application', label: 'ShopApp', frame: viewport, children: [
      { type: 'navigationbar', label: 'Checkout', frame: f(0, 59, 402, 44), children: [
        { type: 'button', label: 'Back', frame: f(8, 59, 44, 44), sourceHittable: true },
      ]},
      { type: 'scrollview', label: 'Order summary', identifier: 'checkout-form', frame: f(0, 120, 402, 560), children: [
        { type: 'other', label: 'Your items', frame: f(0, 120, 402, 48) },
        // Meaningful accessibility content that membership MUST keep:
        { type: 'image', label: 'Red sneakers product photo', frame: f(16, 130, 80, 44) },
        { type: 'other', identifier: 'promo-banner', frame: f(110, 130, 180, 44) }, // identifier-only
        { type: 'other', value: '3 items', frame: f(300, 130, 86, 44) }, // value-only
        ...rows,
        // RN/SwiftUI-style frameless semantic wrapper with real content.
        { type: 'other', label: 'a11y wrapper', frame: f(0, 0, 0, 0), children: [
          { type: 'button', label: 'Apply promo', frame: f(16, 620, 200, 40), sourceHittable: true },
        ]},
        // One-axis-degenerate frame (h=0): CGRect-empty ⇒ frameless hatch.
        { type: 'statictext', label: 'Free shipping over $50', frame: f(16, 615, 370, 0) },
        // Partially clipped row: bottom half outside the scroll frame.
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

// ---------- HEAD "before" models (P1) ----------
function visibleAtHead(n: RawNode, scroll: Rect | null): boolean {
  if (!hasFrame(n.frame)) return false;
  return hasArea(intersect(n.frame, viewport)) && (scroll === null || hasArea(intersect(n.frame, scroll)));
}
function headTreeInteractive(root: RawNode): Set<string> {
  const out = new Set<string>();
  const walk = (n: RawNode, scroll: Rect | null) => {
    if (visibleAtHead(n, scroll)) {
      if (INTERACTIVE.has(n.type) || n.sourceHittable === true || hasSemanticContent(n)) out.add(key(n));
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

// ---------- AFTER: one module, two projections ----------
type Presented = {
  key: string;
  hittable: boolean; // geometric actionability, backend-neutral, feeds the FIELD only
  rect: Rect; // EMITTED: effective visible rect (regular) — daemon centers this
  rawFrame: Rect; // INTERNAL: identity/dedup only
  hitPoint: { x: number; y: number };
};

function presentRegular(root: RawNode): { nodes: Presented[]; hints: string[]; invariantViolations: number } {
  const nodes: Presented[] = [];
  const hints: string[] = [];
  let invariantViolations = 0;
  const walk = (n: RawNode, clip: Rect, anchor: { label: string; rect: Rect } | null) => {
    const frameless = !hasFrame(n.frame); // covers zero AND one-axis-degenerate frames
    const eff = intersect(n.frame, clip);
    const visible = frameless || hasArea(eff);
    const interactive = INTERACTIVE.has(n.type);
    // Membership: interactive-type OR semantic content (label/identifier/value, type-agnostic).
    // Geometry feeds only the hittable field.
    const include = visible && (interactive || hasSemanticContent(n));
    const hittable = !frameless && hasArea(eff) && interactive;
    if (include) {
      if (!frameless && !hasArea(eff)) invariantViolations++;
      const emittedRect = frameless ? n.frame : eff;
      nodes.push({
        key: key(n),
        hittable,
        rect: emittedRect,
        rawFrame: n.frame,
        hitPoint: { x: emittedRect.x + emittedRect.w / 2, y: emittedRect.y + emittedRect.h / 2 },
      });
    } else if (!visible && !frameless && hasSemanticContent(n) && anchor && hasArea(intersect(n.frame, viewport))) {
      hints.push(`[${n.frame.y < anchor.rect.y ? 'above' : 'below'} ${anchor.label}] ${n.label ?? n.identifier ?? n.value}`);
    }
    const isScroll = SCROLL.has(n.type) && hasFrame(n.frame);
    const childClip = isScroll ? intersect(clip, n.frame) : clip;
    const childAnchor = isScroll ? { label: n.label ?? n.type, rect: n.frame } : anchor;
    (n.children ?? []).forEach((c) => walk(c, childClip, childAnchor));
  };
  walk(root, viewport, null);
  return { nodes, hints, invariantViolations };
}

function presentRaw(root: RawNode): Set<string> {
  const out = new Set<string>();
  const walk = (n: RawNode) => { out.add(key(n)); (n.children ?? []).forEach(walk); };
  walk(root);
  return out;
}

const setOf = (r: { nodes: Presented[] }) => new Set(r.nodes.map((n) => n.key));
const symDiff = (a: Set<string>, b: Set<string>) =>
  [...a].filter((k) => !b.has(k)).concat([...b].filter((k) => !a.has(k)));
const subset = (a: Set<string>, b: Set<string>) => [...a].every((k) => b.has(k));
const rawKeys = (r: RawNode): Set<string> => {
  const s = new Set<string>();
  const w = (n: RawNode) => { s.add(key(n)); (n.children ?? []).forEach(w); };
  w(r);
  return s;
};

// ---------- P1 ----------
const sample = checkoutScreen();
const t = headTreeInteractive(sample);
const x = headPrivateAxInteractive(sample);
const p1Divergent = symDiff(t, x);
console.log(`P1 BEFORE (HEAD): tree ${t.size} vs privateAX ${x.size} nodes, divergent: ${p1Divergent.length}`);

// ---------- P2 ----------
const a1 = presentRegular(sample);
const a2 = presentRegular(sample);
const p2SelfDiv = symDiff(setOf(a1), setOf(a2)).length;
const p2Subset = subset(setOf(a1), presentRaw(sample));
const gift = a1.nodes.find((n) => n.key.includes('Gift wrap'))!;
const degenerate = a1.nodes.find((n) => n.key.includes('Free shipping'))!;
const labeledImage = a1.nodes.some((n) => n.key.includes('Red sneakers product photo'));
const identifierOnly = a1.nodes.some((n) => n.key.includes('promo-banner'));
const valueOnly = a1.nodes.some((n) => n.key.includes('3 items'));
const unlabeledThumbInRegular = a1.nodes.some((n) => n.key.startsWith('image|||'));
const unlabeledThumbInRaw = [...presentRaw(sample)].some((k) => k.startsWith('image|||'));
const p2HitPoints = a1.nodes.every((n) => inside(n.hitPoint.x, n.hitPoint.y, n.rect));
console.log(`\nP2 AFTER: self-divergence ${p2SelfDiv}, invariant violations ${a1.invariantViolations}`);
console.log(`  interactive ⊆ raw: ${p2Subset}; raw unpruned: ${presentRaw(sample).size} raw vs ${a1.nodes.length} regular`);
console.log(`  clipped 'Gift wrap': rawFrame h=${gift.rawFrame.h}, emitted rect h=${gift.rect.h}, centered hitPoint y=${gift.hitPoint.y} (raw midpoint ${gift.rawFrame.y + gift.rawFrame.h / 2})`);
console.log(`  degenerate-frame (h=0) content node: visible=${degenerate !== undefined}, hittable=${degenerate?.hittable} (frameless hatch, CGRect emptiness)`);
console.log(`  every centered hit point inside emitted rect: ${p2HitPoints}; evidence on wire: ${a1.nodes.some((n) => 'hitTestEvidence' in n) ? 'YES (BUG)' : 'none'}`);
console.log(`  content rule (type-agnostic): labeled image kept=${labeledImage}, identifier-only kept=${identifierOnly}, value-only kept=${valueOnly}`);
console.log(`  unlabeled decorative image: regular=${unlabeledThumbInRegular} (dropped), raw=${unlabeledThumbInRaw} (kept)`);

// ---------- P2b: fact-availability neutrality (C1) ----------
const stripped = structuredClone(sample);
const strip = (n: RawNode) => { delete n.sourceHittable; (n.children ?? []).forEach(strip); };
strip(stripped);
const withFacts = presentRegular(sample);
const withoutFacts = presentRegular(stripped);
const p2bMembership = symDiff(setOf(withFacts), setOf(withoutFacts)).length;
const p2bFields = withFacts.nodes.filter((n) => {
  const m = withoutFacts.nodes.find((q) => q.key === n.key);
  return m && m.hittable !== n.hittable;
}).length;
console.log(`\nP2b neutrality (± sourceHittable facts): membership delta ${p2bMembership}, field delta ${p2bFields}`);

// ---------- P3: attribution of presented deltas to raw-input deltas ----------
// Two DELIBERATELY different raw trees for the same screen:
//  - axRaw additionally reports a merged-card leaf the tree source lacks;
//  - treeRaw additionally reports the nav 'Back' button the AX source missed;
//  - axRaw lacks every sourceHittable fact (availability asymmetry).
const treeRaw = structuredClone(sample);
const axRaw = structuredClone(sample);
strip(axRaw);
axRaw.children!.find((c) => c.type === 'scrollview')!.children!.push({
  type: 'button', label: 'Merged card CTA', frame: f(16, 240, 370, 40),
});
const nav = axRaw.children!.find((c) => c.type === 'navigationbar')!;
nav.children = nav.children!.filter((c) => c.label !== 'Back');

const pTree = presentRegular(treeRaw);
const pAx = presentRegular(axRaw);
const rawDelta = new Set(symDiff(rawKeys(treeRaw), rawKeys(axRaw)));
const presentedDelta = symDiff(setOf(pTree), setOf(pAx));
const unattributed = presentedDelta.filter((k) => !rawDelta.has(k));
const sharedFieldDeltas = pTree.nodes.filter((n) => {
  const m = pAx.nodes.find((q) => q.key === n.key);
  return m && (m.hittable !== n.hittable || JSON.stringify(m.rect) !== JSON.stringify(n.rect));
}).length;
console.log(`\nP3 attribution (deliberately different raw trees):`);
console.log(`  raw deltas: ${rawDelta.size}, presented deltas: ${presentedDelta.length}, unattributed: ${unattributed.length}`);
console.log(`  field deltas on shared nodes: ${sharedFieldDeltas} (must be 0 — availability cannot alter fields)`);
console.log(`  => ${unattributed.length === 0 && sharedFieldDeltas === 0 ? 'every presented delta has an owning raw delta; interpretation contributes zero' : 'ATTRIBUTION FAILED'}`);

// ---------- randomized ----------
let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const randFrame = (): Rect => {
  const roll = rnd();
  if (roll < 0.05) return f(0, 0, 0, 0); // zero-frame
  if (roll < 0.09) return f(rnd() * 400, rnd() * 800, rnd() * 300, 0); // h-degenerate
  if (roll < 0.13) return f(rnd() * 400, rnd() * 800, 0, rnd() * 300); // w-degenerate
  return f(rnd() * 500 - 50, rnd() * 900 - 50, rnd() * 400, rnd() * 400);
};
const randTree = (d: number): RawNode => ({
  type: rnd() < 0.2 ? 'scrollview' : rnd() < 0.45 ? 'button' : rnd() < 0.6 ? 'image' : 'statictext',
  label: rnd() < 0.6 ? `n${Math.floor(rnd() * 1e6)}` : undefined,
  identifier: rnd() < 0.25 ? `id${Math.floor(rnd() * 1e6)}` : undefined,
  value: rnd() < 0.15 ? `v${Math.floor(rnd() * 1e6)}` : undefined,
  frame: randFrame(),
  sourceHittable: rnd() < 0.3 ? rnd() < 0.5 : undefined,
  children: d > 0 ? Array.from({ length: Math.floor(rnd() * 4) }, () => randTree(d - 1)) : [],
});
let rSelf = 0, rFact = 0, rInv = 0, rSubset = 0, rHit = 0, rUnattr = 0;
for (let i = 0; i < 1000; i++) {
  const tree: RawNode = { type: 'application', frame: viewport, children: [randTree(4)] };
  const s = structuredClone(tree); strip(s);
  const p = presentRegular(tree);
  if (symDiff(setOf(p), setOf(presentRegular(tree))).length > 0) rSelf++;
  if (symDiff(setOf(p), setOf(presentRegular(s))).length > 0) rFact++;
  rInv += p.invariantViolations;
  if (!subset(setOf(p), presentRaw(tree))) rSubset++;
  if (!p.nodes.every((n) => inside(n.hitPoint.x, n.hitPoint.y, n.rect))) rHit++;
  // randomized P3: mutate a clone by adding + removing one labeled node, then attribute.
  const m = structuredClone(tree);
  const first = m.children![0];
  if (first) {
    (first.children ??= []).push({ type: 'button', label: `mut${i}`, frame: f(10, 10, 50, 50) });
    if (first.children.length > 1) first.children.splice(0, 1);
  }
  const rd = new Set(symDiff(rawKeys(tree), rawKeys(m)));
  const pd = symDiff(setOf(presentRegular(tree)), setOf(presentRegular(m)));
  rUnattr += pd.filter((k) => !rd.has(k)).length;
}
console.log(`\nrandomized (1000 trees incl. degenerate frames): self-div ${rSelf}, fact-availability div ${rFact}, invariant ${rInv}, interactive⊆raw fails ${rSubset}, hit-point fails ${rHit}, unattributed P3 deltas ${rUnattr}`);

// ---------- coverage table ----------
console.log(`
CONTRACT COVERAGE OF THIS MODEL
  C1 fact-availability neutrality  exercised (P2b, randomized) — membership + fields
  C3 two projections               exercised (interactive ⊆ raw; raw unpruned)
  C4 geometry carrier              exercised, weakly — hit-point containment follows from
                                   centering the emitted rect; the real check is the daemon
                                   consuming it (migration step 3)
  C6 clip invariant                exercised, weakly — checked by the same function that
                                   established visibility; the real check is the independent
                                   choke-point assert (migration step 4)
  P3 attribution                   exercised (fixture pair + randomized single-node mutations)
  C2 hint conservatism             NOT modeled (adapter completeness needs real adapters)
  C5 deadline / whole-tier discard NOT modeled (needs the capture-plan loop)
  self-divergence                  trivially true for a pure function; kept as a regression
                                   tripwire for accidental statefulness, not as evidence`);

const pass =
  p1Divergent.length > 0 && p2SelfDiv === 0 && a1.invariantViolations === 0 && p2Subset && p2HitPoints &&
  labeledImage && identifierOnly && valueOnly && !unlabeledThumbInRegular && unlabeledThumbInRaw &&
  degenerate !== undefined && degenerate.hittable === false &&
  p2bMembership === 0 && p2bFields === 0 &&
  unattributed.length === 0 && sharedFieldDeltas === 0 &&
  rSelf === 0 && rFact === 0 && rInv === 0 && rSubset === 0 && rHit === 0 && rUnattr === 0;
console.log(`\nVERDICT: ${pass ? 'MODEL OBLIGATIONS PASS' : 'MODEL OBLIGATIONS FAIL'}`);
