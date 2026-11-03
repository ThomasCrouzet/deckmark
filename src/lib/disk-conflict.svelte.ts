export type DiskConflictResolution = 'overwrite' | 'reload' | 'cancel';

export interface DiskConflictRequest {
	/** Draft that triggered the conflict, when known. */
	fileId?: string | undefined;
	name: string;
	localContent: string;
	diskContent: string;
}

interface PendingDiskConflict extends DiskConflictRequest {
	id: number;
}

interface QueuedDiskConflict {
	request: PendingDiskConflict;
	resolve: (resolution: DiskConflictResolution) => void;
}

class DiskConflictStore {
	pending = $state<PendingDiskConflict | null>(null);
	private active: QueuedDiskConflict | null = null;
	private queue: QueuedDiskConflict[] = [];
	private nextId = 0;

	resolve(input: DiskConflictRequest): Promise<DiskConflictResolution> {
		const request = Object.freeze({
			id: ++this.nextId,
			fileId: input.fileId,
			name: String(input.name),
			localContent: String(input.localContent),
			diskContent: String(input.diskContent)
		});
		return new Promise((resolve) => {
			this.queue.push({ request, resolve });
			this.showNext();
		});
	}

	choose(resolution: DiskConflictResolution): void {
		const active = this.active;
		if (!active || active.request.id !== this.pending?.id) return;
		this.active = null;
		this.pending = null;
		active.resolve(resolution);
		queueMicrotask(() => this.showNext());
	}

	private showNext(): void {
		if (this.active) return;
		const next = this.queue.shift();
		if (!next) return;
		this.active = next;
		this.pending = next.request;
	}
}

export const diskConflictStore = new DiskConflictStore();
