<script lang="ts">
	// §5.7 - "Disk links" panel: lists the FileSystemFileHandle entries persisted
	// in IDB (`mdsh-fs.handles`), with Verify / Unlink actions.
	//
	// Why: FSA handles are opaque on the UI side (a file may have been
	// moved/deleted on disk, or its permission revoked after a reload).
	// Until now the user had no way to view or clean up these links.
	//
	// SSR-safe: the component is used in a prerender=true page but only touches
	// the APIs (`navigator`, IDB, FSA) inside `onMount` or effects guarded by
	// `browser`. The lists stay empty on the SSR side.

	import { tick } from 'svelte';
	import LoadError from './LoadError.svelte';
	import { reportPersistenceError } from '#lib/storage.js';
	import { browser } from '$app/env';
	import { t } from '#lib/i18n/index.js';
	import { keyboardStore } from '#lib/ui/keyboard.svelte.js';
	import { filesStore } from '#lib/files.svelte.js';
	import { notify } from '#lib/notify.svelte.js';
	import { listDiskLinks, checkHandle } from '#lib/fsa.js';
	import { isDiskLinkingAvailable } from '#lib/disk-sync.js';
	import { tauriCheckPath } from '#lib/disk-tauri.js';
	import { focusTrap } from '#lib/a11y/focusTrap.js';
	import {
		Link2,
		Link2Off,
		RefreshCw,
		X,
		CheckCircle2,
		AlertTriangle,
		XCircle
	} from '@lucide/svelte';

	interface Props {
		open: boolean;
		onClose: () => void;
	}

	let { open, onClose }: Props = $props();

	type LinkStatus = 'unknown' | 'ok' | 'permission-needed' | 'broken';

	interface DiskLink {
		id: string;
		kind: 'fsa' | 'path';
		handle?: FileSystemFileHandle;
		path?: string;
		// Display name: the file's name in the store, or link label as a
		// fallback (orphan case: draft deleted but handle still present). We also
		// expose `orphan` to style/warn.
		displayName: string;
		orphan: boolean;
		status: LinkStatus;
	}

	let entries = $state<DiskLink[]>([]);
	let loading = $state(false);
	let loadError = $state(false);
	let closeButton: HTMLButtonElement | null = $state(null);

	function findFileName(id: string, fallbackLabel: string): { name: string; orphan: boolean } {
		const f = filesStore.library.find((file) => file.id === id);
		if (f) return { name: f.name, orphan: false };
		if (fallbackLabel.length > 0) {
			return { name: fallbackLabel, orphan: true };
		}
		const short = id.length > 12 ? `${id.slice(0, 8)}…` : id;
		return { name: short, orphan: true };
	}

	async function refresh(): Promise<void> {
		if (!browser) return;
		loading = true;
		loadError = false;
		try {
			const raw = await listDiskLinks();
			entries = raw.map((entry) => {
				const meta = findFileName(entry.id, entry.label);
				if (entry.kind === 'path') {
					return {
						id: entry.id,
						kind: 'path' as const,
						path: entry.path,
						displayName: meta.name,
						orphan: meta.orphan,
						status: 'unknown' as const
					};
				}
				return {
					id: entry.id,
					kind: 'fsa' as const,
					handle: entry.handle,
					displayName: meta.name,
					orphan: meta.orphan,
					status: 'unknown' as const
				};
			});
		} catch (error) {
			loadError = true;
			reportPersistenceError(error, 'load');
		} finally {
			loading = false;
		}
	}

	async function verify(entry: DiskLink): Promise<void> {
		const idx = entries.findIndex((e) => e.id === entry.id);
		if (idx === -1) return;
		let status: LinkStatus = 'broken';
		if (entry.kind === 'path' && entry.path) {
			status = await tauriCheckPath(entry.path);
		} else if (entry.handle) {
			status = await checkHandle(entry.handle);
		}
		// Index-by-index mutation: we replace the entry so that Svelte 5 runes
		// observe the change (pushing a new status onto a copy would not
		// trigger reactivity on the original array).
		// invariant: idx !== -1 guarantees entries[idx] is defined.
		const existing = entries[idx]!;
		entries[idx] = { ...existing, status };
		// WCAG 4.1.3 - The per-row status is only an icon plus a static sr-only
		// label: without an announcement, a screen reader does not perceive the
		// result of clicking "Verify". We route it to the notify store (polite for
		// ok/info, assertive for a broken link).
		const message = t('diskLinks.statusMessage', {
			name: entry.displayName,
			status: statusLabel(status)
		});
		if (status === 'ok') notify.success(message);
		else if (status === 'broken') notify.error(message);
		else notify.info(message);
	}

	async function unlink(entry: DiskLink): Promise<void> {
		await filesStore.unlinkFromDisk(entry.id);
		// If the file was not in the store (orphan), filesStore.unlinkFromDisk
		// is a no-op on the state side - we still need to remove the handle from IDB.
		// We refresh the list to reflect the actual state.
		await refresh();
	}

	$effect(() => {
		if (open) {
			void refresh().then(() => {
				tick().then(() => closeButton?.focus());
			});
		}
	});

	function statusLabel(s: LinkStatus): string {
		switch (s) {
			case 'ok':
				return t('diskLinks.statusOk');
			case 'permission-needed':
				return t('diskLinks.statusPermissionNeeded');
			case 'broken':
				return t('diskLinks.statusBroken');
			default:
				return t('diskLinks.statusUnknown');
		}
	}
