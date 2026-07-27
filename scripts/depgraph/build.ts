// Dependency graph generator — emits a single self-contained HTML file.
//
//   node --experimental-strip-types scripts/depgraph/build.ts [--out <path>]
//
// The output has no external requests of any kind: data, styles, and viewer script are
// inlined, so it works from `file://`, from a static host, or inside a sandboxed page.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { listSourceFiles } from '../layering/check.ts';
import { resolveImportEdges, zoneRank } from '../layering/model.ts';
import { clusterLayout, computeLevels, layeredLayout } from './layout.ts';
import { buildGraph, type GraphData } from './model.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();

/** Compact wire form. Nodes and edges are index-addressed to keep the payload small. */
type Payload = {
  generated: { commit: string; files: number; edges: number };
  zones: { id: string; rank: number | null; classification: string; files: number; loc: number }[];
  zoneEdges: GraphData['zoneEdges'];
  nodes: {
    id: string;
    z: number;
    loc: number;
    in: number;
    out: number;
    lvl: number;
    cyc: number;
    cx: number;
    cy: number;
    lx: number;
    ly: number;
  }[];
  /**
   * `[fromIndex, toIndex, kind, flags]`; kind 0=value 1=type 2=dynamic,
   * flags bit0=R5 back-edge, bit1=transitively redundant, bit2=R6 type inversion.
   */
  edges: [number, number, number, number][];
  cycles: { kind: string; path: number[] }[];
};

function headCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown';
  }
}

export function buildPayload(): Payload {
  const files = listSourceFiles();
  const sources = new Map(
    files.map((file) => [file, fs.readFileSync(path.join(repoRoot, file), 'utf8')]),
  );
  const resolved = resolveImportEdges(sources);
  const graph = buildGraph(sources, resolved);
  const levels = computeLevels(graph.nodes, graph.edges);
  const cluster = clusterLayout(graph);
  const layered = layeredLayout(graph, levels);

  const zoneIndex = new Map(graph.zones.map((zone, index) => [zone.id, index]));
  const nodeIndex = new Map(graph.nodes.map((node, index) => [node.id, index]));
  const round = (value: number): number => Math.round(value * 10) / 10;

  return {
    generated: { commit: headCommit(), files: graph.nodes.length, edges: graph.edges.length },
    zones: graph.zones.map((zone) => ({ ...zone, rank: zoneRank(zone.id) })),
    zoneEdges: graph.zoneEdges,
    nodes: graph.nodes.map((node) => ({
      id: node.id.replace(/^src\//, ''),
      z: zoneIndex.get(node.zone)!,
      loc: node.loc,
      in: node.fanIn,
      out: node.fanOut,
      lvl: levels.get(node.id) ?? 0,
      cyc: node.cycle,
      cx: round(cluster.get(node.id)!.x),
      cy: round(cluster.get(node.id)!.y),
      lx: round(layered.get(node.id)!.x),
      ly: round(layered.get(node.id)!.y),
    })),
    edges: graph.edges.map((edge) => [
      nodeIndex.get(edge.from)!,
      nodeIndex.get(edge.to)!,
      edge.kind === 'value' ? 0 : edge.kind === 'type' ? 1 : 2,
      (edge.backEdge ? 1 : 0) | (edge.redundant ? 2 : 0) | (edge.typeInversion ? 4 : 0),
    ]),
    cycles: graph.cycles.map((cycle) => ({
      kind: cycle.kind,
      path: cycle.path.map((file) => nodeIndex.get(file)!),
    })),
  };
}

function renderHtml(payload: Payload): string {
  const template = fs.readFileSync(path.join(here, 'viewer.html'), 'utf8');
  const script = fs.readFileSync(path.join(here, 'viewer.js'), 'utf8');
  const styles = fs.readFileSync(path.join(here, 'viewer.css'), 'utf8');
  // `</script>` inside JSON would close the inline tag early; `<!--` would open a comment.
  const data = JSON.stringify(payload)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return template
    .replace('/*__STYLES__*/', () => styles)
    .replace('"__DATA__"', () => data)
    .replace('/*__SCRIPT__*/', () => script);
}

export function main(argv: readonly string[]): number {
  const outFlag = argv.indexOf('--out');
  const outPath =
    outFlag >= 0 && argv[outFlag + 1]
      ? path.resolve(argv[outFlag + 1]!)
      : path.join(repoRoot, '.tmp/depgraph/index.html');

  const payload = buildPayload();
  const html = renderHtml(payload);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html);

  const jsonPath = outPath.replace(/\.html$/, '.json');
  fs.writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`);

  const valueCycles = payload.cycles.filter((cycle) => cycle.kind === 'value').length;
  const otherCycles = payload.cycles.length - valueCycles;
  const backEdges = payload.edges.filter(([, , , flags]) => flags & 1).length;
  const redundant = payload.edges.filter(([, , , flags]) => flags & 2).length;
  const typeInversions = payload.edges.filter(([, , , flags]) => flags & 4).length;
  process.stdout.write(
    `Dependency graph: ${payload.generated.files} files, ${payload.generated.edges} edges, ` +
      `${payload.zones.length} zones\n` +
      `  value-import cycles (R4): ${valueCycles}\n` +
      `  type-only/dynamic cycles (not gate-rejected): ${otherCycles}\n` +
      `  spine back-edges (R5): ${backEdges}\n` +
      `  type-only spine inversions (R6): ${typeInversions}\n` +
      `  transitively redundant value edges: ${redundant}\n` +
      `  wrote ${path.relative(repoRoot, outPath)} and ${path.relative(repoRoot, jsonPath)}\n`,
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main(process.argv.slice(2)));
}
