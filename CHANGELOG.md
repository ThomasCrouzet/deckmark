# Changelog

Toutes les évolutions notables de **mdsh** sont documentées ici.

Format basé sur [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/),
versionnement [SemVer](https://semver.org/lang/fr/).

## [2.1.0](https://github.com/ThomasCrouzet/mdsh/compare/v2.0.4...v2.1.0) (2026-10-31)


### Features

* add offline Markdown presentation editor ([#172](https://github.com/ThomasCrouzet/mdsh/issues/172)) ([da97e8d](https://github.com/ThomasCrouzet/mdsh/commit/da97e8dc558630e7b3805ddf73a429757bf07d14))

## [2.0.4](https://github.com/ThomasCrouzet/mdsh/compare/v2.0.3...v2.0.4) (2026-10-29)


### Bug Fixes

* **ci:** stabilize the draft save check and the Windows source step ([#170](https://github.com/ThomasCrouzet/mdsh/issues/170)) ([de38eee](https://github.com/ThomasCrouzet/mdsh/commit/de38eeed3cd60bbaee629f03aa8e45742ddf3e65))

## [2.0.3](https://github.com/ThomasCrouzet/mdsh/compare/v2.0.2...v2.0.3) (2026-10-29)


### Bug Fixes

* **deps:** migrate to SvelteKit 3 ([#166](https://github.com/ThomasCrouzet/mdsh/issues/166)) ([2fc5ff6](https://github.com/ThomasCrouzet/mdsh/commit/2fc5ff655be73a8dd9418945247c1db671c87059))
* single-click outline navigation and Tab indentation ([#169](https://github.com/ThomasCrouzet/mdsh/issues/169)) ([8bd117d](https://github.com/ThomasCrouzet/mdsh/commit/8bd117daf79d14d0844ea03a06408129c388ce65))

## [2.0.2](https://github.com/ThomasCrouzet/mdsh/compare/v2.0.1...v2.0.2) (2026-10-26)


### Bug Fixes

* **ci:** preserve desktop source validation ([5aa571e](https://github.com/ThomasCrouzet/mdsh/commit/5aa571e59b06406fcb4e4cc69362a8cdfd69d35f))
* patch vulnerable test and serialization dependencies ([#161](https://github.com/ThomasCrouzet/mdsh/issues/161)) ([a53d21d](https://github.com/ThomasCrouzet/mdsh/commit/a53d21d6bfa6aea8f99c6fd0a66038c32ff6cf6c))
* update DOMPurify security patch ([4a12a7b](https://github.com/ThomasCrouzet/mdsh/commit/4a12a7b576be138f8dac78df97cdb6c1fd7bd02b))

## [2.0.1](https://github.com/ThomasCrouzet/mdsh/compare/v2.0.0...v2.0.1) (2026-10-10)


### Bug Fixes

* **ui:** correct saved status and stabilize search controls ([6e3a88b](https://github.com/ThomasCrouzet/mdsh/commit/6e3a88b9b9e6f43a43f32965e47501425ab81c1c))

## [2.0.0](https://github.com/ThomasCrouzet/mdsh/compare/v1.9.0...v2.0.0) (2026-10-10)


### ⚠ BREAKING CHANGES

* Backups now use schema 2. Version 1.9 cannot restore schema 2. Version 2.0 still restores schema 1.

### Features

* add portable projects and review workflows ([86698e7](https://github.com/ThomasCrouzet/mdsh/commit/86698e7f4f8d736ec0641a507c8959d1211f65e3)), closes [#134](https://github.com/ThomasCrouzet/mdsh/issues/134)

## [1.9.0](https://github.com/ThomasCrouzet/mdsh/compare/v1.8.1...v1.9.0) (2026-10-09)


### Features

* improve editing tools and update dependencies ([2eed37f](https://github.com/ThomasCrouzet/mdsh/commit/2eed37f48c912b2cf889eb9939886235a39aa31b))


### Bug Fixes

* enforce durable saves and cancellable exports ([edf9e0f](https://github.com/ThomasCrouzet/mdsh/commit/edf9e0f5d480ede0385f65704ac1191222c55a94))
* keep toolbar controls stable during offline setup ([811b65c](https://github.com/ThomasCrouzet/mdsh/commit/811b65c2af4b649b8c51b15fa322463a98f2e419))
* update vulnerable browser dependencies ([7229542](https://github.com/ThomasCrouzet/mdsh/commit/72295427362b07dcb6ba36b3c9b4d80a6faf419d))

## [1.8.1](https://github.com/ThomasCrouzet/mdsh/compare/v1.8.0...v1.8.1) (2026-09-25)


### Bug Fixes

* repair PDF export and editor workflows ([b49a577](https://github.com/ThomasCrouzet/mdsh/commit/b49a5778d3178af6304e3917e2aaeba619cff955))
* respect browser keyboard platforms ([9f682b5](https://github.com/ThomasCrouzet/mdsh/commit/9f682b58789e34eb5062a465dd79a14c7bd2c171))
* restore PDF export and editor consistency ([8c0090a](https://github.com/ThomasCrouzet/mdsh/commit/8c0090addc97f93fad06d5d7deefba6967c1fafb))

## [1.8.0](https://github.com/ThomasCrouzet/mdsh/compare/v1.7.0...v1.8.0) (2026-09-24)


### Features

* add bulk document actions and refresh the mdsh identity ([57cc500](https://github.com/ThomasCrouzet/mdsh/commit/57cc5004d19cf2a01289a4a2d3d665fe8b55200d))
* add bulk document actions and refresh the mdsh identity ([eaafe7a](https://github.com/ThomasCrouzet/mdsh/commit/eaafe7a2335050b8709a8e2a203f8a3e47a95131))

## [1.7.0](https://github.com/ThomasCrouzet/mdsh/compare/v1.6.0...v1.7.0) (2026-09-22)


### Features

* keep library links and improve writing tools ([19db926](https://github.com/ThomasCrouzet/mdsh/commit/19db92634b15d7965b771fb0731dd2ed0702f3a8))
* keep library links and improve writing tools ([d7e2bbe](https://github.com/ThomasCrouzet/mdsh/commit/d7e2bbe69e02a16018ad1cb851a72635ea4029b9))

## [1.6.0](https://github.com/ThomasCrouzet/mdsh/compare/v1.5.4...v1.6.0) (2026-09-22)


### Features

* keep disk links and add workspace file navigation ([73cc9a9](https://github.com/ThomasCrouzet/mdsh/commit/73cc9a9eadc2f688e1b06d666ed62735afcd4ddc))
* restore disk access and add workspace navigation ([43e3ded](https://github.com/ThomasCrouzet/mdsh/commit/43e3ded218220da38ead4f38089fa06029c77000))

## [1.5.4](https://github.com/ThomasCrouzet/mdsh/compare/v1.5.3...v1.5.4) (2026-09-16)


### Bug Fixes

* **render:** keep the Mermaid 11 layout and look ([35b741b](https://github.com/ThomasCrouzet/mdsh/commit/35b741b6d5aad02e9319a6be59034e7ee0c921f9))

## [1.5.3](https://github.com/ThomasCrouzet/mdsh/compare/v1.5.2...v1.5.3) (2026-09-16)


### Bug Fixes

* update sharp to the patched version ([659117e](https://github.com/ThomasCrouzet/mdsh/commit/659117e885209ab5a7279274821b8ebbf2a92d4c))
* update sharp to the patched version ([7091a91](https://github.com/ThomasCrouzet/mdsh/commit/7091a9186faf0b8ddeea87bcec7ec259dcfbacf4))

## [1.5.2](https://github.com/ThomasCrouzet/mdsh/compare/v1.5.1...v1.5.2) (2026-09-08)


### Bug Fixes

* clear the old disk link before changing targets ([7612118](https://github.com/ThomasCrouzet/mdsh/commit/76121181028ec37ecda9d0093dd9f18280d1ff3e))
* flush editor content before saving to disk ([1a93f0c](https://github.com/ThomasCrouzet/mdsh/commit/1a93f0cdac4cf8dbc066673902e8ebadc8356ed4))
* keep benchmark errors out of HTTP responses ([d4e653c](https://github.com/ThomasCrouzet/mdsh/commit/d4e653c134d11f5fc7e4fb7324d0ec52f6889d44))
* protect draft state and disk saves ([2f64fd1](https://github.com/ThomasCrouzet/mdsh/commit/2f64fd117d173a33a4fabed6bf570873145f4e9e))
* protect draft state and disk saves ([335c106](https://github.com/ThomasCrouzet/mdsh/commit/335c106f7b7ef998eb9bbf57fba2b953b9cbcdee))
* sync disk names and reopen linked files ([#79](https://github.com/ThomasCrouzet/mdsh/issues/79)) ([7aec530](https://github.com/ThomasCrouzet/mdsh/commit/7aec5309e3821f6bdfee55e0691f5028fdfda7d7))
* sync disk names and restore safe reopen revisions ([32787a3](https://github.com/ThomasCrouzet/mdsh/commit/32787a3be1401ce503702f9dbf31d5e7e6b4dede))

## [1.5.1](https://github.com/ThomasCrouzet/mdsh/compare/v1.5.0...v1.5.1) (2026-09-06)


### Bug Fixes

* use English project text and social preview ([69b73f8](https://github.com/ThomasCrouzet/mdsh/commit/69b73f869dde6240f8ad65ddf6e228270284b7cd))
* use English text in the social preview image ([3f346bf](https://github.com/ThomasCrouzet/mdsh/commit/3f346bff7397f4435ab7afca18e0f13e6f676d73))

## [1.5.0](https://github.com/ThomasCrouzet/mdsh/compare/v1.4.0...v1.5.0) (2026-09-03)


### Features

* fiabiliser les documents, les exports et les clients ([bb03f2f](https://github.com/ThomasCrouzet/mdsh/commit/bb03f2f2bb12ab68cce65175d9ef62476cdfd773))


### Bug Fixes

* **ci:** corriger le heredoc de publication desktop ([a835861](https://github.com/ThomasCrouzet/mdsh/commit/a8358619b40578966a9a8db1e2ada4b947df0442))
* **ci:** préserver les fins de ligne du patch glib sous Windows ([01119dd](https://github.com/ThomasCrouzet/mdsh/commit/01119dd640906e23e4e7b050a174fd4cb2706949))
* conserver les demandes de fermeture pendant le rechargement ([800e8ee](https://github.com/ThomasCrouzet/mdsh/commit/800e8eefe7a247f91e0a91081b6702ffdec6a4bc))
* **pdf:** conserver les polices et le centrage des images ([d2ab736](https://github.com/ThomasCrouzet/mdsh/commit/d2ab7360ceebf2939d95b042df13a3f9c6064b2e))
* **pdf:** éviter les césures ambiguës dans les références ([ee93463](https://github.com/ThomasCrouzet/mdsh/commit/ee9346367c7fcfdc0ccef551c69322bdbe8ca457))
* préserver les diagrammes et les écritures Windows ([76ad8b1](https://github.com/ThomasCrouzet/mdsh/commit/76ad8b1893fd23d45bd1cd9c84c72a5baaa7ebde))
* préserver les PDF et corriger les alertes de sécurité ([f24b6da](https://github.com/ThomasCrouzet/mdsh/commit/f24b6dac5e1645550216afdf68c8edad7f9c0c20))
* protéger le démarrage et fiabiliser les tests natifs ([c5c75d0](https://github.com/ThomasCrouzet/mdsh/commit/c5c75d07264dea285f155de64d7b7c5141c1407d))
* **security:** backporter le correctif glib VariantStrIter ([75995d7](https://github.com/ThomasCrouzet/mdsh/commit/75995d7aa57e62eac641651a5dc684814f111560))
* **security:** borner les échappements des images Markdown ([0188fa0](https://github.com/ThomasCrouzet/mdsh/commit/0188fa03da85ea162b55b041c500d4bda536c6e3))
* **security:** documenter le backport glib dans le SBOM Cargo ([2738455](https://github.com/ThomasCrouzet/mdsh/commit/273845599b670e99502a6b7c31b715c8d32647a1))
* **test:** attendre la disponibilité de la fenêtre native ([c898890](https://github.com/ThomasCrouzet/mdsh/commit/c898890c0087077ab393fdea6415fce91d33e888))
* **test:** synchroniser les commandes après un rechargement natif ([1ee717d](https://github.com/ThomasCrouzet/mdsh/commit/1ee717d845d1ab64878aed355eb0e7f5fe122afb))

## [1.4.0](https://github.com/ThomasCrouzet/mdsh/compare/v1.3.1...v1.4.0) (2026-08-21)


### Features

* harden offline workflows and desktop file access ([36abdcd](https://github.com/ThomasCrouzet/mdsh/commit/36abdcdbedf15eb1d808357627758a83b0e2e3d5))


### Bug Fixes

* **ci:** use supported CodeQL mode for Rust ([ce0aafa](https://github.com/ThomasCrouzet/mdsh/commit/ce0aafa362a54a68c2ca36f198a93e12af30017c))

## [1.3.1](https://github.com/ThomasCrouzet/mdsh/compare/v1.3.0...v1.3.1) (2026-08-14)


### Bug Fixes

* **ci:** keep release-please notes when uploading desktop assets ([1b65aef](https://github.com/ThomasCrouzet/mdsh/commit/1b65aef8e8ee1e3e28289d815cfb8f55e7ba514c))
* **ci:** pass CHANGELOG body and release id to tauri-action ([9eaa0f5](https://github.com/ThomasCrouzet/mdsh/commit/9eaa0f51abdb373e7a621be20e4163f778ca1d44))
* **ci:** resolve desktop release notes outside the Windows matrix ([9429e2f](https://github.com/ThomasCrouzet/mdsh/commit/9429e2f88e5b0bb05c4ac0d38623ad3d7b0aa5c6))

## [1.3.0](https://github.com/ThomasCrouzet/mdsh/compare/v1.2.3...v1.3.0) (2026-08-14)


### Features

* redesign workspace with BLACKSITE shell ([4d56996](https://github.com/ThomasCrouzet/mdsh/commit/4d56996b39c3a37b267034fcd919ec7e8afc8cc8))


### Bug Fixes

* **deps:** mettre à jour brace-expansion ([dcdfad1](https://github.com/ThomasCrouzet/mdsh/commit/dcdfad120fdbaadb8c5531d85ebf0b259fae7a76))
* **deps:** override postcss nanoid to 3.3.18 ([ebdb71d](https://github.com/ThomasCrouzet/mdsh/commit/ebdb71dbd16e855668bd0e4062eb6e2c119c5053))
* **i18n:** localize untitled filename fallbacks ([ce6b846](https://github.com/ThomasCrouzet/mdsh/commit/ce6b8460c26d85eacf9b58469e8aff3a21dc387e))
* **security:** share remote style url sanitizer with Mermaid preview ([cafb372](https://github.com/ThomasCrouzet/mdsh/commit/cafb3728c92b4ca17bd0fd8a93beb3665109c55d))

## [1.2.3](https://github.com/ThomasCrouzet/mdsh/compare/v1.2.2...v1.2.3) (2026-07-31)


### Bug Fixes

* **export:** corrige les checklists et permaliens HTML ([a74522e](https://github.com/ThomasCrouzet/mdsh/commit/a74522e5717d02a5d588eabb589fa5cb6169694c))

## [1.2.2](https://github.com/ThomasCrouzet/mdsh/compare/v1.2.1...v1.2.2) (2026-07-27)


### Bug Fixes

* **desktop:** corrige les lints clippy sur disk_grant ([abfab32](https://github.com/ThomasCrouzet/mdsh/commit/abfab32916f1ee714e93c34b29dc591fad93083b))
* fiabilise save-queue, trash undo et exports desktop ([7c41c87](https://github.com/ThomasCrouzet/mdsh/commit/7c41c87d4c09b9c52e8928441103e38b9e9b5e75))

## [1.2.1](https://github.com/ThomasCrouzet/mdsh/compare/v1.2.0...v1.2.1) (2026-07-26)


### Bug Fixes

* **ci:** déclenche les binaires depuis release-please ([#28](https://github.com/ThomasCrouzet/mdsh/issues/28)) ([de587d4](https://github.com/ThomasCrouzet/mdsh/commit/de587d442c5e106c4af5201b5d2348c750e8c244))
* **ci:** synchronise SvelteKit avant Playwright ([#30](https://github.com/ThomasCrouzet/mdsh/issues/30)) ([9647d2a](https://github.com/ThomasCrouzet/mdsh/commit/9647d2abd85530ea17d89c9ddda9c4531b11cb3d))
* **export:** synchronise les ressources KaTeX ([#32](https://github.com/ThomasCrouzet/mdsh/issues/32)) ([a15f78b](https://github.com/ThomasCrouzet/mdsh/commit/a15f78b70358ec189021a60cf613c29a2656da8d))

## [1.2.0](https://github.com/ThomasCrouzet/mdsh/compare/v1.1.0...v1.2.0) (2026-07-26)


### Features

* **desktop:** ajoute les applications natives multiplateformes ([#19](https://github.com/ThomasCrouzet/mdsh/issues/19)) ([fe6acca](https://github.com/ThomasCrouzet/mdsh/commit/fe6accaffee477a44353be1403dd6c134b1cd590))


### Bug Fixes

* **ci:** move @vite-pwa/sveltekit to devDependencies and refresh lockfile ([0dbf395](https://github.com/ThomasCrouzet/mdsh/commit/0dbf3955927c76a106dcb1b2a98fcd884b42b7e1))
* follow UI theme for Mermaid and locale for export lang ([6cdbb11](https://github.com/ThomasCrouzet/mdsh/commit/6cdbb11dfb2fc9904b34cb4aa21db70b50491c03))

## [1.1.0](https://github.com/ThomasCrouzet/mdsh/compare/v1.0.0...v1.1.0) (2026-07-15)


### Features

* propose un rechargement explicite en cas de conflit multi-onglets ([512323c](https://github.com/ThomasCrouzet/mdsh/commit/512323c6f5eb7dc27407bc249f1438563d8966c9))


### Bug Fixes

* restreint le fast-path front-matter au YAML sur une seule ligne ([5e8bcb7](https://github.com/ThomasCrouzet/mdsh/commit/5e8bcb7ced501f0f6bb54cf0fcf77079b0a34fb8))
* **security:** retire wasm-unsafe-eval de la CSP ([5e793f6](https://github.com/ThomasCrouzet/mdsh/commit/5e793f625f87cdf2600800054aed7a77439db9eb))


### Performance Improvements

* ne resynchronise le corpus du worker de recherche que s'il a change ([342625d](https://github.com/ThomasCrouzet/mdsh/commit/342625d7e9ca25c75e7bbf196ecb7b23ffd8d6aa))

## [1.0.0] - 2026-07-10

### ⚠ BREAKING CHANGES

* aucun changement d'API (mdsh est une application, pas une bibliothèque) - ce jalon marque le seuil v1.0.0 : produit stable, CI verte, documentation consolidée.

### Features

* marque le lancement public v1.0.0

## [0.10.0] - 2026-07-10

### Features

* ajoute les screenshots au manifest PWA et repositionne ses métadonnées
* ajoute un document de démo opt-in sur l'écran Welcome
* ajoute une couche i18n bilingue (anglais par défaut + français)

## [0.9.0] - 2026-06-17

### Features

* implémente la roadmap d'améliorations (thème clair, sauvegarde, historique, graphe…)

### Bug Fixes

* **a11y:** focus modal, contraste des statuts, Échap sidebar
* **a11y:** rend les wiki-links activables au clavier en mode lecture
* **export:** assainit les noms de fichiers à l'export
* **persistence:** élimine les pertes de données silencieuses par race
* **pwa:** injecte le `<link rel="manifest">` dans le document
* **pwa:** rend le précache réellement offline-ready
* **render:** code-aware wiki-links/slides, math inline, export HTML autonome
* **security:** borne les itérations PBKDF2 au déchiffrement
* **security:** durcit PBKDF2 (600k) et signale la corruption partielle de sauvegarde
* **storage:** reorder honnête, snapshots transactionnels, sync inter-onglets testée
* **stores:** remonte les échecs d'écriture IDB des workspaces et templates
* **ui:** remonte les erreurs au lieu de les avaler

## [0.8.1] - 2026-05-28

### Bug Fixes

* **test:** supprime la race de mode source dans search-replace (e2e flaky)

## [0.8.0] - 2026-05-28

### Features

* **a11y:** retours visibles des exports et de l'enregistrement disque
* canal de notifications (toasts erreur/succès/info)

### Bug Fixes

* **deps:** bump marked/dompurify/mermaid + passage en pin ~
* **deps:** correction des vulnérabilités transitives (npm audit fix)
* **security:** forcer rel="noopener noreferrer" sur les liens externes
* **storage:** durcir la persistance IndexedDB (erreurs visibles, quota, anti-éviction)

## [0.7.0] - 2026-05-20

### Features

* drag & drop d'images locales (data URI inline, 100 % offline)

### Bug Fixes

* **ci:** mobile E2E project utilise Pixel 5 (Chromium) au lieu d'iPhone 13

### Performance Improvements

* SearchPanel via Web Worker + virtualisation Sidebar conditionnelle

## [0.6.0] - 2026-04-28

### Features

* **hardening:** Sprint 1 - XSS, CSP, a11y, trash persistence, refactors
* optimisations performance (Plan A) + a11y/UX (Plan B)
* **perf+ci:** Sprint 2 - lazy Milkdown, prefetch renderer, size-limit, DX
* quick wins Tier 5+6+7 - focus indicator, typewriter, CODEOWNERS, CHANGELOG, ROADMAP
* Tier 1+2+3 - DX, perf, refactor ExportService + spinner + Lighthouse CI
* Tier 4 - front-matter, wiki-links, ZIP, CodeMirror, TOC, search & replace
* Tier 5+6+7+8+9 - multi-select, workspaces, mermaid WYSIWYG, release-please, etc.

### Bug Fixes

* **dnd:** l'overlay d'import ne réagit plus aux drags internes

### Performance Improvements

* fluidité du resize éditeur (rAF + contain + prefetch différé)

## [0.5.0] - 2026-04-28 (Tier 5+6+7+8+9)

### Added

- **Multi-sélection sidebar** (`⌘`/`Ctrl`/`Shift`+clic) avec barre d'actions groupées : exporter en ZIP, fermer, désélectionner.
- **Workspaces / sessions nommées** persistés dans Dexie (table `workspaces`, schéma v3) - sauvegarde l'état d'onglets ouverts + actif, restauration via la palette `⌘⇧P`, modal dédié pour gérer (renommer / supprimer / mettre à jour).
- **Badge « lien cassé »** sur les fichiers dont le `FileSystemFileHandle` ne résout plus (déplacé / supprimé sur le disque). Détecté en arrière-plan au load et après chaque échec d'écriture.
- **Mode typewriter** (Tier 5 polish) : caret centrée verticalement (cf. iA Writer), via un `Compartment` CodeMirror reconfigurable à chaud - toggle via la palette, persisté en `localStorage`.
- **Focus indicator persistant** : liseré accent vertical à gauche de l'onglet actif dans la sidebar.
- **Mermaid live-preview en WYSIWYG** (Tier 8) - via l'API officielle Crepe `CodeBlockConfig.renderPreview`, le SVG est rendu dans le panneau d'aperçu de chaque bloc ` ```mermaid ` directement dans l'éditeur ; mermaid reste lazy-loadé.
- **OG image + meta tags Open Graph / Twitter** pour partage social.
- **Documentation** : `CHANGELOG.md` (Keep a Changelog), `ROADMAP.md` public, FAQ + comparatif (vs StackEdit / HackMD / Obsidian / iA Writer / Typora) + diagram Mermaid d'architecture dans `README.md`, recettes de debugging consolidées dans la doc de dev.
- **CI / DX** : `release-please` configuré (workflow + config + manifest), script `npm run preview:pages` qui simule le sous-chemin `/mdsh/` localement, scripts d'outillage local (audit a11y via axe-core, audit des deps), `.github/CODEOWNERS`.
- **Calibration Lighthouse** : budgets `.github/lighthouse-budget.json` calés sur le build local (script 350 / total 800 KB) avec marge ~30 %.
- **Veille deps** : audits `lucide-svelte` et `@milkdown/crepe` documentés dans la roadmap (lucide figé en `1.0.1` = dernière dispo, no-op ; Crepe `7.16` → `7.20` reporté en lot séparé pour régénérer les snapshots E2E sur Linux CI).

### Changed

- `vitest` `^2.1.9` → `^3.2.4`. Configuration inchangée (`environment: 'jsdom'` + `globals: true` toujours supportés).
- `vite.config.ts` : nouvelle tentative `manualChunks` conservatrice - seules les libs **lazy-loadées exclusivement** sont groupées (`marked`, `highlight.js`, `katex`, `jszip`, `js-yaml`). Mermaid et DOMPurify exclus pour éviter le bug `__vitePreload` rencontré lors de la première tentative. Build vérifié : entry n'importe statiquement que les chunks SvelteKit.

### Fixed

- **Workspaces - perte de données** : `closeMany({ trash: false })` supprimait les drafts à chaque switch de workspace. Ajout d'un flag `keepDB` qui retire l'onglet sans toucher la DB ; `restore()` ré-ouvre les fichiers manquants via `db.drafts.bulkGet`.
- **Mermaid renderPreview** : le token de validité du rendu était global au module, l'édition d'un bloc B annulait le rendu en cours du bloc A. Tracker désormais via `WeakMap<applyPreview, token>` pour invalider correctement par bloc.
- `unlinkFromDisk` : fonctionne désormais aussi pour les handles orphelins (pas de file dans le store), nécessaire au panneau « Liens disque ».

## [0.4.0] - 2026-04-28 (Tier 4)

### Added

- Front-matter YAML : `title` / `tags` / `author` / `date` / `created` extraits via `js-yaml` (lazy, ~26 KB gzip), titre prioritaire dans `document.title` et label sidebar, métadonnées rendues dans une `<aside>` discrète preview + PDF.
- Wiki-links `[[Cible]]` et `[[Cible|alias]]` - résolus au clic dans le mode lecture, créent le fichier absent (Obsidian-style), backlinks listés dans la sidebar.
- Filtre par tag dans la sidebar : chips cliquables, bouton « Tous » pour reset.
- Export ZIP (« Exporter tous les fichiers ») : un seul download au lieu de N téléchargements séquentiels, `jszip` lazy ~27 KB gzip, nom horodaté `mdsh-export-YYYY-MM-DD.zip`.
- Table des matières flottante en mode lecture : extraction h1-h3, scrollspy `IntersectionObserver`, smooth-scroll.
- Panneau « Liens disque » (palette → Gérer les liens disque) : liste les `FileSystemFileHandle` persistés, statuts ✓/⚠/✗, dissocier.
- Mode source en CodeMirror 6 - coloration syntaxique markdown, numéros de ligne, history, lazy-loadé.
- Search & replace in-file via `⌘F` - panel CodeMirror themed, bascule auto en mode source si appelé depuis WYSIWYG/lecture.

### Fixed

- `unlinkFromDisk` ne dissociait pas les orphelins (handle stocké sans file dans le store) - désormais retire le handle IDB avant de checker le file.
- ESLint `no-irregular-whitespace` (caractère ZWSP littéral) corrigé via `String.fromCharCode`.
- TOC : la colonne 220 px ne se masquait pas quand le contenu n'avait aucun heading.

### Changed

- `gray-matter` abandonné (dépend de `Buffer` Node, incompatible browser sans polyfill) → remplacé par `js-yaml` qui fonctionne nativement.

## [0.3.0] - 2026-04-28 (Tier 1+2+3)

### Added

- DX : `legacy-peer-deps=true` permanent dans `.npmrc`, `.editorconfig`, scripts npm `analyze` / `clean`.
- Détection plateforme : `⌘` / `Ctrl` détectés automatiquement, raccourcis affichés dans la bonne notation (Mac : `⌘N`, Win/Linux : `Ctrl+N`) sur 31 occurrences UI.
- Spinner toast pour les exports PDF/HTML longs : délai anti-flash 200 ms, `role="status"`, `aria-live`, animation respectant `prefers-reduced-motion`.
- Lighthouse CI sur chaque PR : audit Perf / A11y / Best Practices / SEO, A11y assertion stricte ≥ 0.95, budget configurable.
- Benchmark rendu : 50k chars + 10 mermaid en < 2s en CI (~80 ms en local).

### Changed

- Service d'export extrait dans `src/lib/services/export.ts` - fonctions pures, testables, étendables (Zip/DOCX/EPUB futurs).
- `reorder()` : transaction Dexie unique au lieu de N timers (gain mesurable dès 20+ fichiers).
- KaTeX fonts slim : retrait Fraktur / SansSerif / Script (-72 KiB sur les fonts précachées par le SW).
- Mermaid counter scopé en closure (élimine le state module global).

### Fixed

- Régression first-paint : tentative de `manualChunks` Vite annulée (Rolldown faisait remonter `mermaid` 2.5 Mio en static dans l'entry).

## [0.2.0] - 2026-04-24

### Added

- Sprint 1 (hardening) : XSS sanitisation via DOMPurify, CSP durcie (`frame-src 'none'`, `frame-ancestors 'none'`), corbeille persistée Dexie, focus trap, skip link, types partagés, constants centralisées.
- Sprint 2 (perf) : Milkdown lazy-loadé, prefetch renderer au idle, debounce SearchPanel, size-limit en CI, Dependabot, lefthook (pre-commit / pre-push).
- Sprint 3 (tests) : tests unitaires `fsa` / `print`, Playwright E2E (golden-path, palette, focus, a11y), snapshots visuels.

## [0.1.0] - 2026-04-17

### Added

- Init mdsh - éditeur markdown WYSIWYG SvelteKit + Svelte 5 + Milkdown Crepe.
- Modes WYSIWYG / source / lecture.
- Stockage Dexie (IndexedDB), debounce 400 ms.
- PWA offline (`vite-plugin-pwa`), `file_handlers`, `share_target`, `launchQueue`.
- Export Markdown / HTML / PDF.
- Palette de commandes ⌘⇧P.
- Recherche cross-fichiers ⌘⇧F.
- Mode focus ⌘⇧.
- Drag-drop import `.md`.
- File System Access API (save-to-disk, ⌘⇧S).
- Dark-mode-first, contraste WCAG AAA, raccourcis clavier.
