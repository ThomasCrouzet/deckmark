<script lang="ts">
	import {
		FilePlus,
		Upload,
		Compass,
		FolderOpen,
		Presentation,
		FileText,
		ShieldCheck,
		Download,
		ExternalLink
	} from '@lucide/svelte';
	import { isDesktop } from '#lib/desktop.js';
	import { keyboardStore } from '#lib/ui/keyboard.svelte.js';
	import { t } from '#lib/i18n/index.js';
	import BrandLogo from './BrandLogo.svelte';
	import SiteFooter from './SiteFooter.svelte';

	interface Props {
		onNew: () => void;
		onImport: () => void;
		onDemo: () => void;
		onLibrary?: () => void;
		onNewPresentation?: (() => void) | undefined;
		documentCount?: number;
		/** True once the saved library has loaded, so the first-visit view never flashes for a returning user. */
		libraryReady?: boolean;
	}

	let {
		onNew,
		onImport,
		onDemo,
		onLibrary,
		onNewPresentation,
		documentCount = 0,
		libraryReady = false
	}: Props = $props();

	// First visit: the library has loaded and holds no document. A returning user
	// never sees the introduction.
	const firstVisit = $derived(libraryReady && documentCount === 0);
	// The desktop app has no use for a link to its own installers.
	const showDesktopLink = !isDesktop();
	// Installers live on the `desktop-v<version>` pre-releases, not on the stable release.
	const DESKTOP_RELEASES_URL =
		'https://github.com/ThomasCrouzet/deckmark/releases?q=desktop&expanded=true';
	const GITHUB_URL = 'https://github.com/ThomasCrouzet/deckmark';
</script>

<div
	class="welcome-shell flex h-full flex-col items-center px-6 py-10 sm:px-10 lg:px-[8vw]"
	class:welcome-shell-first={firstVisit}
