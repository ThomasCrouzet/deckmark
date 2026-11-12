<script lang="ts">
	// Desktop quick capture. This component replaces the full application shell
	// in the capture window. It does not mount the editor, sidebar, or modals.
	import { onMount } from 'svelte';
	import { browser } from '$app/env';
	import { t, i18n } from '#lib/i18n/index.js';
	import { themeStore } from '#lib/ui/theme.svelte.js';
	import { db, type ProjectRow } from '#lib/db.js';
	import { normalizeRename } from '#lib/file-utils.js';
	import { CODE_LANGUAGES } from '#lib/code/languages.js';
	import { captureErrorMessage, hideCaptureWindow, onCaptureReset } from '#lib/capture.js';

	type CaptureKind = 'note' | 'snippet';

	let title = $state('');
	let body = $state('');
	let kind = $state<CaptureKind>('note');
	let language = $state(CODE_LANGUAGES[0]!.id);
	let projectId = $state('');
	let projects = $state<ProjectRow[]>([]);
	let templates = $state<Array<{ id: string; name: string }>>([]);
	let templateId = $state('');
	let busy = $state(false);
	let error = $state('');
	let status = $state('');
	let textarea = $state<HTMLTextAreaElement | null>(null);
	let titleInput = $state<HTMLInputElement | null>(null);
	let unlisten: (() => void) | undefined;
	// A template read must not publish into a newer capture session or a newer
	// template choice. Each reset, save, cancel, and selection increments one
	// counter. Only the latest request may change the form.
	let captureGeneration = 0;
	let templateRequest = 0;

	async function loadTemplates(): Promise<void> {
		if (!browser || typeof indexedDB === 'undefined') return;
		try {
			const { templatesStore } = await import('#lib/templates.svelte.js');
			await templatesStore.load();
			templates = templatesStore.choices
				.filter((template) => template.kind === 'note')
				.map((template) => ({ id: template.id, name: template.name }));
		} catch {
			templates = [];
		}
	}

	async function applyTemplate(): Promise<void> {
		const request = ++templateRequest;
		const generation = captureGeneration;
		const requestedId = templateId;
		const requestedKind = kind;
		error = '';
		if (!requestedId || requestedKind !== 'note' || body.trim()) return;
		try {
			const { templatesStore } = await import('#lib/templates.svelte.js');
			if (request !== templateRequest || generation !== captureGeneration) return;
			const resolved = await templatesStore.resolve(requestedId);
			if (request !== templateRequest || generation !== captureGeneration) return;
			if (templateId !== requestedId || kind !== requestedKind || body.trim()) return;
			if (!resolved) {
				error = t('capture.templateMissing');
				return;
			}
			if (!title.trim()) title = resolved.name.replace(/\.md$/i, '');
			body = resolved.content;
			textarea?.focus();
		} catch (cause) {
			if (request === templateRequest && generation === captureGeneration) {
				error = t('capture.templateFailed', { message: captureErrorMessage(cause) });
			}
		}
	}

	async function loadProjects(): Promise<void> {
		if (!browser || typeof indexedDB === 'undefined') return;
		try {
			projects = await db.projects.orderBy('updatedAt').reverse().toArray();
			if (projectId && !projects.some((project) => project.id === projectId)) projectId = '';
		} catch {
			projects = [];
		}
	}

	function reset(): void {
		captureGeneration += 1;
		templateRequest += 1;
		title = '';
		body = '';
		error = '';
		status = '';
		kind = 'note';
		language = CODE_LANGUAGES[0]!.id;
		projectId = '';
		templateId = '';
		void loadProjects();
		void loadTemplates();
		void Promise.resolve().then(() => textarea?.focus());
	}

	function fileName(): string {
		const firstLine = body
			.trim()
			.split('\n')
			.map((line) => line.trim())
			.find((line) => line.length > 0);
		const source = title.trim() || firstLine || '';
		const safe = source
			.replace(/[\\/:*?"<>|[\]\r\n]/g, ' ')
			.replace(/\s+/g, ' ')
			.trim()
			.slice(0, 120);
		return normalizeRename(safe);
	}

	/** Snippets keep a plain title: the file extension belongs to notes only. */
	function snippetTitle(): string {
		const firstLine = body
			.trim()
			.split('\n')
			.map((line) => line.trim())
			.find((line) => line.length > 0);
		return (title.trim() || firstLine || '').slice(0, 200);
	}

	async function pasteFromClipboard(): Promise<void> {
		error = '';
		status = '';
		try {
			if (!navigator.clipboard?.readText) throw new Error('clipboard unavailable');
			const text = await navigator.clipboard.readText();
			if (!text) return;
			body = body.trim() ? `${body}\n${text}` : text;
			textarea?.focus();
		} catch {
			error = t('capture.clipboardFailed');
		}
	}

	async function save(): Promise<void> {
		if (busy) return;
		templateRequest += 1;
		if (!body.trim()) {
			error = t('capture.contentRequired');
			textarea?.focus();
			return;
		}
		busy = true;
		error = '';
		status = '';
		try {
			if (kind === 'snippet') {
				const { snippetsStore } = await import('#lib/snippets.svelte.js');
				const result = await snippetsStore.save({
					title: snippetTitle(),
					code: body,
					language,
					tags: [],
					...(projectId ? { projectId } : {})
				});
				if (!result.ok) throw new Error(t('capture.duplicateSnippet'));
			} else {
				const { filesStore } = await import('#lib/files.svelte.js');
				const name = fileName();
				if (projectId) {
					const { createProjectDocument } = await import('#lib/projects.js');
					// Reserve the path and commit the final body in one transaction.
					await createProjectDocument(projectId, name, body);
				} else {
					filesStore.createNew(name, body, { origin: 'created', kind: 'note' });
				}
				await filesStore.flushPendingAwait();
			}
			status = t(kind === 'snippet' ? 'capture.snippetSaved' : 'capture.saved');
			await new Promise((resolve) => setTimeout(resolve, 350));
			await hideCaptureWindow();
		} catch (cause) {
			error = t('capture.saveFailed', { message: captureErrorMessage(cause) });
		} finally {
			busy = false;
		}
	}

	async function cancel(): Promise<void> {
		if (busy) return;
		captureGeneration += 1;
		templateRequest += 1;
		try {
			await hideCaptureWindow();
		} catch (cause) {
			error = captureErrorMessage(cause);
		}
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') {
			event.preventDefault();
			void cancel();
			return;
		}
		if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
			event.preventDefault();
			void save();
		}
	}

	onMount(() => {
		themeStore.load();
		i18n.load();
		void loadProjects();
		void loadTemplates();
		void Promise.resolve().then(() => textarea?.focus());
		void onCaptureReset(reset)
			.then((dispose) => (unlisten = dispose))
			.catch(() => {});
		return () => {
			unlisten?.();
			unlisten = undefined;
		};
	});
