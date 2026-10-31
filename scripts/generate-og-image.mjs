#!/usr/bin/env node
/**
 * Create the Open Graph SVG and its 1200x630 PNG from the canonical DeckMark logo.
 *
 * Use the locked Playwright package and its installed Chromium browser.
 * See generate-brand-assets.mjs for requirements and the card layout.
 * Run: node scripts/generate-og-image.mjs [--check]
 */
import { generateBrandAssets } from './generate-brand-assets.mjs';

if (process.argv.slice(2).some((argument) => argument !== '--check')) {
	throw new Error('Usage: node scripts/generate-og-image.mjs [--check]');
}
await generateBrandAssets({
	ogOnly: true,
	check: process.argv.includes('--check')
});
