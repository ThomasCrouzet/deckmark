<script lang="ts">
	import { asset } from '$app/paths';
	import { t } from '#lib/i18n/index.js';
</script>

<span class="brand-logo" role="img" aria-label={t('brand.name')}>
	<img class="brand-logo-dark" src={asset('brand/logo-dark.svg')} alt="" aria-hidden="true" />

	<img class="brand-logo-light" src={asset('brand/logo-light.svg')} alt="" aria-hidden="true" />
</span>

<style>
	.brand-logo {
		display: block;
		width: 100%;
		max-width: 100%;
	}

	img {
		display: block;
		width: 100%;
		height: auto;
	}

	.brand-logo-light {
		display: none;
	}

	/* The app resolves light, dark, and system preferences on the root element. */
	:global(:root[data-theme='light']) .brand-logo-dark {
		display: none;
	}

	:global(:root[data-theme='light']) .brand-logo-light {
		display: block;
	}
</style>
