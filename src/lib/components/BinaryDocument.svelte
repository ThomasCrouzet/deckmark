<script lang="ts">
	import type { FileItem } from '#lib/types.js';
	import ImageDocument from './ImageDocument.svelte';
	import PdfDocument from './PdfDocument.svelte';

	let { file, kind }: { file: FileItem; kind: 'image' | 'pdf' } = $props();
</script>

{#if kind === 'image'}
	<ImageDocument {file} />
{:else}
	<PdfDocument {file} />
{/if}
