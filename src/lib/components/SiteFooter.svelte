<script lang="ts">
	import { t } from '#lib/i18n/index.js';

	interface Props {
		class?: string;
	}

	let { class: className = '' }: Props = $props();
</script>

<!-- §715 - Outbound links of the home state. The static shell in `app.html`
     carries the same four links; change both lists together. -->
<nav class="site-footer {className}" aria-label={t('site.footerLabel')}>
	<ul>
		<li>
			<a
				href="https://github.com/ThomasCrouzet/deckmark/tree/main/docs"
				target="_blank"
				rel="noopener noreferrer"
			>
				{t('site.footerDocs')}
			</a>
		</li>
		<li>
			<a href="https://github.com/ThomasCrouzet/deckmark" target="_blank" rel="noopener noreferrer">
				{t('site.footerGitHub')}
			</a>
		</li>
		<li>
			<a
				href="https://github.com/ThomasCrouzet/deckmark/issues"
				target="_blank"
				rel="noopener noreferrer"
			>
				{t('site.footerIssue')}
			</a>
		</li>
		<li>
			<a
				href="https://github.com/ThomasCrouzet/deckmark/blob/main/docs/EDITIONS.md"
				target="_blank"
				rel="noopener noreferrer"
			>
				{t('site.footerEditions')}
			</a>
		</li>
	</ul>
</nav>

<style>
	.site-footer {
		width: 100%;
		border-top: 1px solid var(--color-border);
	}

	ul {
		display: flex;
		flex-wrap: wrap;
		gap: 0 1.25rem;
		margin: 0;
		padding: 0.25rem 0 0;
		list-style: none;
	}

	a {
		display: inline-flex;
		min-height: 44px;
		align-items: center;
		font-size: 13px;
		color: var(--color-fg-muted);
		text-decoration: none;
	}

	a:hover {
		color: var(--color-accent);
	}
</style>