>
	<section
		class="welcome-console my-auto w-full max-w-4xl"
		class:welcome-first-visit={firstVisit}
		aria-labelledby="welcome-title"
	>
		<div class="welcome-grid">
			<div class="welcome-intro">
				<div class="mdsh-kicker mb-5">
					{firstVisit ? t('landing.kicker') : t('welcome.systemLabel')}
				</div>
				<h1 id="welcome-title" class="welcome-title">
					<span class="welcome-brand"><BrandLogo /></span>
					<span class="welcome-title-text">{t('welcome.titleText')}</span>
				</h1>
				<div class="welcome-rule" aria-hidden="true"></div>
				{#if firstVisit}
					<p class="mt-6 max-w-md text-base leading-relaxed text-fg-muted">
						{t('landing.lead')}
					</p>
					<ul class="welcome-facts" aria-label={t('landing.factsLabel')}>
						<li>{t('landing.factNoAccount')}</li>
						<li>{t('landing.factOffline')}</li>
						<li>{t('landing.factOpenSource')}</li>
					</ul>
				{:else}
					<p class="mt-6 max-w-md text-base leading-relaxed text-fg-muted">
						{t('welcome.tagline')}
					</p>
					<p class="mt-3 max-w-md font-mono text-[11px] uppercase tracking-[0.08em] text-fg-subtle">
						{t('welcome.privacy')}
					</p>
					<p class="mt-3 max-w-md text-xs text-fg-muted">
						{t('welcome.persistence')}
					</p>
				{/if}
			</div>

			<div class="welcome-actions">
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
				<button
					data-testid="welcome-new"
					class="welcome-action welcome-action-primary"
					onclick={onNew}
				>
					<span class="welcome-action-icon"><FilePlus size={16} /></span>
					<span class="flex-1">{t('welcome.newFile')}</span>
					<kbd>{keyboardStore.label('new') ?? ''}</kbd>
				</button>
				{#if onNewPresentation}
					<button
						data-testid="welcome-new-presentation"
						class="welcome-action welcome-action-secondary"
						onclick={onNewPresentation}
					>
						<span class="welcome-action-icon"><Presentation size={16} /></span>
						<span class="flex-1">{t('welcome.newPresentation')}</span>
					</button>
				{/if}
				<button
					data-testid="welcome-demo"
					class="welcome-action welcome-action-secondary"
					onclick={onDemo}
				>
					<span class="welcome-action-icon"><Compass size={16} /></span>
					<span class="flex-1">{t('welcome.openDemo')}</span>
				</button>
				<button
					data-testid="welcome-import"
					class="welcome-action welcome-action-secondary"
					onclick={onImport}
				>
					<span class="welcome-action-icon"><Upload size={16} /></span>
					<span class="flex-1">{t('welcome.importMd')}</span>
					<kbd>{keyboardStore.label('import') ?? ''}</kbd>
				</button>
				{#if firstVisit}
					<div class="welcome-links">
						{#if showDesktopLink}
							<a
								class="welcome-link"
								data-testid="welcome-desktop-link"
								href={DESKTOP_RELEASES_URL}
								target="_blank"
								rel="noopener noreferrer"
								aria-describedby="welcome-desktop-hint"
							>
								<Download size={14} aria-hidden="true" />
								<span>{t('landing.desktopLink')}</span>
							</a>
							<span id="welcome-desktop-hint" class="sr-only">{t('landing.desktopHint')}</span>
						{/if}
						<a
							class="welcome-link"
							data-testid="welcome-github-link"
							href={GITHUB_URL}
							target="_blank"
							rel="noopener noreferrer"
						>
							<ExternalLink size={14} aria-hidden="true" />
							<span>{t('landing.githubLink')}</span>
						</a>
					</div>
				{/if}
			</div>
		</div>

		{#if firstVisit}
			<div class="welcome-pitch">
				<!-- Decorative preview built from markup and theme tokens. It makes no request. -->
				<div class="welcome-preview" aria-hidden="true">
					<div class="welcome-preview-pane welcome-preview-source">
						<div class="welcome-preview-tab">{t('landing.previewNotes')}</div>
						<div class="welcome-preview-code">
							<span class="tok-h"># {t('landing.previewHeading')}</span>
							<span>&nbsp;</span>
							<span>- [x] {t('landing.previewItemOne')}</span>
							<span>- [ ] {t('landing.previewItemTwo')}</span>
							<span>&nbsp;</span>
							<span class="tok-link">[[{t('landing.previewDeck')}]]</span>
						</div>
					</div>
					<div class="welcome-preview-pane welcome-preview-deck">
						<div class="welcome-preview-tab">{t('landing.previewDeck')}</div>
						<div class="welcome-preview-slide">
							<span class="welcome-preview-slide-title">{t('landing.previewHeading')}</span>
							<span class="welcome-preview-rule"></span>
							<span class="welcome-preview-bullet">{t('landing.previewItemOne')}</span>
							<span class="welcome-preview-bullet">{t('landing.previewItemTwo')}</span>
						</div>
					</div>
				</div>

				<section class="welcome-features" aria-label={t('landing.featuresLabel')}>
					<article>
						<h2><FileText size={15} aria-hidden="true" />{t('landing.notesTitle')}</h2>
						<p>{t('landing.notesText')}</p>
					</article>
					<article>
						<h2><Presentation size={15} aria-hidden="true" />{t('landing.slidesTitle')}</h2>
						<p>{t('landing.slidesText')}</p>
					</article>
					<article>
						<h2><ShieldCheck size={15} aria-hidden="true" />{t('landing.privateTitle')}</h2>
						<p>{t('landing.privateText')}</p>
					</article>
				</section>
			</div>
		{:else}
			<!-- §B4.2 - text-xs (12 px) rather than text-[10px]: 10 px fails the
			     default legibility criteria. fg-muted reaches 5:1 on a dark background. -->
			<div class="welcome-shortcuts font-mono text-xs text-fg-muted">
				<div>
					<kbd>{keyboardStore.label('export-md') ?? ''}</kbd><span>
						{t('welcome.legendExport')}
					</span>
				</div>
				<div>
					<kbd>
						{keyboardStore.label('mode-wysiwyg') ?? ''} / {keyboardStore.label('mode-read') ?? ''} / {keyboardStore.label(
							'mode-source'
						) ?? ''}
					</kbd><span>{t('welcome.legendModes')}</span>
				</div>
				<div>
					<kbd>{keyboardStore.label('sidebar') ?? ''}</kbd><span>{t('welcome.legendPanel')}</span>
				</div>
				<div>
					<kbd>{keyboardStore.label('close-file') ?? ''}</kbd><span>
						{t('welcome.legendCloseTab')}
					</span>
				</div>
			</div>
		{/if}
	</section>

	<SiteFooter class="{firstVisit ? 'mt-auto pt-8' : 'mt-8'} w-full max-w-4xl shrink-0" />
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
		min-width: 0;
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
	.welcome-brand {
		display: block;
	}
	/* §750 - The heading carries real text. The logo stays the visual brand
	   mark above the text. */
	.welcome-title-text {
		display: block;
		margin-top: 1rem;
		font-size: clamp(1.05rem, 2.4vw, 1.3rem);
		font-weight: 500;
		line-height: 1.3;
		color: var(--color-fg);
	}
	.welcome-rule {
		width: min(100%, 380px);
		height: 1px;
		margin-top: 1.8rem;
		background: linear-gradient(90deg, var(--color-accent), var(--color-border) 42%, transparent);
	}
	.welcome-actions {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding-bottom: 0.2rem;
	}
	.welcome-action {
		display: flex;
		width: 100%;
		min-height: 48px;
		align-items: center;
		gap: 0.75rem;
		border: 1px solid var(--color-border);
		background: var(--color-bg-1);
		padding: 0.6rem 0.75rem;
		text-align: left;
		color: var(--color-fg);
	}
	/* The happy path is the filled accent. On the dark theme the on-accent text
	   keeps the 7.23:1 amber ratio; the light theme resolves its own pair. */
	.welcome-action-primary {
		border-color: var(--color-accent);
		background: var(--color-accent);
		color: var(--color-on-accent);
		font-weight: 600;
	}
	.welcome-action-primary .welcome-action-icon {
		border-right-color: color-mix(in oklab, var(--color-on-accent) 28%, transparent);
		color: var(--color-on-accent);
	}
	.welcome-action:hover {
		border-color: var(--color-accent-dim);
		background: var(--color-bg-2);
	}
	.welcome-action-primary:hover {
		border-color: var(--color-focus);
		background: var(--color-focus);
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
	/* The hint on the filled accent uses the on-accent color at full strength.
	   It must follow the base kbd rule above: both rules have the same specificity. */
	.welcome-action-primary kbd {
		color: var(--color-on-accent);
	}
	/* First visit. The introduction reuses the console frame, the amber rule and the
	   square bordered panels of the returning-user view. Every color is a theme token. */
	.welcome-facts {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin: 1.1rem 0 0;
		padding: 0;
		list-style: none;
	}
	.welcome-facts li {
		border: 1px solid var(--color-border);
		background: var(--color-bg-1);
		padding: 0.2rem 0.55rem;
		font-family: var(--font-mono);
		font-size: 11px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--color-fg-muted);
	}
	.welcome-links {
		display: flex;
		flex-wrap: wrap;
		gap: 0 1rem;
	}
	.welcome-link {
		display: inline-flex;
		min-height: 44px;
		align-items: center;
		gap: 0.5rem;
		padding: 0 0.75rem;
		font-size: 13px;
		color: var(--color-fg-muted);
		text-decoration: underline;
		text-decoration-color: var(--color-border-strong);
		text-underline-offset: 4px;
	}
	.welcome-link:hover {
		color: var(--color-accent);
		text-decoration-color: var(--color-accent);
	}
	.welcome-shell-first {
		padding-block: 1.5rem;
	}
	/* The first-visit content sits near the top of the window. The free space goes
	   between the content and the footer, so a tall window does not push the
	   actions down. */
	.welcome-first-visit {
		margin-bottom: auto;
		padding-top: clamp(1.25rem, 2.5vw, 2rem);
	}
	@media (min-width: 921px) {
		.welcome-first-visit {
			margin-top: clamp(0.5rem, 3vh, 2rem);
		}
	}
	.welcome-pitch {
		display: flex;
		flex-direction: column;
		gap: clamp(1.5rem, 3vw, 2.25rem);
		margin-top: clamp(1.75rem, 4vw, 2.75rem);
		border-top: 1px solid var(--color-border);
		padding-top: clamp(1.25rem, 3vw, 1.75rem);
	}
	.welcome-preview {
		display: grid;
		width: 100%;
		max-width: 36rem;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		border: 1px solid var(--color-border-strong);
		background: var(--color-bg-1);
		user-select: none;
	}
	.welcome-preview-pane {
		min-width: 0;
	}
	.welcome-preview-source {
		border-right: 1px solid var(--color-border);
	}
	.welcome-preview-tab {
		border-bottom: 1px solid var(--color-border);
		padding: 0.35rem 0.7rem;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--color-fg-dim);
	}
	.welcome-preview-code {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		padding: 0.85rem 0.7rem 1rem;
		font-family: var(--font-mono);
		font-size: 12px;
		line-height: 1.45;
		color: var(--color-fg-muted);
		overflow-wrap: anywhere;
	}
	.welcome-preview-code .tok-h {
		color: var(--color-accent);
		font-weight: 600;
	}
	.welcome-preview-code .tok-link {
		color: var(--color-accent);
		text-decoration: underline;
		text-decoration-color: var(--color-border-strong);
		text-underline-offset: 3px;
	}
	.welcome-preview-deck {
		display: flex;
		flex-direction: column;
	}
	.welcome-preview-slide {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: 0.45rem;
		margin: 0.75rem;
		border: 1px solid var(--color-border-strong);
		background: var(--color-bg);
		padding: 0.9rem 0.85rem;
		aspect-ratio: 16 / 9;
		min-height: 8.5rem;
	}
	.welcome-preview-slide-title {
		font-size: 1.05rem;
		font-weight: 600;
		line-height: 1.2;
		color: var(--color-fg);
	}
	.welcome-preview-rule {
		width: 2.5rem;
		height: 2px;
		background: var(--color-accent);
	}
	.welcome-preview-bullet {
		position: relative;
		padding-left: 0.9rem;
		font-size: 12px;
		line-height: 1.35;
		color: var(--color-fg-muted);
	}
	.welcome-preview-bullet::before {
		content: '';
		position: absolute;
		top: 0.5em;
		left: 0;
		width: 5px;
		height: 5px;
		background: var(--color-accent);
	}
	.welcome-features {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 1.25rem clamp(1.25rem, 3vw, 2.25rem);
	}
	.welcome-features h2 {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin: 0 0 0.25rem;
		font-size: 0.95rem;
		font-weight: 600;
		line-height: 1.3;
		color: var(--color-fg);
	}
	.welcome-features h2 :global(svg) {
		flex-shrink: 0;
		color: var(--color-accent);
	}
	.welcome-features p {
		margin: 0;
		padding-left: calc(15px + 0.5rem);
		font-size: 13px;
		line-height: 1.5;
		color: var(--color-fg-muted);
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
	@media (max-width: 768px) {
		/* Shortcut chips are hidden below this width (see app.css), so the legend
		   would show labels without keys. */
		.welcome-shortcuts {
			display: none;
		}
	}
	/* The preview is decoration. A short wide window keeps the actions and the
	   three points in the first screen, so it drops the preview. */
	@media (min-width: 921px) and (max-height: 1000px) {
		.welcome-preview {
			display: none;
		}
	}
	@media (min-width: 921px) and (max-height: 860px) {
		.welcome-shell-first {
			padding-block: 1rem;
		}
		.welcome-first-visit {
			padding-top: 1.25rem;
		}
		.welcome-pitch {
			margin-top: 1.25rem;
		}
	}
	@media (max-width: 920px) {
		.welcome-features {
			grid-template-columns: minmax(0, 1fr);
		}
		.welcome-grid {
			grid-template-columns: minmax(0, 1fr);
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
		.welcome-preview {
			display: none;
		}
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
	@media (max-width: 240px) {
		.welcome-shell,
		.welcome-console {
			padding-inline: 8px;
		}
		.welcome-console {
			overflow-wrap: anywhere;
		}
		.welcome-action {
			flex-wrap: wrap;
			gap: 8px;
			padding: 8px;
		}
		.welcome-action > .flex-1 {
			min-width: 0;
			flex-basis: calc(100% - 36px);
		}
		.welcome-action-icon {
			flex-shrink: 0;
		}
	}
</style>
