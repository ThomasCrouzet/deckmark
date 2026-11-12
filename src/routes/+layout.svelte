<script lang="ts">
	import { onMount } from 'svelte';
	import '../app.css';
	import { t } from '#lib/i18n/index.js';

	let { children } = $props();

	// Publish the available-touch capability once for the whole document.
	// `any-pointer` keeps touch sizing on a hybrid device whose primary
	// pointer is a trackpad or mouse. The attribute lets the shared CSS and
	// the component styles agree on one policy.
	onMount(() => {
		if (typeof window.matchMedia !== 'function') return;
		const query = window.matchMedia('(any-pointer: coarse)');
		const update = () => {
			if (query.matches) document.documentElement.dataset.touchCapable = 'true';
			else delete document.documentElement.dataset.touchCapable;
		};
		update();
		query.addEventListener('change', update);
		return () => query.removeEventListener('change', update);
	});
</script>

<!-- Reactive skip link (i18n): replaces the hardcoded one in app.html so it
     follows the locale. Remains the first focusable element on the page. -->
<a href="#main" class="skip-link">{t('common.skipToContent')}</a>
{@render children()}
