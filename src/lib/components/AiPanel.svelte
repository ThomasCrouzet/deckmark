<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { X } from '@lucide/svelte';
	import { focusTrap } from '#lib/a11y/focusTrap.js';
	import { t, type MessageKey } from '#lib/i18n/index.js';
	import { filesStore } from '#lib/files.svelte.js';
	import { documentKindForFile } from '#lib/document-kind.js';
	import { aiStore, aiErrorMessage } from '#lib/ai/store.svelte.js';
	import { buildContext, contextSystemPrompt, type AiContextScope } from '#lib/ai/context.js';
	import { AiProviderError } from '#lib/ai/types.js';
	import {
		applyPatchPlan,
		contentHash,
		parsePatchProposal,
		planPatch,
		type AiPatchProposal,
		type PatchPlan
	} from '#lib/ai/patches.js';
	import DiffView from '#lib/components/DiffView.svelte';
	import { createCheckpoints } from '#lib/version-history.js';

	let { open, onClose }: { open: boolean; onClose: () => void } = $props();

	let scope = $state<AiContextScope>('document');
	let selectedIds = $state<string[]>([]);
	let ignore = $state('.env, secrets/, *.pem, *.key');
	let prompt = $state('');
	let output = $state('');
	let error = $state('');
	let streaming = $state(false);
	let selectionText = $state('');
	let controller: AbortController | null = null;
	let lastPrompt = $state('');
	let history = $state<Array<{ prompt: string; reply: string }>>([]);
	const MAX_OUTPUT_CHARS = 2_000_000;
	const MAX_HISTORY_CHARS = 4_000_000;

	function boundedHistory(
		entries: Array<{ prompt: string; reply: string }>
	): Array<{ prompt: string; reply: string }> {
		const kept: Array<{ prompt: string; reply: string }> = [];
		let bytes = 0;
		for (const entry of entries) {
			const size = entry.prompt.length + entry.reply.length;
			if (kept.length > 0 && bytes + size > MAX_HISTORY_CHARS) break;
			kept.push(entry);
			bytes += size;
		}
		return kept;
	}
	let lastAllowedIds = $state<string[]>([]);
	let approvedPaths = $state<string[]>([]);
	let selectedHunks = $state<Record<string, number[]>>({});
	let planKey = $state('');
	let appliedMessage = $state('');
	let appliedBefore = $state<Array<{ id: string; content: string }>>([]);
	let appliedAfter = $state<Array<{ id: string; content: string }>>([]);
	let patchError = $state('');

	const candidates = $derived(
		filesStore.library
			.filter((file) => documentKindForFile(file) !== 'image')
			.toSorted((a, b) => (a.relativePath ?? a.name).localeCompare(b.relativePath ?? b.name))
	);
	const active = $derived(filesStore.active);
	const projectSelected = $derived(!!active?.projectId);

	onMount(() => {
		selectionText = window.getSelection()?.toString() ?? '';
		if (filesStore.activeId) selectedIds = [filesStore.activeId];
	});

	onDestroy(() => controller?.abort());

	const bundle = $derived(
		buildContext({
			scope,
			activeId: filesStore.activeId,
			selection: selectionText,
			files: filesStore.library,
			selectedIds,
			projectId: active?.projectId ?? null,
			ignorePatterns: ignore
				.split(',')
				.map((value) => value.trim())
				.filter(Boolean),
			maxTokens: aiStore.settings.maxTokens > 1024 ? aiStore.settings.maxTokens : 24000
		})
	);

	const included = $derived(bundle.manifest.filter((entry) => entry.includedTokens > 0));
	const excluded = $derived(bundle.manifest.filter((entry) => entry.includedTokens === 0));
	const proposal = $derived<AiPatchProposal | null>(
		!streaming && output ? parsePatchProposal(output) : null
	);
	const patchPlan = $derived<PatchPlan | null>(
		proposal ? planPatch(proposal, filesStore.library, lastAllowedIds) : null
	);

	$effect(() => {
		const key = patchPlan?.files.map((file) => `${file.path}:${file.status}`).join('|') ?? '';
		if (!key || key === planKey) return;
		planKey = key;
		approvedPaths =
			patchPlan?.files.filter((file) => file.status === 'ready').map((file) => file.path) ?? [];
		selectedHunks = Object.fromEntries(
			(patchPlan?.files ?? []).map((file) => [
				file.path,
				file.hunks.filter((hunk) => hunk.ok).map((hunk) => hunk.index)
			])
		);
		patchError = '';
	});

	function togglePath(path: string) {
		approvedPaths = approvedPaths.includes(path)
			? approvedPaths.filter((value) => value !== path)
			: [...approvedPaths, path];
	}

	function toggleHunk(path: string, index: number) {
		const current = selectedHunks[path] ?? [];
		selectedHunks = {
			...selectedHunks,
			[path]: current.includes(index)
				? current.filter((value) => value !== index)
				: [...current, index]
		};
	}

	async function applyPatch() {
		if (!patchPlan || patchPlan.files.length === 0) return;
		const current = planPatch(proposal!, filesStore.library, lastAllowedIds);
		const hunks: Record<string, number[]> = {};
		for (const path of approvedPaths) {
			const file = current.files.find((entry) => entry.path === path);
			hunks[path] =
				selectedHunks[path] ??
				file?.hunks.filter((hunk) => hunk.ok).map((hunk) => hunk.index) ??
				[];
		}
		const result = applyPatchPlan(current, filesStore.library, approvedPaths, hunks);
		if (result.rejected.length > 0) {
			patchError = t('ai.patchConflict');
			return;
		}
		if (result.changes.length === 0) return;
		const snapshots = result.changes.map((change) => {
			const file = filesStore.library.find((entry) => entry.id === change.id)!;
			return { id: file.id, name: file.name, content: file.content };
		});
		try {
			await createCheckpoints(snapshots);
		} catch {
			patchError = t('ai.patchCheckpointFailed');
			return;
		}
		const fence = applyPatchPlan(current, filesStore.library, approvedPaths, hunks);
		const stale =
			fence.rejected.length > 0 ||
			fence.changes.length !== result.changes.length ||
			fence.changes.some((change) => {
				const file = filesStore.library.find((entry) => entry.id === change.id);
				const original = snapshots.find((snapshot) => snapshot.id === change.id);
				const intended = result.changes.find((entry) => entry.id === change.id);
				return (
					!file ||
					file.contentDeferred ||
					!original ||
					!intended ||
					file.content !== original.content ||
					change.content !== intended.content
				);
			});
		if (stale) {
			patchError = t('ai.patchConflict');
			return;
		}
		appliedBefore = snapshots.map((snapshot) => ({ id: snapshot.id, content: snapshot.content }));
		appliedAfter = result.changes.map((change) => ({
			id: change.id,
			content: change.content
		}));
		for (const change of result.changes) filesStore.updateContent(change.id, change.content);
		appliedMessage = t('ai.patchApplied', { n: result.changes.length });
		patchError = '';
	}

	function revertPatch() {
		const stale = appliedAfter.find((change) => {
			const file = filesStore.library.find((entry) => entry.id === change.id);
			return !file || contentHash(file.content) !== contentHash(change.content);
		});
		if (stale) {
			patchError = t('ai.patchRevertConflict');
			return;
		}
		for (const change of appliedBefore) filesStore.updateContent(change.id, change.content);
		appliedBefore = [];
		appliedAfter = [];
		appliedMessage = t('ai.patchReverted');
	}

	function reasonLabel(reason: string | undefined): string {
		if (reason === 'binary') return t('ai.reason_binary');
		if (reason === 'secret') return t('ai.reason_secret');
		if (reason === 'ignored') return t('ai.reason_ignored');
		return t('ai.reason_budget');
	}

	function toggleFile(id: string) {
		selectedIds = selectedIds.includes(id)
			? selectedIds.filter((value) => value !== id)
			: [...selectedIds, id];
	}

	function refreshSelection() {
		selectionText = window.getSelection()?.toString() ?? '';
	}

	async function run(instruction: string) {
		if (streaming) return;
		const text = instruction.trim();
		if (!text) return;
		if (!included.length && scope !== 'selection') {
			error = t('ai.noContext');
			return;
		}
		if (scope === 'selection' && !selectionText.trim()) {
			error = t('ai.noSelection');
			return;
		}
		error = '';
		output = '';
		patchError = '';
		appliedMessage = '';
		streaming = true;
		lastPrompt = text;
		controller = new AbortController();
		try {
			// Hydrate only the scope the user approved. Selection scope reads the
			// captured selection, and the active document is already resident.
			const needed =
				scope === 'files'
					? selectedIds
					: scope === 'project'
						? filesStore.library
								.filter((file) => file.projectId === active?.projectId)
								.map((file) => file.id)
						: scope === 'document' && filesStore.activeId
							? [filesStore.activeId]
							: [];
			await filesStore.ensureContent(
				needed.filter((id) => !filesStore.active || id !== filesStore.active.id)
			);
			if (controller.signal.aborted) return;
			const request = buildContext({
				scope,
				activeId: filesStore.activeId,
				selection: selectionText,
				files: filesStore.library,
				selectedIds,
				projectId: active?.projectId ?? null,
				ignorePatterns: ignore
					.split(',')
					.map((value) => value.trim())
					.filter(Boolean),
				maxTokens: aiStore.settings.maxTokens > 1024 ? aiStore.settings.maxTokens : 24000
			});
			lastAllowedIds = request.manifest
				.filter((entry) => entry.includedTokens > 0)
				.map((entry) => entry.id);
			await aiStore.chat(
				{
					signal: controller.signal,
					messages: [
						{ role: 'system', content: contextSystemPrompt() },
						{
							role: 'user',
							content: `<context>\n${request.text}\n</context>\n\n${text}`
						}
					]
				},
				(chunk) => {
					const room = MAX_OUTPUT_CHARS - output.length;
					if (room > 0) output += chunk.slice(0, room);
				}
			);
			history = boundedHistory([{ prompt: text, reply: output }, ...history].slice(0, 10));
		} catch (failure) {
			if (failure instanceof AiProviderError && failure.code === 'cancelled')
				output += t('ai.stopped');
			else error = aiErrorMessage(failure);
		} finally {
			streaming = false;
			controller = null;
		}
	}

	function stop() {
		controller?.abort();
	}

	const scopes: Array<[AiContextScope, MessageKey]> = [
		['document', 'ai.scopeDocument'],
		['selection', 'ai.scopeSelection'],
		['files', 'ai.scopeFiles'],
		['project', 'ai.scopeProject']
	];

	const actions = $derived([
		{ id: 'explain', label: t('ai.explain'), prompt: t('ai.explainPrompt') },
		{ id: 'fix', label: t('ai.fix'), prompt: t('ai.fixPrompt') },
		{ id: 'rewrite', label: t('ai.rewrite'), prompt: t('ai.rewritePrompt') },
		{ id: 'translate', label: t('ai.translate'), prompt: t('ai.translatePrompt') },
		{ id: 'expand', label: t('ai.expand'), prompt: t('ai.expandPrompt') },
		{ id: 'summarize', label: t('ai.summarize'), prompt: t('ai.summarizePrompt') },
		{ id: 'patch', label: t('ai.proposePatch'), prompt: t('ai.patchPrompt') }
	]);

	function statusLabel(status: string): string {
		if (status === 'ready') return t('ai.patchReady');
		if (status === 'stale') return t('ai.patchStale');
		if (status === 'missing') return t('ai.patchMissing');
		if (status === 'conflict') return t('ai.patchConflictStatus');
		if (status === 'noop') return t('ai.patchNoop');
		return status;
	}
