export interface InkPoint {
	x: number;
	y: number;
}

export interface InkStroke {
	order: number;
	tool: 'pen' | 'highlighter' | 'eraser';
	color: string;
	size: number;
	points: InkPoint[];
	left: number;
	top: number;
	right: number;
	bottom: number;
	firstBand: number;
	lastBand: number;
	wide: boolean;
}

const BAND_HEIGHT = 1024;
const MAX_STROKE_BANDS = 64;

export function strokeWidth(stroke: InkStroke): number {
	return stroke.size * (stroke.tool === 'highlighter' ? 4 : stroke.tool === 'eraser' ? 5 : 1);
}

// Canvas frames consume this cache. It does not drive reactive DOM state.
export class ReadInkIndex {
	private bands = new Map<number, Set<InkStroke>>();
	private wide = new Set<InkStroke>();

	update(stroke: InkStroke, point: InkPoint): void {
		const radius = strokeWidth(stroke) / 2 + 1;
		stroke.left = Math.min(stroke.left, point.x - radius);
		stroke.top = Math.min(stroke.top, point.y - radius);
		stroke.right = Math.max(stroke.right, point.x + radius);
		stroke.bottom = Math.max(stroke.bottom, point.y + radius);
		if (stroke.wide) return;
		const first = Math.floor(stroke.top / BAND_HEIGHT);
		const last = Math.floor(stroke.bottom / BAND_HEIGHT);
		// Captured input can cross a large scroll jump. Bound index entries per stroke.
		if (last - first + 1 > MAX_STROKE_BANDS) {
			for (let band = stroke.firstBand; band <= stroke.lastBand; band++) {
				const entries = this.bands.get(band);
				entries?.delete(stroke);
				if (entries?.size === 0) this.bands.delete(band);
			}
			stroke.wide = true;
			this.wide.add(stroke);
			return;
		}
		for (let band = first; band <= last; band++) {
			if (band >= stroke.firstBand && band <= stroke.lastBand) continue;
			let entries = this.bands.get(band);
			if (!entries) this.bands.set(band, (entries = new Set()));
			entries.add(stroke);
		}
		stroke.firstBand = first;
		stroke.lastBand = last;
	}

	visible(top: number, height: number): InkStroke[] {
		const visible = new Set(this.wide);
		for (
			let band = Math.floor(top / BAND_HEIGHT);
			band <= Math.floor((top + height) / BAND_HEIGHT);
			band++
		) {
			for (const stroke of this.bands.get(band) ?? []) visible.add(stroke);
		}
		return [...visible].sort((a, b) => a.order - b.order);
	}

	clear(): void {
		this.bands.clear();
		this.wide.clear();
	}
}
