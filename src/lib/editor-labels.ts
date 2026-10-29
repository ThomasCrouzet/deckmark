import { t } from '#lib/i18n/index.js';

function headingLabel(level: number): string {
	// Crepe searches the label text. Keep both aliases in each translated label.
	return `${t('editor.heading', { n: level })} (/h${level}, /t${level})`;
}

export function blockEditLabels() {
	return {
		textGroup: {
			label: t('editor.text'),
			text: { label: t('editor.text') },
			h1: { label: headingLabel(1) },
			h2: { label: headingLabel(2) },
			h3: { label: headingLabel(3) },
			h4: { label: headingLabel(4) },
			h5: { label: headingLabel(5) },
			h6: { label: headingLabel(6) },
			quote: { label: t('editor.quote') },
			divider: { label: t('editor.divider') }
		},
		listGroup: {
			label: t('editor.lists'),
			bulletList: { label: t('editor.bulletList') },
			orderedList: { label: t('editor.orderedList') },
			taskList: { label: t('editor.taskList') }
		},
		advancedGroup: {
			label: t('editor.advanced'),
			image: { label: t('editor.image') },
			codeBlock: { label: t('editor.codeBlock') },
			table: { label: t('editor.table') },
			math: { label: t('editor.math') }
		}
	};
}

export function toolbarLabels() {
	return {
		boldLabel: t('editor.bold'),
		italicLabel: t('editor.italic'),
		codeLabel: t('editor.codeBlock'),
		linkLabel: t('editor.link'),
		strikethroughLabel: t('editor.strikethrough'),
		latexLabel: t('editor.math')
	};
}