</script>

{#if open}
	<div class="ai-backdrop" role="presentation">
		<div
			class="ai-panel"
			role="dialog"
			aria-modal="true"
			aria-labelledby="ai-panel-title"
			tabindex="-1"
			use:focusTrap
			onkeydown={(event) => {
				if (event.key === 'Escape' && !streaming) onClose();
			}}
			data-testid="ai-panel"
		>
			<header class="ai-header">
				<div>
					<h2 id="ai-panel-title">{t('ai.title')}</h2>
					<p class="ai-provider" data-testid="ai-provider">
						{t('ai.provider', {
							host: aiStore.providerHost,
							model: aiStore.settings.model || t('ai.noModel')
						})}
					</p>
				</div>
				<button
					type="button"
					onclick={onClose}
					aria-label={t('settings.close')}
					disabled={streaming}
				>
					<X size={16} />
				</button>
			</header>

			<div class="ai-body">
				<section aria-labelledby="ai-context-title">
					<h3 id="ai-context-title">{t('ai.context')}</h3>
					<div class="ai-scopes" role="group" aria-label={t('ai.contextScope')}>
						{#each scopes as [value, label] (value)}
							<button
								type="button"
								aria-pressed={scope === value}
								onclick={() => (scope = value as AiContextScope)}
								disabled={value === 'project' && !projectSelected}
								data-testid={`ai-scope-${value}`}>{t(label)}</button
							>
						{/each}
					</div>
					{#if scope === 'selection'}
						<div class="ai-selection">
							<button type="button" onclick={refreshSelection} data-testid="ai-refresh-selection">
								{t('ai.refreshSelection')}
							</button>
							<span>{t('ai.selectionSize', { n: selectionText.length })}</span>
						</div>
					{/if}
					{#if scope === 'files'}
						<div class="ai-file-list" role="group" aria-label={t('ai.contextFiles')}>
							{#each candidates as file (file.id)}
								<label>
									<input
										type="checkbox"
										checked={selectedIds.includes(file.id)}
										onchange={() => toggleFile(file.id)}
									/>
									<span>{file.relativePath ?? file.name}</span>
								</label>
							{/each}
						</div>
					{/if}
					<label class="ai-ignore">
						<span>{t('ai.ignorePatterns')}</span>
						<input type="text" bind:value={ignore} />
					</label>
					<div class="ai-manifest" data-testid="ai-manifest">
						<p>
							{t('ai.budget', {
								used: bundle.estimatedTokens,
								max: aiStore.settings.maxTokens > 1024 ? aiStore.settings.maxTokens : 24000
							})}
							{#if bundle.truncated}<strong>{t('ai.truncated')}</strong>{/if}
						</p>
						<ul>
							{#each included as entry (entry.id)}
								<li data-included="true">
									<span>{entry.path}</span>
									<em
										>{entry.includedTokens}{#if entry.truncated}
											/ {entry.tokens}{/if}</em
									>
								</li>
							{/each}
							{#each excluded as entry (entry.id)}
								<li data-included="false">
									<span>{entry.path}</span>
									<em>{reasonLabel(entry.reason)}</em>
								</li>
							{/each}
						</ul>
						<p class="ai-destination">
							{t('ai.destination', { host: aiStore.providerHost })}
						</p>
						{#if aiStore.usesNativeVault}
							<p class="ai-destination" data-testid="ai-native-boundary">
								{t('ai.nativeBoundary')}
							</p>
						{/if}
					</div>
				</section>

				<section aria-labelledby="ai-prompt-title">
					<h3 id="ai-prompt-title">{t('ai.actions')}</h3>
					<div class="ai-actions">
						{#each actions as action (action.id)}
							<button
								type="button"
								disabled={streaming}
								onclick={() => void run(action.prompt)}
								data-testid={`ai-action-${action.id}`}>{action.label}</button
							>
						{/each}
					</div>
					<label class="ai-prompt">
						<span>{t('ai.prompt')}</span>
						<textarea
							bind:value={prompt}
							rows="4"
							placeholder={t('ai.promptPlaceholder')}
							data-testid="ai-prompt"></textarea>
					</label>
					<div class="ai-run">
						<button
							type="button"
							disabled={streaming || !prompt.trim()}
							onclick={() => void run(prompt)}
							data-testid="ai-send">{t('ai.send')}</button
						>
						{#if streaming}
							<button type="button" onclick={stop} data-testid="ai-stop">{t('ai.stop')}</button>
						{:else if lastPrompt}
							<button type="button" onclick={() => void run(lastPrompt)} data-testid="ai-retry"
								>{t('ai.retry')}</button
							>
						{/if}
					</div>
				</section>

				{#if error}
					<p class="ai-error" role="alert" data-testid="ai-error">{error}</p>
				{/if}
				{#if output}
					<section aria-labelledby="ai-output-title">
						<h3 id="ai-output-title">{t('ai.reply')}</h3>
						<pre class="ai-output" data-testid="ai-output" aria-live="polite">{output}</pre>
					</section>
				{/if}
				{#if proposal && patchPlan}
					<section class="ai-patch" aria-labelledby="ai-patch-title" data-testid="ai-patch-review">
						<h3 id="ai-patch-title">{t('ai.patchReview')}</h3>
						{#each patchPlan.files as file (file.path)}
							<article class="patch-file" data-status={file.status}>
								<label class="patch-path">
									<input
										type="checkbox"
										disabled={file.status !== 'ready'}
										checked={approvedPaths.includes(file.path)}
										onchange={() => togglePath(file.path)}
									/>
									<span>{file.path}</span>
									<em>{statusLabel(file.status)}</em>
								</label>
								{#if file.status === 'ready'}
									<div class="patch-hunks">
										{#each file.hunks as hunk (hunk.index)}
											<label>
												<input
													type="checkbox"
													checked={(selectedHunks[file.path] ?? []).includes(hunk.index)}
													onchange={() => toggleHunk(file.path, hunk.index)}
												/>
												{t('ai.patchHunk', { n: hunk.index + 1 })}
											</label>
										{/each}
									</div>
									<DiffView before={file.before} after={file.after} />
								{/if}
							</article>
						{/each}
						{#each patchPlan.rejected as rejected (rejected.path)}
							<p class="ai-error" role="status">
								{t('ai.patchRejected', { path: rejected.path, reason: rejected.reason })}
							</p>
						{/each}
						{#if patchError}
							<p class="ai-error" role="alert" data-testid="ai-patch-error">{patchError}</p>
						{/if}
						{#if appliedMessage}
							<p class="ai-applied" role="status" data-testid="ai-patch-applied">
								{appliedMessage}
							</p>
						{/if}
						<div class="ai-run">
							<button
								type="button"
								disabled={approvedPaths.length === 0}
								onclick={() => void applyPatch()}
								data-testid="ai-patch-apply">{t('ai.patchApply')}</button
							>
							{#if appliedAfter.length > 0}
								<button type="button" onclick={revertPatch} data-testid="ai-patch-revert">
									{t('ai.patchRevert')}
								</button>
							{/if}
						</div>
					</section>
				{/if}
				{#if history.length > 0}
					<details class="ai-history">
						<summary>{t('ai.history')}</summary>
						{#each history as entry, index (index)}
							<p><strong>{entry.prompt}</strong></p>
							<pre>{entry.reply}</pre>
						{/each}
					</details>
				{/if}
			</div>
		</div>
	</div>
{/if}

<style>
	.ai-backdrop {
		position: fixed;
		inset: 0;
		z-index: 70;
		background: rgb(0 0 0 / 0.45);
	}
	.ai-panel {
		position: absolute;
		top: 0;
		right: 0;
		display: flex;
		height: 100dvh;
		width: min(100%, 560px);
		flex-direction: column;
		border-left: 1px solid var(--color-border);
		background: var(--color-bg-1);
		color: var(--color-fg);
		box-shadow: var(--shadow-lg);
	}
	.ai-header {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		justify-content: space-between;
		gap: 8px;
		padding: 12px 16px;
		border-bottom: 1px solid var(--color-border);
	}
	h2 {
		margin: 0;
		font-size: 15px;
		font-weight: 600;
	}
	h3 {
		margin: 14px 0 6px;
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--color-fg-dim);
	}
	.ai-provider {
		margin: 2px 0 0;
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--color-fg-muted);
	}
	.ai-header button {
		min-width: 36px;
		min-height: 36px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-xs);
		background: transparent;
		color: var(--color-fg);
	}
	.ai-body {
		min-height: 0;
		flex: 1;
		overflow-y: auto;
		padding: 0 16px 20px;
	}
	.ai-scopes,
	.ai-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.ai-scopes button,
	.ai-actions button,
	.ai-run button,
	.ai-selection button {
		min-height: 32px;
		padding: 4px 9px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-xs);
		background: var(--color-bg-2);
		color: var(--color-fg);
		font-size: 11px;
	}
	.ai-scopes button[aria-pressed='true'] {
		border-color: var(--color-accent);
		color: var(--color-accent);
	}
	.ai-file-list {
		display: flex;
		max-height: 140px;
		flex-direction: column;
		gap: 2px;
		overflow-y: auto;
		margin-top: 8px;
		font-size: 12px;
	}
	.ai-file-list label {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.ai-ignore {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 8px;
		font-size: 11px;
		color: var(--color-fg-muted);
	}
	.ai-ignore input {
		min-width: 0;
		flex: 1;
		min-height: 30px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-xs);
		background: var(--color-bg-2);
		color: var(--color-fg);
		padding: 2px 6px;
	}
	.ai-manifest {
		margin-top: 8px;
		font-size: 11px;
		color: var(--color-fg-muted);
	}
	.ai-manifest ul {
		margin: 4px 0;
		padding: 0;
		list-style: none;
	}
	.ai-manifest li {
		display: flex;
		justify-content: space-between;
		gap: 8px;
		padding: 2px 0;
	}
	.ai-manifest li[data-included='false'] {
		opacity: 0.6;
	}
	.ai-selection {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 6px;
		font-size: 11px;
		color: var(--color-fg-muted);
	}
	.ai-prompt {
		display: block;
		margin-top: 8px;
		font-size: 11px;
		color: var(--color-fg-muted);
	}
	.ai-prompt textarea {
		display: block;
		width: 100%;
		margin-top: 4px;
		padding: 8px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-xs);
		background: var(--color-bg-2);
		color: var(--color-fg);
		font: inherit;
	}
	.ai-run {
		display: flex;
		gap: 6px;
		margin-top: 6px;
	}
	.ai-run button[data-testid='ai-send'] {
		border-color: var(--color-accent);
		color: var(--color-accent);
	}
	.ai-output {
		max-height: 300px;
		overflow: auto;
		white-space: pre-wrap;
		padding: 8px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-xs);
		background: var(--color-bg);
		font-family: var(--font-mono);
		font-size: 12px;
	}
	.ai-error {
		margin-top: 8px;
		padding: 8px;
		border: 1px solid var(--color-danger);
		border-radius: var(--radius-xs);
		color: var(--color-danger);
		font-size: 12px;
	}
	.ai-history {
		margin-top: 10px;
		font-size: 11px;
		color: var(--color-fg-muted);
	}
	.ai-history pre {
		white-space: pre-wrap;
	}
	.ai-patch {
		margin-top: 10px;
	}
	.patch-file {
		margin-bottom: 8px;
		padding: 6px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-xs);
	}
	.patch-path,
	.patch-hunks label {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 11px;
	}
	.patch-path em {
		margin-left: auto;
		font-style: normal;
		color: var(--color-fg-muted);
	}
	.patch-file[data-status='stale'] .patch-path em,
	.patch-file[data-status='conflict'] .patch-path em {
		color: var(--color-danger);
	}
	.patch-hunks {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin: 4px 0;
	}
	.ai-applied {
		margin-top: 6px;
		color: var(--color-accent);
		font-size: 12px;
	}
</style>