</script>

{#if open}
	<div
		class="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 pb-4 backdrop-blur-sm
		       pt-[max(env(safe-area-inset-top),12vh)]"
		style:padding-left="max(env(safe-area-inset-left), 1rem)"
		style:padding-right="max(env(safe-area-inset-right), 1rem)"
		onclick={(e) => {
			if (e.target === e.currentTarget) onClose();
		}}
		onkeydown={(e) => {
			if (e.key === 'Escape') onClose();
		}}
		role="dialog"
		aria-modal="true"
		aria-labelledby="disk-links-title"
		tabindex="-1"
		use:focusTrap
	>
		<div
			class="mdsh-dialog-panel flex w-full max-w-xl flex-col overflow-hidden rounded-lg border border-border
			       bg-bg-1 shadow-2xl animate-fade-in"
		>
			<header class="flex items-center gap-2 border-b border-border px-3 py-2">
				<Link2 size={16} class="text-fg-dim" aria-hidden="true" />
				<h2 id="disk-links-title" class="flex-1 text-sm font-medium text-fg">
					{t('diskLinks.title')}
				</h2>
				<button
					class="rounded p-1 text-fg-dim transition hover:bg-bg-2 hover:text-fg"
					onclick={() => void refresh()}
					title={t('diskLinks.refresh')}
					aria-label={t('diskLinks.refreshList')}
					disabled={loading}
				>
					<RefreshCw size={14} class={loading ? 'animate-spin' : ''} />
				</button>
				<button
					bind:this={closeButton}
					class="rounded p-1 text-fg-dim transition hover:bg-bg-2 hover:text-fg"
					onclick={onClose}
					aria-label={t('diskLinks.close')}
				>
					<X size={14} />
				</button>
			</header>

			<div class="max-h-[60vh] overflow-y-auto">
				{#if !isDiskLinkingAvailable()}
					<p class="px-4 py-6 text-center text-xs text-fg-dim">
						{t('diskLinks.notSupported')}
					</p>
				{:else if loadError}
					<LoadError onRetry={() => void refresh()} busy={loading} />
				{:else if loading && entries.length === 0}
					<p class="px-4 py-6 text-center text-xs text-fg-dim">{t('diskLinks.loading')}</p>
				{:else if entries.length === 0}
					<p class="px-4 py-6 text-center text-xs text-fg-dim">
						{t('diskLinks.empty', { shortcut: keyboardStore.label('save-disk') ?? '' })}
					</p>
				{:else}
					<ul class="divide-y divide-border" aria-label={t('diskLinks.listLabel')}>
						{#each entries as entry (entry.id)}
							<li class="flex items-center gap-3 px-3 py-2.5">
								<span
									class="flex-shrink-0"
									class:text-accent={entry.status === 'ok'}
									class:text-warning={entry.status === 'permission-needed'}
									class:text-danger={entry.status === 'broken'}
									class:text-fg-dim={entry.status === 'unknown'}
									aria-hidden="true"
								>
									{#if entry.status === 'ok'}
										<CheckCircle2 size={14} />
									{:else if entry.status === 'permission-needed'}
										<AlertTriangle size={14} />
									{:else if entry.status === 'broken'}
										<XCircle size={14} />
									{:else}
										<Link2 size={14} />
									{/if}
								</span>
								<span class="sr-only">{statusLabel(entry.status)}</span>
								<div class="min-w-0 flex-1">
									<div class="truncate text-sm text-fg" title={entry.displayName}>
										{entry.displayName}
									</div>
									{#if entry.orphan}
										<div class="text-[10px] text-fg-dim">{t('diskLinks.orphan')}</div>
									{/if}
								</div>
								<button
									class="rounded border border-border px-2 py-1 text-xs text-fg-muted transition hover:bg-bg-2 hover:text-fg"
									onclick={() => void verify(entry)}
									aria-label={t('diskLinks.verifyLink', { name: entry.displayName })}
								>
									{t('diskLinks.verify')}
								</button>
								<button
									class="flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-fg-muted transition hover:bg-bg-2 hover:text-danger"
									onclick={() => void unlink(entry)}
									aria-label={t('diskLinks.unlinkFile', { name: entry.displayName })}
								>
									<Link2Off size={12} aria-hidden="true" />
									<span>{t('diskLinks.unlink')}</span>
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</div>

			<footer class="border-t border-border px-3 py-2 text-[11px] text-fg-dim">
				{t('diskLinks.count', { n: entries.length })} ·
				<span class="inline-flex items-center gap-1">
					<CheckCircle2 size={10} class="text-accent" aria-hidden="true" />{t('diskLinks.legendOk')}
				</span>
				·
				<span class="inline-flex items-center gap-1">
					<AlertTriangle size={10} class="text-warning" aria-hidden="true" />{t(
						'diskLinks.legendPermission'
					)}
				</span>
				·
				<span class="inline-flex items-center gap-1">
					<XCircle size={10} class="text-danger" aria-hidden="true" />{t('diskLinks.legendBroken')}
				</span>
			</footer>
		</div>
	</div>
{/if}