</script>

<svelte:window onkeydown={handleKeydown} />

<main
	data-testid="quick-capture"
	class="flex h-[100dvh] w-full flex-col overflow-hidden bg-bg text-fg"
	aria-labelledby="quick-capture-title"
>
	<header class="flex items-center justify-between border-b border-border px-4 py-2.5">
		<div>
			<h1 id="quick-capture-title" class="text-sm font-medium text-fg">
				{t('capture.title')}
			</h1>
			<p class="text-xs text-fg-dim">{t('capture.hint')}</p>
		</div>
		<button
			type="button"
			class="rounded px-2 py-1 text-xs text-fg-dim transition hover:bg-bg-2 hover:text-fg"
			onclick={() => void cancel()}
			disabled={busy}
			data-testid="capture-cancel-icon"
		>
			{t('capture.cancel')}
		</button>
	</header>

	<div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
		<label class="block text-xs text-fg-muted">
			<span>{t('capture.titleLabel')}</span>
			<input
				bind:this={titleInput}
				bind:value={title}
				type="text"
				class="mt-1 w-full rounded border border-border bg-bg-2 px-2 py-1.5 text-sm text-fg"
				placeholder={t('capture.titlePlaceholder')}
				disabled={busy}
				data-testid="capture-title"
			/>
		</label>

		<div class="flex flex-wrap gap-3">
			<label class="block min-w-32 flex-1 text-xs text-fg-muted">
				<span>{t('capture.kind')}</span>
				<select
					bind:value={kind}
					class="mt-1 w-full rounded border border-border bg-bg-2 px-2 py-1.5 text-sm text-fg"
					disabled={busy}
					data-testid="capture-kind"
				>
					<option value="note">{t('capture.kindNote')}</option>
					<option value="snippet">{t('capture.kindSnippet')}</option>
				</select>
			</label>
			{#if kind === 'snippet'}
				<label class="block min-w-32 flex-1 text-xs text-fg-muted">
					<span>{t('capture.language')}</span>
					<select
						bind:value={language}
						class="mt-1 w-full rounded border border-border bg-bg-2 px-2 py-1.5 text-sm text-fg"
						disabled={busy}
						data-testid="capture-language"
					>
						{#each CODE_LANGUAGES as entry (entry.id)}
							<option value={entry.id}>{entry.label}</option>
						{/each}
					</select>
				</label>
			{/if}
		</div>

		{#if kind === 'note' && templates.length > 0}
			<label class="block text-xs text-fg-muted">
				<span>{t('capture.template')}</span>
				<select
					bind:value={templateId}
					onchange={() => void applyTemplate()}
					class="mt-1 w-full rounded border border-border bg-bg-2 px-2 py-1.5 text-sm text-fg"
					disabled={busy || !!body.trim()}
					data-testid="capture-template"
				>
					<option value="">{t('capture.blankTemplate')}</option>
					{#each templates as template (template.id)}
						<option value={template.id}>{template.name}</option>
					{/each}
				</select>
			</label>
		{/if}

		<label class="block text-xs text-fg-muted">
			<span>{t('capture.project')}</span>
			<select
				bind:value={projectId}
				class="mt-1 w-full rounded border border-border bg-bg-2 px-2 py-1.5 text-sm text-fg"
				disabled={busy}
				data-testid="capture-project"
			>
				<option value="">{t('capture.library')}</option>
				{#each projects as project (project.id)}
					<option value={project.id}>{project.name}</option>
				{/each}
			</select>
		</label>

		<label class="flex min-h-0 flex-1 flex-col text-xs text-fg-muted">
			<span>{t('capture.content')}</span>
			<textarea
				bind:this={textarea}
				bind:value={body}
				class="mt-1 min-h-32 flex-1 resize-none rounded border border-border bg-bg-2 px-2 py-1.5 font-mono text-sm text-fg"
				placeholder={kind === 'snippet'
					? t('capture.codePlaceholder')
					: t('capture.contentPlaceholder')}
				disabled={busy}
				data-testid="capture-content"></textarea>
		</label>

		<div class="flex items-center gap-2">
			<button
				type="button"
				class="rounded border border-border px-2.5 py-1 text-xs text-fg-muted transition hover:bg-bg-2"
				onclick={() => void pasteFromClipboard()}
				disabled={busy}
				data-testid="capture-paste"
			>
				{t('capture.paste')}
			</button>
			<span class="text-xs text-fg-dim">{t('capture.keyboardHint')}</span>
		</div>

		{#if error}
			<p class="text-xs text-danger" role="alert" data-testid="capture-error">{error}</p>
		{/if}
		<div class="sr-only" role="status" aria-live="polite">{status}</div>
		{#if status}
			<p class="text-xs text-fg-muted" data-testid="capture-status">{status}</p>
		{/if}
	</div>

	<footer class="flex justify-end gap-2 border-t border-border px-4 py-2.5">
		<button
			type="button"
			class="rounded border border-border px-3 py-1 text-xs text-fg-muted transition hover:bg-bg-2"
			onclick={() => void cancel()}
			disabled={busy}
			data-testid="capture-cancel"
		>
			{t('capture.cancel')}
		</button>
		<button
			type="button"
			class="rounded border border-accent bg-accent px-3 py-1 text-xs text-white transition disabled:opacity-50"
			onclick={() => void save()}
			disabled={busy || !body.trim()}
			data-testid="capture-save"
		>
			{kind === 'snippet' ? t('capture.saveSnippet') : t('capture.save')}
		</button>
	</footer>
</main>
