// §2.9 - Graph of links between files (pure, testable logic).
//
// Nodes = library documents; edges = wiki-links `[[Target]]` resolved to an existing
// file. IN-HOUSE force-directed layout (simplified Fruchterman-Reingold) - no
// graph library (d3/cytoscape would blow up the bundle budget). Deterministic:
// initial positions on a circle (indexed), no Math.random - same input ⇒ same
// rendering (testable, and reproducible between openings).

export interface GraphNode {
	id: string;
	label: string;
}
export interface GraphEdge {
	source: string;
	target: string;
}
export interface GraphData {
	nodes: GraphNode[];
	edges: GraphEdge[];
}

/**
 * Builds the graph from the files + the wiki-link resolvers.
 * - `getTargets(id)`: the file's outgoing `[[…]]` targets.
 * - `resolve(target)`: id of the targeted file, or null if not found.
 * Self-loops and duplicate edges are eliminated; only edges between existing
 * nodes are kept.
 */
export function buildGraph(
	files: ReadonlyArray<{ id: string; label: string }>,
	getTargets: (id: string) => string[],
	resolve: (target: string) => string | null
): GraphData {
	const nodes: GraphNode[] = files.map((f) => ({ id: f.id, label: f.label }));
	const ids = new Set(nodes.map((n) => n.id));
	const seen = new Set<string>();
	const edges: GraphEdge[] = [];
	for (const f of files) {
		for (const target of getTargets(f.id)) {
			const toId = resolve(target);
			if (!toId || toId === f.id || !ids.has(toId)) continue;
			// Undirected dedup: a single edge between two nodes.
			const key = f.id < toId ? `${f.id}|${toId}` : `${toId}|${f.id}`;
			if (seen.has(key)) continue;
			seen.add(key);
			edges.push({ source: f.id, target: toId });
		}
	}
	return { nodes, edges };
}

export interface PositionedNode extends GraphNode {
	x: number;
	y: number;
}

export interface LayoutOptions {
	width: number;
	height: number;
	iterations?: number;
}

/**
 * Computes a deterministic force-directed layout. Repulsion between all nodes +
 * attraction along edges, with linear cooling.
 * O(n² × iterations) - bounded by the app's file cap (~hundreds).
 */
function* layoutSteps(
	data: GraphData,
	opts: LayoutOptions
): Generator<PositionedNode[], PositionedNode[]> {
	const { width, height } = opts;
	const n = data.nodes.length;
	if (n === 0) return [];

	const iterations = opts.iterations ?? 120;
	const area = width * height;
	const k = Math.sqrt(area / n); // ideal distance between nodes
	const cx = width / 2;
	const cy = height / 2;

	// Initial positions on a circle (deterministic, well distributed). We keep a
	// strictly positive radius even if k (ideal distance) exceeds the half-
	// dimension on a small dense graph - otherwise the circle would be inverted.
	const radius = Math.max(1, Math.min(width, height) / 2 - k);
	const pos = data.nodes.map((node, i) => {
		const angle = (2 * Math.PI * i) / n;
		return {
			...node,
			x: cx + Math.cos(angle) * radius,
			y: cy + Math.sin(angle) * radius
		};
	});

	const index = new Map(pos.map((p, i) => [p.id, i]));
	let temp = Math.min(width, height) / 10;
	const cool = temp / (iterations + 1);

	for (let it = 0; it < iterations; it++) {
		const disp = pos.map(() => ({ x: 0, y: 0 }));

		// Repulsion (all pairs).
		for (let i = 0; i < n; i++) {
			for (let j = i + 1; j < n; j++) {
				let dx = pos[i]!.x - pos[j]!.x;
				let dy = pos[i]!.y - pos[j]!.y;
				let dist = Math.hypot(dx, dy);
				if (dist < 0.01) {
					// Overlapping nodes: push along a stable axis (index).
					dx = (i - j) * 0.1 + 0.05;
					dy = 0.05;
					dist = Math.hypot(dx, dy);
				}
				const force = (k * k) / dist;
				const fx = (dx / dist) * force;
				const fy = (dy / dist) * force;
				disp[i]!.x += fx;
				disp[i]!.y += fy;
				disp[j]!.x -= fx;
				disp[j]!.y -= fy;
			}
		}

		// Attraction (along the edges).
		for (const e of data.edges) {
			const si = index.get(e.source);
			const ti = index.get(e.target);
			if (si === undefined || ti === undefined) continue;
			const dx = pos[si]!.x - pos[ti]!.x;
			const dy = pos[si]!.y - pos[ti]!.y;
			const dist = Math.hypot(dx, dy) || 0.01;
			const force = (dist * dist) / k;
			const fx = (dx / dist) * force;
			const fy = (dy / dist) * force;
			disp[si]!.x -= fx;
			disp[si]!.y -= fy;
			disp[ti]!.x += fx;
			disp[ti]!.y += fy;
		}

		// Displacement bounded by the temperature + clamp within the frame.
		for (let i = 0; i < n; i++) {
			const d = disp[i]!;
			const len = Math.hypot(d.x, d.y) || 0.01;
			const p = pos[i]!;
			p.x += (d.x / len) * Math.min(len, temp);
			p.y += (d.y / len) * Math.min(len, temp);
			p.x = Math.max(8, Math.min(width - 8, p.x));
			p.y = Math.max(8, Math.min(height - 8, p.y));
		}
		temp -= cool;
		yield pos;
	}

	return pos;
}

export function computeLayout(data: GraphData, opts: LayoutOptions): PositionedNode[] {
	const steps = layoutSteps(data, opts);
	let next = steps.next();
	while (!next.done) next = steps.next();
	return next.value;
}

/** Cooperative fallback: one force iteration per task, never a full UI block. */
export async function computeLayoutAsync(
	data: GraphData,
	opts: LayoutOptions,
	signal?: AbortSignal
): Promise<PositionedNode[]> {
	const steps = layoutSteps(data, opts);
	let next = steps.next();
	while (!next.done) {
		if (signal?.aborted) throw new DOMException('Graph layout cancelled', 'AbortError');
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		if (signal?.aborted) throw new DOMException('Graph layout cancelled', 'AbortError');
		next = steps.next();
	}
	return next.value;
}
