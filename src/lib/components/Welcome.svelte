<script lang="ts">
	import { FilePlus, Upload, Compass, FolderOpen } from '@lucide/svelte';
	import { keyboardStore } from '#lib/ui/keyboard.svelte.js';
	import { t } from '#lib/i18n/index.js';
	import BrandLogo from './BrandLogo.svelte';

	interface Props {
		onNew: () => void;
		onImport: () => void;
		onDemo: () => void;
		onLibrary?: () => void;
		documentCount?: number;
	}

	let { onNew, onImport, onDemo, onLibrary, documentCount = 0 }: Props = $props();
</script>

<div class="welcome-shell flex h-full items-center px-6 py-10 sm:px-10 lg:px-[8vw]">
	<section class="welcome-console w-full max-w-4xl" aria-labelledby="welcome-title">
		<div class="welcome-grid">
			<div class="welcome-intro">
				<div class="mdsh-kicker mb-5">{t('welcome.systemLabel')}</div>
				<h1 id="welcome-title" class="welcome-title">
					<BrandLogo />
				</h1>
				<div class="welcome-rule" aria-hidden="true"></div>
				<p class="mt-6 max-w-md text-base leading-relaxed text-fg-muted">
					{t('welcome.tagline')}<br />
					{t('welcome.taglineLine2')}
				</p>
				<p class="mt-3 max-w-md font-mono text-[11px] uppercase tracking-[0.08em] text-fg-subtle">
					{t('welcome.privacy')}
				</p>
				<p class="mt-3 max-w-md text-xs text-fg-muted">
					{t('welcome.persistence')}
				</p>
			</div>

			<div class="welcome-actions">
				<div class="mdsh-kicker mb-3">{t('welcome.initializeLabel')}</div>
				{#if documentCount > 0 && onLibrary}
					<button
						class="welcome-action"
						onclick={(event) => {
							event.currentTarget.focus({ preventScroll: true });
							onLibrary?.();
						}}
					>
						<span class="welcome-action-icon"><FolderOpen size={16} /></span>
						<span>{t('library.browseCount', { n: documentCount })}</span>
					</button>
				{/if}
				<button data-testid="welcome-new" class="welcome-action" onclick={onNew}>
					<span class="welcome-action-icon"><FilePlus size={16} /></span>
					<span class="flex-1">{t('welcome.newFile')}</span>
					<kbd>{keyboardStore.label('new') ?? ''}</kbd>
				</button>
				<button data-testid="welcome-import" class="welcome-action" onclick={onImport}>
					<span class="welcome-action-icon"><Upload size={16} /></span>
					<span class="flex-1">{t('welcome.importMd')}</span>
					<kbd>{keyboardStore.label('import') ?? ''}</kbd>
				</button>
				<button
					data-testid="welcome-demo"
					class="welcome-action welcome-action-secondary"
					onclick={onDemo}
				>
					<span class="welcome-action-icon"><Compass size={16} /></span>
					<span class="flex-1">{t('welcome.openDemo')}</span>
					<span class="font-mono text-[10px] text-fg-dim">{t('welcome.demoLabel')}</span>
				</button>
			</div>
		</div>

		<!-- §B4.2 - text-xs (12 px) rather than text-[10px]: 10 px fails the
		     default legibility criteria. fg-muted reaches 5:1 on a dark background. -->
		<div class="welcome-shortcuts font-mono text-xs text-fg-muted">
			<div>
				<kbd>{keyboardStore.label('export-md') ?? ''}</kbd><span>{t('welcome.legendExport')}</span>
			</div>
			<div>
				<kbd
					>{keyboardStore.label('mode-wysiwyg') ?? ''} / {keyboardStore.label('mode-read') ?? ''} / {keyboardStore.label(
						'mode-source'
					) ?? ''}</kbd
				><span>{t('welcome.legendModes')}</span>
			</div>
			<div>
				<kbd>{keyboardStore.label('sidebar') ?? ''}</kbd><span>{t('welcome.legendPanel')}</span>
			</div>
			<div>
				<kbd>{keyboardStore.label('close-file') ?? ''}</kbd><span
					>{t('welcome.legendCloseTab')}</span
				>
			</div>
		</div>
	</section>
</div>

<style>
	.welcome-shell {
		overflow-y: auto;
		align-items: safe center;
		background:
			linear-gradient(
				90deg,
				color-mix(in oklab, var(--color-bg-1) 46%, transparent),
				transparent 58%
			),
			transparent;
	}
	.welcome-console {
		position: relative;
		border-top: 1px solid var(--color-border-strong);
		border-bottom: 1px solid var(--color-border);
		padding: clamp(2rem, 5vw, 4.5rem) clamp(1rem, 4vw, 3rem) 1.5rem;
	}
	.welcome-console::before,
	.welcome-console::after {
		content: '';
		position: absolute;
		top: -1px;
		height: 2px;
		background: var(--color-accent);
	}
	.welcome-console::before {
		left: 0;
		width: 112px;
	}
	.welcome-console::after {
		right: 0;
		width: 24px;
	}
	.welcome-grid {
		display: grid;
		grid-template-columns: minmax(300px, 1.3fr) minmax(260px, 0.8fr);
		gap: clamp(2rem, 7vw, 6rem);
		align-items: end;
	}
	.welcome-intro {
		min-width: 0;
	}
	.welcome-title {
		width: min(100%, 24rem);
	}
	.welcome-rule {
		width: min(100%, 380px);
		height: 1px;
		margin-top: 1.8rem;
		background: linear-gradient(90deg, var(--color-accent), var(--color-border) 42%, transparent);
	}
	.welcome-actions {
		padding-bottom: 0.2rem;
	}
	.welcome-action {
		display: flex;
		width: 100%;
		min-height: 48px;
		align-items: center;
		gap: 0.75rem;
		border: 1px solid var(--color-border);
		border-bottom: 0;
		background: var(--color-bg-1);
		padding: 0.6rem 0.75rem;
		text-align: left;
		color: var(--color-fg);
	}
	.welcome-action:last-child {
		border-bottom: 1px solid var(--color-border);
	}
	.welcome-action:hover {
		border-color: var(--color-accent-dim);
		background: var(--color-bg-2);
	}
	.welcome-action-secondary {
		color: var(--color-fg-muted);
	}
	.welcome-action-icon {
		display: grid;
		width: 28px;
		height: 28px;
		place-items: center;
		border-right: 1px solid var(--color-border);
		color: var(--color-accent);
	}
	.welcome-action kbd {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--color-fg-dim);
	}
	.welcome-shortcuts {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 1px;
		margin-top: clamp(2.5rem, 6vw, 5rem);
		background: var(--color-border);
	}
	.welcome-shortcuts > div {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 0.2rem;
		background: var(--color-bg);
		padding: 0.65rem 0.75rem;
	}
	.welcome-shortcuts kbd {
		color: var(--color-accent);
	}
	.welcome-shortcuts span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--color-fg-dim);
	}
	@media (max-width: 920px) {
		.welcome-grid {
			grid-template-columns: 1fr;
			gap: 2.5rem;
		}
		.welcome-intro {
			max-width: 34rem;
		}
		.welcome-actions {
			max-width: 30rem;
		}
	}
	@media (max-width: 520px) {
		.welcome-shell {
			overflow-y: auto;
			align-items: safe center;
			align-items: flex-start;
			padding-inline: 1.5rem;
			padding-top: 2.25rem;
			overflow-y: auto;
		}
		.welcome-console {
			padding-inline: 1rem;
		}
		.welcome-shortcuts {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
		.welcome-shortcuts span {
			white-space: normal;
			overflow-wrap: anywhere;
		}
	}
</style>
