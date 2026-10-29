<script lang="ts">
	import '../app.css';
	import { t } from '#lib/i18n/index.js';

	let { children } = $props();
</script>

<!-- Reactive skip link (i18n): replaces the hardcoded one in app.html so it
     follows the locale. Remains the first focusable element on the page. -->
<a href="#main" class="skip-link">{t('common.skipToContent')}</a>
{@render children()}
