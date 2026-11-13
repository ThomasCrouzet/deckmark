# Changelog

Toutes les évolutions notables de **mdsh** sont documentées ici.

Format basé sur [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/),
versionnement [SemVer](https://semver.org/lang/fr/).

## [2.5.4](https://github.com/ThomasCrouzet/deckmark/compare/v2.5.3...v2.5.4) (2026-11-13)


### Bug Fixes

* **a11y,desktop:** listbox activation and native work-area bounds ([#610](https://github.com/ThomasCrouzet/deckmark/issues/610), [#611](https://github.com/ThomasCrouzet/deckmark/issues/611), [#612](https://github.com/ThomasCrouzet/deckmark/issues/612)) ([6f3a677](https://github.com/ThomasCrouzet/deckmark/commit/6f3a677ed5d0f6baead6ae876d8de0811322673a))
* **a11y,focus:** include native details summaries in the shared Tab trap ([#615](https://github.com/ThomasCrouzet/deckmark/issues/615)) ([4e70f6f](https://github.com/ThomasCrouzet/deckmark/commit/4e70f6ff34b2b5b2617312e6b782eea4a98ab3c0))
* **a11y:** activate the search result option directly ([#611](https://github.com/ThomasCrouzet/deckmark/issues/611)) ([84bc248](https://github.com/ThomasCrouzet/deckmark/commit/84bc248a43f4bfab804691694f360191b777e761))
* **a11y:** focus foreground dialogs and preserve visible restoration targets ([1db4dc0](https://github.com/ThomasCrouzet/deckmark/commit/1db4dc0e05aafceb5cff8a6d1c052ba913dbf0e5))
* **a11y:** move command palette pagination outside the listbox ([#610](https://github.com/ThomasCrouzet/deckmark/issues/610)) ([10539cb](https://github.com/ThomasCrouzet/deckmark/commit/10539cb5a7eb0cc0d3033269f2b4c954d67294ea))
* **a11y:** move initial focus into modal dialogs on open ([aa420f8](https://github.com/ThomasCrouzet/deckmark/commit/aa420f88c15fe309e733a1dc81330392b878cb72))
* **backup:** acknowledge the reminder only on explicit action or success ([#620](https://github.com/ThomasCrouzet/deckmark/issues/620)) ([2a27a42](https://github.com/ThomasCrouzet/deckmark/commit/2a27a4264a6288fd7a64abca861f93502587f7f8))
* **capture:** fence pending template work on edits and teardown ([269d226](https://github.com/ThomasCrouzet/deckmark/commit/269d226147b42d2e99f9b6e9b695fcf7744c1caa))
* **capture:** reject late template results after input, reset, or switch ([d81139b](https://github.com/ThomasCrouzet/deckmark/commit/d81139b9520de277f3eada5c81be31a0fc93543f))
* **collections:** expose logical ARIA indices in virtualized tables ([#621](https://github.com/ThomasCrouzet/deckmark/issues/621)) ([1fb0690](https://github.com/ThomasCrouzet/deckmark/commit/1fb0690aa6056c82c67161f5549830cf950afdf8))
* **collections:** label the saved-view name field ([#627](https://github.com/ThomasCrouzet/deckmark/issues/627)) ([0cff6ef](https://github.com/ThomasCrouzet/deckmark/commit/0cff6ef7bc183186a65dd22509e52ca1135b6afa))
* **collections:** persist saved views before publishing and expose logical ARIA indices ([aeadc4c](https://github.com/ThomasCrouzet/deckmark/commit/aeadc4c5b6616c9bd1d45eebbec17970e3685136))
* **collections:** publish saved views only after a confirmed write ([#637](https://github.com/ThomasCrouzet/deckmark/issues/637)) ([ccda993](https://github.com/ThomasCrouzet/deckmark/commit/ccda9931408075cdb993ab2d39e885fdbbe7948f))
* **collections:** reject unreadable saved-view storage shapes ([#637](https://github.com/ThomasCrouzet/deckmark/issues/637)) ([02fafac](https://github.com/ThomasCrouzet/deckmark/commit/02fafacdc4fdda55a09be668abec819c76ac5a4f))
* **comments,ios:** keep touch form controls at 16px ([#600](https://github.com/ThomasCrouzet/deckmark/issues/600)) ([9c0ad39](https://github.com/ThomasCrouzet/deckmark/commit/9c0ad3965c909b588ccc9588195c66f2dbe8b3dc))
* **data-panels:** bind audit reports and recover from local operation failures ([c33216a](https://github.com/ThomasCrouzet/deckmark/commit/c33216a2ff86d293528ff417648062bfaae510e8))
* **desktop,capture:** ignore quick capture keys during IME composition ([#608](https://github.com/ThomasCrouzet/deckmark/issues/608)) ([9a13f7e](https://github.com/ThomasCrouzet/deckmark/commit/9a13f7e250423b5c47b301fd6d3572a7d30fc159))
* **desktop:** count decorations in the native work-area fit ([e01ee31](https://github.com/ThomasCrouzet/deckmark/commit/e01ee31aac5a5f889ccccbf8cfd499435a274e87))
* **desktop:** keep native windows inside the monitor work area ([#612](https://github.com/ThomasCrouzet/deckmark/issues/612)) ([a8a96dc](https://github.com/ThomasCrouzet/deckmark/commit/a8a96dce8d2089aba343c36db6f9c3f035297622))
* **dialogs,ios:** keep dialog controls inside the visual viewport ([#604](https://github.com/ThomasCrouzet/deckmark/issues/604)) ([95b141f](https://github.com/ThomasCrouzet/deckmark/commit/95b141f1e075f0afeeb2edba7cb861cc45f8f4c3))
* **dialogs:** keep the viewport action in the shared dialog module ([#604](https://github.com/ThomasCrouzet/deckmark/issues/604)) ([7308a7c](https://github.com/ThomasCrouzet/deckmark/commit/7308a7c4a3745a14a85fa784ca89b0135057f3e3))
* **docs-check:** bind each report to the audited project ([#636](https://github.com/ThomasCrouzet/deckmark/issues/636)) ([d283e1d](https://github.com/ThomasCrouzet/deckmark/commit/d283e1d36842c58cff2c8fcd7be4862499d1b6a1))
* **export-profiles:** add listbox arrow navigation and one tab stop ([#631](https://github.com/ThomasCrouzet/deckmark/issues/631)) ([88b9991](https://github.com/ThomasCrouzet/deckmark/commit/88b9991884f3b2ab23b5097e631385e51a55401a))
* **export-profiles:** keep the selected option visible and skip the scroll container tab stop ([#631](https://github.com/ThomasCrouzet/deckmark/issues/631)) ([4c9c93a](https://github.com/ThomasCrouzet/deckmark/commit/4c9c93a066a7a39f308259835cf2241b10256d57))
* **frontmatter:** keep parser string tokens out of the numeric editor ([#630](https://github.com/ThomasCrouzet/deckmark/issues/630)) ([9957cfd](https://github.com/ThomasCrouzet/deckmark/commit/9957cfd9ef7ace3ea71cb6145594a9887b97d6fc))
* **frontmatter:** preserve intermediate numeric input states ([#630](https://github.com/ThomasCrouzet/deckmark/issues/630)) ([06ee618](https://github.com/ThomasCrouzet/deckmark/commit/06ee618eff10e82fa1146fcc47d3a9e59ef45404))
* **git:** page long diffs and separate the native size limit ([66996bd](https://github.com/ThomasCrouzet/deckmark/commit/66996bd810bbbd217eb58af0524c824460ddb81e))
* **git:** reset the long-diff scroll and prove viewport reach ([f8a1271](https://github.com/ThomasCrouzet/deckmark/commit/f8a1271d3096ea0b5f535c1fec2bc65303b43434))
* **history:** settle a missing version body and keep the newest preview ([#633](https://github.com/ThomasCrouzet/deckmark/issues/633)) ([563607f](https://github.com/ThomasCrouzet/deckmark/commit/563607f8ab12786551dcbbb6bd1f5035b02ae031))
* **modals,focus:** honor the top-most Escape layer and trap native summaries ([b4f9c08](https://github.com/ThomasCrouzet/deckmark/commit/b4f9c08341d31883f9e4eaa50d0fc04585b45aca))
* **modals,mobile:** ignore the composition end key code 229 (623-F1) ([bbacd76](https://github.com/ThomasCrouzet/deckmark/commit/bbacd76cbd096f41109074f1fb2b3affb8ffb79d))
* **modals,mobile:** keep the Files drawer open when Escape cancels a nested prompt ([#614](https://github.com/ThomasCrouzet/deckmark/issues/614)) ([7961b4a](https://github.com/ThomasCrouzet/deckmark/commit/7961b4adbf44c6672c899928b35fcdc0b89f1e97))
* **native:** close title-edit and review evidence gaps ([25f6388](https://github.com/ThomasCrouzet/deckmark/commit/25f63881c1d97715eaef2faff0abde1195ea6c00))
* **navigation,keyboard:** scope note scroll shortcuts to the active note ([#607](https://github.com/ThomasCrouzet/deckmark/issues/607)) ([0cc5658](https://github.com/ThomasCrouzet/deckmark/commit/0cc56584af4ede31279364b299ad7cd7473bb0c3))
* **presentation,filmstrip:** clear cancelled reorder gestures ([#603](https://github.com/ThomasCrouzet/deckmark/issues/603)) ([ce88511](https://github.com/ThomasCrouzet/deckmark/commit/ce88511cc7d75ddb60dd1afd34f89ef23784f3c5))
* **presentation,responsive:** follow the editor width for the properties inspector ([#606](https://github.com/ThomasCrouzet/deckmark/issues/606)) ([2ceea94](https://github.com/ThomasCrouzet/deckmark/commit/2ceea9497207b16c853dee10a252ada96da2c518))
* **presentation:** keep source actions visible in short viewports ([f50b1cc](https://github.com/ThomasCrouzet/deckmark/commit/f50b1cc9520f766498e9a1a386efc04dff4162c9))
* **properties:** preserve numeric drafts and profile listbox focus ([d18dd79](https://github.com/ThomasCrouzet/deckmark/commit/d18dd79cee7f487d3d69308ca886a242d03b0474))
* **pwa,presentation:** iOS chrome, visual-viewport scroll and project manifest identity ([bcbe926](https://github.com/ThomasCrouzet/deckmark/commit/bcbe9268cd1918e4d9c0e5075c2a8547d250f833))
* **semantic-search:** show recoverable errors for rejected operations ([#632](https://github.com/ThomasCrouzet/deckmark/issues/632)) ([3065df4](https://github.com/ThomasCrouzet/deckmark/commit/3065df4cbc82bc52c573ba068f9026b1fad32189))
* **shortcuts,mac-web:** use the platform primary modifier for app commands ([#605](https://github.com/ThomasCrouzet/deckmark/issues/605)) ([e6cf6be](https://github.com/ThomasCrouzet/deckmark/commit/e6cf6be4ecc9c31780a128e685480fa2d28e84e0))
* **status:** keep selection counts and backup reminders current ([#619](https://github.com/ThomasCrouzet/deckmark/issues/619), [#620](https://github.com/ThomasCrouzet/deckmark/issues/620)) ([a097c28](https://github.com/ThomasCrouzet/deckmark/commit/a097c28ef7c3f1b10f2523b1329d230cbe344f10))
* **status:** reject stale selection counts and refresh backup reminders ([6181ba8](https://github.com/ThomasCrouzet/deckmark/commit/6181ba80d4df9f443bb7548bfd7036c26168f682))

## [2.5.3](https://github.com/ThomasCrouzet/deckmark/compare/v2.5.2...v2.5.3) (2026-11-11)


### Bug Fixes

* **ai-context:** prevent context spoofing and bound preview work ([#584](https://github.com/ThomasCrouzet/deckmark/issues/584)) ([e27347d](https://github.com/ThomasCrouzet/deckmark/commit/e27347d4b9cc3dff7e77b3463d028287a970d9d4))
* **benchmark:** sample source typing twenty times so one stall cannot fail the gate ([#567](https://github.com/ThomasCrouzet/deckmark/issues/567)) ([babfff5](https://github.com/ThomasCrouzet/deckmark/commit/babfff5b70f4fc4094a2d5b3629b1daab9a3dc91))
* **projects:** close portable import, quota, folder ignore and MIME issues ([#583](https://github.com/ThomasCrouzet/deckmark/issues/583)) ([70a34be](https://github.com/ThomasCrouzet/deckmark/commit/70a34be86989f4ad4ad7d470df02af50fd3a6bf7))
* **web-platform:** idempotent PWA retries and retained download object URLs ([#591](https://github.com/ThomasCrouzet/deckmark/issues/591)) ([635d61b](https://github.com/ThomasCrouzet/deckmark/commit/635d61b3f9bb42bfc4d951bf75b531b47c1d5df1))


### Performance Improvements

* **metadata:** send revision deltas to the metadata worker ([#369](https://github.com/ThomasCrouzet/deckmark/issues/369)) ([#593](https://github.com/ThomasCrouzet/deckmark/issues/593)) ([d6a9d9e](https://github.com/ThomasCrouzet/deckmark/commit/d6a9d9efac9f503c9ee17af7aa9d6accd5af08fb))
* **native-projects:** bound refresh work and reconcile disk removals ([#592](https://github.com/ThomasCrouzet/deckmark/issues/592)) ([2a2978f](https://github.com/ThomasCrouzet/deckmark/commit/2a2978f616b9900224eea2fca56625495b43825d))
* **presentation:** index connector endpoints once per slide render ([#554](https://github.com/ThomasCrouzet/deckmark/issues/554)) ([#590](https://github.com/ThomasCrouzet/deckmark/issues/590)) ([fd8cca0](https://github.com/ThomasCrouzet/deckmark/commit/fd8cca03eeca67010551afca9cd61d761ed6bb2b))
* **stats:** defer large switches, coalesce selection reads and send edit deltas ([#586](https://github.com/ThomasCrouzet/deckmark/issues/586)) ([9b1f8af](https://github.com/ThomasCrouzet/deckmark/commit/9b1f8af869b9dab7ee7e680a2d868055e3c30ba8))
* **storage:** reuse durable draft projections on unchanged saves ([#574](https://github.com/ThomasCrouzet/deckmark/issues/574)) ([#581](https://github.com/ThomasCrouzet/deckmark/issues/581)) ([bf0c279](https://github.com/ThomasCrouzet/deckmark/commit/bf0c2796a6a6b848664136cd18292b767b387d3d))
* **wysiwyg,images:** decouple editor policy from image URI length and narrow the scoped guard ([#594](https://github.com/ThomasCrouzet/deckmark/issues/594)) ([2f8a415](https://github.com/ThomasCrouzet/deckmark/commit/2f8a41598f47d27aa0d251c3540c0d700c1f2b26))
* **wysiwyg:** bound image work for large notes ([#587](https://github.com/ThomasCrouzet/deckmark/issues/587)) ([5a51d0a](https://github.com/ThomasCrouzet/deckmark/commit/5a51d0ac155c226df95879f0e6af7b3649faaa92))
* **wysiwyg:** keep image-adjacent edits scoped and bound image identity keys ([#585](https://github.com/ThomasCrouzet/deckmark/issues/585)) ([80e4056](https://github.com/ThomasCrouzet/deckmark/commit/80e4056e96083653a6ff192a7aee9a4a7f21cc15))

## [2.5.2](https://github.com/ThomasCrouzet/deckmark/compare/v2.5.1...v2.5.2) (2026-11-10)


### Bug Fixes

* **ai:** close patch atomicity, native cancellation and Web redirect gaps ([#542](https://github.com/ThomasCrouzet/deckmark/issues/542)) ([0c5796e](https://github.com/ThomasCrouzet/deckmark/commit/0c5796e9db86ca359c3bd019e5f470f6872c5bd5))
* **ai:** harden AI context, patch review and provider streaming ([#506](https://github.com/ThomasCrouzet/deckmark/issues/506)) ([badd086](https://github.com/ThomasCrouzet/deckmark/commit/badd086b8149855f072f49d171390adc9bd2e58d))
* **backup,history:** keep replaced version history with its recovery owner ([#505](https://github.com/ThomasCrouzet/deckmark/issues/505)) ([#535](https://github.com/ThomasCrouzet/deckmark/issues/535)) ([56c17a3](https://github.com/ThomasCrouzet/deckmark/commit/56c17a36e8642b4ae19445e68e7ab89edcf98788))
* **backup:** close backup and export integrity issues ([#501](https://github.com/ThomasCrouzet/deckmark/issues/501)) ([2157764](https://github.com/ThomasCrouzet/deckmark/commit/215776400a75cb0353dfdc84b466ec83032feea6))
* **binary-view:** refresh image and PDF viewers when same-ID data changes ([#539](https://github.com/ThomasCrouzet/deckmark/issues/539)) ([cc1f3a6](https://github.com/ThomasCrouzet/deckmark/commit/cc1f3a65c04213bdeecab90b68d51da661994fcc))
* **cli-mcp:** close search ordering and MCP filesystem security issues ([#525](https://github.com/ThomasCrouzet/deckmark/issues/525)) ([2d22be9](https://github.com/ThomasCrouzet/deckmark/commit/2d22be987c289ed0d90e89565154a67ceab71773))
* **cli-pack:** recover package promotion and verify checksums ([#523](https://github.com/ThomasCrouzet/deckmark/issues/523), [#526](https://github.com/ThomasCrouzet/deckmark/issues/526)) ([#543](https://github.com/ThomasCrouzet/deckmark/issues/543)) ([c9d1fc4](https://github.com/ThomasCrouzet/deckmark/commit/c9d1fc40a41340e6394a07f51e314913494790d5))
* **cli:** confine input reads, root scope and output writes ([#497](https://github.com/ThomasCrouzet/deckmark/issues/497), [#500](https://github.com/ThomasCrouzet/deckmark/issues/500), [#502](https://github.com/ThomasCrouzet/deckmark/issues/502)) ([#527](https://github.com/ThomasCrouzet/deckmark/issues/527)) ([103ca74](https://github.com/ThomasCrouzet/deckmark/commit/103ca7426e45e31a796282770010cf437a99bb32))
* **cli:** reject PDF inputs in text-only inspect and export ([#499](https://github.com/ThomasCrouzet/deckmark/issues/499)) ([#544](https://github.com/ThomasCrouzet/deckmark/issues/544)) ([babb966](https://github.com/ThomasCrouzet/deckmark/commit/babb9667bcfb39a767b83e8c8ec72658996d57ed))
* close linked-block project scope and optional preference issues ([#486](https://github.com/ThomasCrouzet/deckmark/issues/486), [#504](https://github.com/ThomasCrouzet/deckmark/issues/504)) ([#545](https://github.com/ThomasCrouzet/deckmark/issues/545)) ([7e4321a](https://github.com/ThomasCrouzet/deckmark/commit/7e4321a2761d6d59ee0c6e2d5b77f2b39a49f5fe))
* **desktop-backup:** bind snapshot lists and previews to their folder ([#516](https://github.com/ThomasCrouzet/deckmark/issues/516)) ([#546](https://github.com/ThomasCrouzet/deckmark/issues/546)) ([df15f52](https://github.com/ThomasCrouzet/deckmark/commit/df15f52b2994bf550904255af310e861e065fa8f))
* **disk-links:** fence link ownership and discard stale health results ([#549](https://github.com/ThomasCrouzet/deckmark/issues/549)) ([469013f](https://github.com/ThomasCrouzet/deckmark/commit/469013f03a13263693864c008630befee2985824))
* **disk-save:** report written-but-link-unsaved when revision metadata fails ([#397](https://github.com/ThomasCrouzet/deckmark/issues/397)) ([#540](https://github.com/ThomasCrouzet/deckmark/issues/540)) ([86894a7](https://github.com/ThomasCrouzet/deckmark/commit/86894a7fb50e457cf917b0df177b5eaa7c2920e5))
* **docs-site:** close SVG publication, path namespace, fragment and report issues ([#537](https://github.com/ThomasCrouzet/deckmark/issues/537)) ([6fdc74a](https://github.com/ThomasCrouzet/deckmark/commit/6fdc74a4cea0eea6e5d89a8946abe4e95c5048dc))
* **frontmatter,collections:** close frontmatter-2 campaign issues ([#541](https://github.com/ThomasCrouzet/deckmark/issues/541)) ([3d50d8a](https://github.com/ThomasCrouzet/deckmark/commit/3d50d8a84939caf1a4a34314f5df00c10356d770))
* **frontmatter:** preserve YAML types and bound collection views ([#511](https://github.com/ThomasCrouzet/deckmark/issues/511)) ([48f2612](https://github.com/ThomasCrouzet/deckmark/commit/48f2612c4f85ae5f55c7ba7c84e4eada177d57ae))
* **json-tools:** close replacement and JSON analysis issues ([#512](https://github.com/ThomasCrouzet/deckmark/issues/512)) ([eda7dea](https://github.com/ThomasCrouzet/deckmark/commit/eda7dea02abbd232e9e679dc905ad1c8e49534e1))
* **links:** harden linked blocks and wiki link scanning ([#510](https://github.com/ThomasCrouzet/deckmark/issues/510)) ([31ac96c](https://github.com/ThomasCrouzet/deckmark/commit/31ac96c782a7ea721bf019d9855707bca272710f))
* **media-import:** keep encoded filename characters when matching selected images ([#495](https://github.com/ThomasCrouzet/deckmark/issues/495)) ([#538](https://github.com/ThomasCrouzet/deckmark/issues/538)) ([927ab59](https://github.com/ThomasCrouzet/deckmark/commit/927ab5963117d9c96a1a38acde6b25016c5c798b))
* **native-desktop:** close project refresh, rename recovery, capture, Git, backup and archive issues ([#531](https://github.com/ThomasCrouzet/deckmark/issues/531)) ([61c2de0](https://github.com/ThomasCrouzet/deckmark/commit/61c2de0ed7b1bc5f6022c90d8816444d354f4440))
* **native:** close project capacity, native refresh and Git commit fences ([#382](https://github.com/ThomasCrouzet/deckmark/issues/382), [#493](https://github.com/ThomasCrouzet/deckmark/issues/493), [#515](https://github.com/ThomasCrouzet/deckmark/issues/515)) ([#548](https://github.com/ThomasCrouzet/deckmark/issues/548)) ([f6e5bd8](https://github.com/ThomasCrouzet/deckmark/commit/f6e5bd8ce79fc9a95449c18e7a3a892782e59305))
* **panels:** close diagnostics aggregation and export profile import issues ([#530](https://github.com/ThomasCrouzet/deckmark/issues/530)) ([04c6628](https://github.com/ThomasCrouzet/deckmark/commit/04c6628a5a3a360887dafc0da9f91b733b6999ff))
* **projects:** close import, transfer, save and durability issues ([#507](https://github.com/ThomasCrouzet/deckmark/issues/507)) ([1ee7f30](https://github.com/ThomasCrouzet/deckmark/commit/1ee7f30f52c3c2538e42aeaae4943a2d521744c0))
* **semantic-search:** close stale query and scoped clear issues ([#532](https://github.com/ThomasCrouzet/deckmark/issues/532)) ([e61f588](https://github.com/ThomasCrouzet/deckmark/commit/e61f5885f5e5eec6eb98557b13a87683722bca71))
* **trash,comments:** preserve binary revisions and purge orphaned comments ([#529](https://github.com/ThomasCrouzet/deckmark/issues/529)) ([1fd2729](https://github.com/ThomasCrouzet/deckmark/commit/1fd27294e8b7307dc6cd144130ec707befbf93ae))
* **workspaces:** fence concurrent rename and update writes ([#494](https://github.com/ThomasCrouzet/deckmark/issues/494)) ([#536](https://github.com/ThomasCrouzet/deckmark/issues/536)) ([d3589e6](https://github.com/ThomasCrouzet/deckmark/commit/d3589e67bc8b7e74e4ff229e456ba850160411f4))


### Performance Improvements

* close semantic search, presentation and project media cache issues ([#358](https://github.com/ThomasCrouzet/deckmark/issues/358), [#384](https://github.com/ThomasCrouzet/deckmark/issues/384), [#389](https://github.com/ThomasCrouzet/deckmark/issues/389)) ([#547](https://github.com/ThomasCrouzet/deckmark/issues/547)) ([cf46c39](https://github.com/ThomasCrouzet/deckmark/commit/cf46c39c70a1c81a899ede703e79f62113543514))
* **editor:** close large-note editing, media, comments and preview issues ([#508](https://github.com/ThomasCrouzet/deckmark/issues/508)) ([de67ee2](https://github.com/ThomasCrouzet/deckmark/commit/de67ee27339109b89cbb30abcaaabbd26b305ccd))
* **render,presentation:** close Mermaid, presentation and stress issues ([#533](https://github.com/ThomasCrouzet/deckmark/issues/533)) ([69e921d](https://github.com/ThomasCrouzet/deckmark/commit/69e921d600356fd1c61a52ca34da8d9b5dd77dec))
* **ui:** bound project trees, share navigation revisions and revision project media ([#522](https://github.com/ThomasCrouzet/deckmark/issues/522)) ([564b45d](https://github.com/ThomasCrouzet/deckmark/commit/564b45d13c753b6b46cae3fe6b0a2c19b18d3878))

## [2.5.1](https://github.com/ThomasCrouzet/deckmark/compare/v2.5.0...v2.5.1) (2026-11-09)


### Bug Fixes

* **annotations:** keep the ink viewport fixed during native scroll ([#333](https://github.com/ThomasCrouzet/deckmark/issues/333)) ([ffd489f](https://github.com/ThomasCrouzet/deckmark/commit/ffd489f1fe5192d1a0fcee0df005cd500ed99cd9))
* fence deferred hydration and bound local MCP work ([#420](https://github.com/ThomasCrouzet/deckmark/issues/420), [#421](https://github.com/ThomasCrouzet/deckmark/issues/421)) ([#422](https://github.com/ThomasCrouzet/deckmark/issues/422)) ([578f0ea](https://github.com/ThomasCrouzet/deckmark/commit/578f0eadc0e7599dae51f2f310a1242f514e30ba))
* make projection backfill revision-safe and bound command lists ([#413](https://github.com/ThomasCrouzet/deckmark/issues/413)) ([0cb455e](https://github.com/ThomasCrouzet/deckmark/commit/0cb455e3560866f2286ed0043b68052962fd6d58))
* **native-projects:** journal project renames and recover on reconnect ([#379](https://github.com/ThomasCrouzet/deckmark/issues/379)) ([#427](https://github.com/ThomasCrouzet/deckmark/issues/427)) ([5978dc6](https://github.com/ThomasCrouzet/deckmark/commit/5978dc697c2d438e7c6f2acdd1712a358667e9b8))
* remediate open security, correctness and large-document issues ([#401](https://github.com/ThomasCrouzet/deckmark/issues/401)) ([a192726](https://github.com/ThomasCrouzet/deckmark/commit/a192726509fe671da6d657fd0e990c872335e1f4))


### Performance Improvements

* address selection, disk-link and replace hot paths ([#402](https://github.com/ThomasCrouzet/deckmark/issues/402)) ([ca0d4e8](https://github.com/ThomasCrouzet/deckmark/commit/ca0d4e864d9f466c11ef7ac6507ad1d54f8ff1ba))
* **annotations:** bound ink rendering to the viewport ([#331](https://github.com/ThomasCrouzet/deckmark/issues/331)) ([f176e21](https://github.com/ThomasCrouzet/deckmark/commit/f176e219b3848fce9eb5e9e68bc2b561f847a1a6))
* bound print, workspace, JSON, asset, template, AI, CLI, snippet and presentation work ([#423](https://github.com/ThomasCrouzet/deckmark/issues/423)) ([2a4f9e4](https://github.com/ThomasCrouzet/deckmark/commit/2a4f9e4e4ca60fab41d93fddb851845fb194717a))
* bound trash, workspace, sidebar, print and media work ([#403](https://github.com/ThomasCrouzet/deckmark/issues/403)) ([b4ff766](https://github.com/ThomasCrouzet/deckmark/commit/b4ff7665767fcbe1584d2e4c701a7d53545d9ea9))
* **comments:** page the comment list instead of mounting every row ([#385](https://github.com/ThomasCrouzet/deckmark/issues/385)) ([#426](https://github.com/ThomasCrouzet/deckmark/issues/426)) ([cad2b40](https://github.com/ThomasCrouzet/deckmark/commit/cad2b40ca24e1b084b1df7b9d7d0214682f3ebd4))
* **core:** connect revisioned Source and Code edits ([#335](https://github.com/ThomasCrouzet/deckmark/issues/335)) ([6c95b10](https://github.com/ThomasCrouzet/deckmark/commit/6c95b10320f22e67b03dc7be5be1d3e0b74d9b38))
* **editor:** reduce input latency in large rendered notes ([#430](https://github.com/ThomasCrouzet/deckmark/issues/430)) ([8607b15](https://github.com/ThomasCrouzet/deckmark/commit/8607b156fdbf2675ac5e659b23de60b1f586035a))
* finish large-document metadata, storage and stress work ([#344](https://github.com/ThomasCrouzet/deckmark/issues/344)) ([30a6926](https://github.com/ThomasCrouzet/deckmark/commit/30a692690613bca4b888f43ed9b2b82bf6189420))
* integrate remaining large-document optimizations ([#343](https://github.com/ThomasCrouzet/deckmark/issues/343)) ([934cbac](https://github.com/ThomasCrouzet/deckmark/commit/934cbac302112cd129bc865a52a113e1b0af21a6))
* **mermaid:** publish non-diagram HTML before preview renders finish ([#363](https://github.com/ThomasCrouzet/deckmark/issues/363)) ([#429](https://github.com/ThomasCrouzet/deckmark/issues/429)) ([c2f5f29](https://github.com/ThomasCrouzet/deckmark/commit/c2f5f297fd3251eb093548aee4d08d530574615a))
* move versioned JSON diagnostics to worker ([#332](https://github.com/ThomasCrouzet/deckmark/issues/332)) ([11f9267](https://github.com/ThomasCrouzet/deckmark/commit/11f9267fb1f49d212fd500298d3d1dfa803da18a))
* **native-projects:** skip unchanged refreshes with a metadata manifest ([#351](https://github.com/ThomasCrouzet/deckmark/issues/351)) ([#428](https://github.com/ThomasCrouzet/deckmark/issues/428)) ([075c435](https://github.com/ThomasCrouzet/deckmark/commit/075c4351151402a063b7c108141d76be2ed8b2b8))
* **presentation:** cache snap geometry during gestures ([#334](https://github.com/ThomasCrouzet/deckmark/issues/334)) ([c04d4e0](https://github.com/ThomasCrouzet/deckmark/commit/c04d4e0c710cb321d793791d32747a8c4f6f5e70))
* **presentation:** coalesce text and notes deck snapshots ([#336](https://github.com/ThomasCrouzet/deckmark/issues/336)) ([5e87960](https://github.com/ThomasCrouzet/deckmark/commit/5e879605d83930b23bd22f39e073cf224948e0b2))
* **presentation:** snapshot only selected gesture elements ([#415](https://github.com/ThomasCrouzet/deckmark/issues/415)) ([#425](https://github.com/ThomasCrouzet/deckmark/issues/425)) ([601a946](https://github.com/ThomasCrouzet/deckmark/commit/601a946d583f856583f0333c43c53b02d71de513))
* **presentation:** window large filmstrips ([#416](https://github.com/ThomasCrouzet/deckmark/issues/416)) ([#424](https://github.com/ThomasCrouzet/deckmark/issues/424)) ([93c2f6b](https://github.com/ThomasCrouzet/deckmark/commit/93c2f6b8edc49796decd57b0b1d12c482811a36e))
* **projects:** index wiki candidates and bound project backlinks ([#338](https://github.com/ThomasCrouzet/deckmark/issues/338)) ([2ef0fc9](https://github.com/ThomasCrouzet/deckmark/commit/2ef0fc9b51e81d37b3f73ea8cfc02cf5b946d413))
* **source:** coalesce typewriter caret centering ([#329](https://github.com/ThomasCrouzet/deckmark/issues/329)) ([dc76ebe](https://github.com/ThomasCrouzet/deckmark/commit/dc76ebe87a52eb2f4decfcfebfa4a307dec52f9e)), closes [#328](https://github.com/ThomasCrouzet/deckmark/issues/328)
* **stats:** compute large selection statistics in the stats worker ([#404](https://github.com/ThomasCrouzet/deckmark/issues/404)) ([2006bb1](https://github.com/ThomasCrouzet/deckmark/commit/2006bb19c5451509ebb288c4ff060b37836f4852))
* **workspaces:** restore tabs from metadata and hydrate only the active document ([#405](https://github.com/ThomasCrouzet/deckmark/issues/405)) ([b8cfbf1](https://github.com/ThomasCrouzet/deckmark/commit/b8cfbf1d2d616a04ca87db6be989e2c74b5991f5))

## [2.5.0](https://github.com/ThomasCrouzet/deckmark/compare/v2.4.0...v2.5.0) (2026-11-07)


### Features

* **cli:** package the installed CLI and MCP with a bundled runtime ([#298](https://github.com/ThomasCrouzet/deckmark/issues/298)) ([98547b4](https://github.com/ThomasCrouzet/deckmark/commit/98547b49e09b70367915a142f2624809935519c2))
* **creation:** create code and JSON files from New File ([#276](https://github.com/ThomasCrouzet/deckmark/issues/276)) ([c4a755d](https://github.com/ThomasCrouzet/deckmark/commit/c4a755d33a1f5fcba5554ff85d0285cafbfab28e))
* **diagnostics:** add opt-in local reports with secret-safe events ([#281](https://github.com/ThomasCrouzet/deckmark/issues/281)) ([1d9c547](https://github.com/ThomasCrouzet/deckmark/commit/1d9c5478e92550496332171077e6cbb7fc9239d4))


### Bug Fixes

* **bench:** enforce complete and fail-closed performance evidence ([#274](https://github.com/ThomasCrouzet/deckmark/issues/274)) ([1e0e825](https://github.com/ThomasCrouzet/deckmark/commit/1e0e825f83e2d19e7bb2bbd5e4f2a90680bd7c65))
* **bench:** fail on missing samples and widen noisy metrics ([#294](https://github.com/ThomasCrouzet/deckmark/issues/294)) ([3759872](https://github.com/ThomasCrouzet/deckmark/commit/3759872cd37beaf987c67958407b9fbd3aa49d45))
* **bench:** reject incomplete and truncated benchmark evidence ([#297](https://github.com/ThomasCrouzet/deckmark/issues/297)) ([5430245](https://github.com/ThomasCrouzet/deckmark/commit/5430245b23c14de1bbcbd2ea6480123b20496fff))
* **ci:** allow slow apt mirrors to finish the browser install ([#290](https://github.com/ThomasCrouzet/deckmark/issues/290)) ([32aa6b5](https://github.com/ThomasCrouzet/deckmark/commit/32aa6b54e95612bf1358e8624d4854e0173bfbd2))
* **cli:** wait for package runtime images before test cleanup ([#301](https://github.com/ThomasCrouzet/deckmark/issues/301)) ([7620da0](https://github.com/ThomasCrouzet/deckmark/commit/7620da0da86871bbd295f5ea7ecd6c05aaa79c7c))
* **code:** use accurate C#, PowerShell and JSONC language handling ([#275](https://github.com/ThomasCrouzet/deckmark/issues/275)) ([2557ec2](https://github.com/ThomasCrouzet/deckmark/commit/2557ec2157ea522e8981f4e56e9c6b06b3e32cae))
* **first-run:** add storage and offline setup retries with honest status ([#280](https://github.com/ThomasCrouzet/deckmark/issues/280)) ([617b365](https://github.com/ThomasCrouzet/deckmark/commit/617b36560339664fc99cefda0dfc4cb7da1b8e2b))
* preserve Cloudflare response integrity ([#265](https://github.com/ThomasCrouzet/deckmark/issues/265)) ([746afc6](https://github.com/ThomasCrouzet/deckmark/commit/746afc63db16ecb021dafcb2c3cc72a2f438f34d))
* restore verified Cloudflare mirror publishing ([#257](https://github.com/ThomasCrouzet/deckmark/issues/257)) ([49eb29d](https://github.com/ThomasCrouzet/deckmark/commit/49eb29ddeba4f2fad4d842608165003de79dc1fb))
* reuse HTML export assets and keep CI reports local ([#299](https://github.com/ThomasCrouzet/deckmark/issues/299)) ([61b5a36](https://github.com/ThomasCrouzet/deckmark/commit/61b5a36c2d23af6f56328cd2cf5e8e5d396060e6))


### Performance Improvements

* **editor:** index project links once for backlink resolution ([#278](https://github.com/ThomasCrouzet/deckmark/issues/278)) ([c945546](https://github.com/ThomasCrouzet/deckmark/commit/c945546e461d7bf39ebeb096cd1cc98bc5e6227a))
* **editor:** remove full-document work from ordinary input ([#303](https://github.com/ThomasCrouzet/deckmark/issues/303)) ([1fedfd8](https://github.com/ThomasCrouzet/deckmark/commit/1fedfd8ed2480fa9a526e22ae5c63bd379b382af))

## [2.4.0](https://github.com/ThomasCrouzet/deckmark/compare/v2.3.0...v2.4.0) (2026-11-04)


### Features

* add reading focus, theme, home, selection and scroll controls ([1276c26](https://github.com/ThomasCrouzet/deckmark/commit/1276c2621c9923061c20132c738541ed2df8e958))
* **ai:** add optional providers, context review, patches and ink annotations ([8c60007](https://github.com/ThomasCrouzet/deckmark/commit/8c60007eb2598ea7cb4423311595b2263a260aaa))
* **ai:** use the native boundary in the desktop edition ([168c7d3](https://github.com/ThomasCrouzet/deckmark/commit/168c7d398b9c789ba8b02efcda1e314408e96b2d))
* **cli:** add local command-line interface ([df9e79a](https://github.com/ThomasCrouzet/deckmark/commit/df9e79ad54af80a1667aa6826af4766d4cc146f9))
* **code:** add a lightweight multilingual code editor ([4ca14ef](https://github.com/ThomasCrouzet/deckmark/commit/4ca14efb44635e6d0ad7bba77bc7bb5208e14b68))
* **content:** add linked reusable content blocks ([fa27f7e](https://github.com/ThomasCrouzet/deckmark/commit/fa27f7e428e21a6bf79940aeae97448f3c0dcc14))
* **desktop:** add an opt-in local MCP server ([b74372e](https://github.com/ThomasCrouzet/deckmark/commit/b74372e0135e460a93b8bdd131e762219008775a))
* **desktop:** add an optional global quick capture window ([2e6ecaa](https://github.com/ThomasCrouzet/deckmark/commit/2e6ecaa0a12b8d742b85ecc61efa6ddf9c5e655b)), closes [#234](https://github.com/ThomasCrouzet/deckmark/issues/234)
* **desktop:** add lightweight Git status and commits ([8f0e7de](https://github.com/ThomasCrouzet/deckmark/commit/8f0e7def07a3f1b78bdb69418e4a53589b806421))
* **desktop:** add local backup snapshots with retention ([6a00c7c](https://github.com/ThomasCrouzet/deckmark/commit/6a00c7c05d58a1c1be30fae03bad6f3415f96b2e))
* **docs:** add offline documentation quality check ([77b742a](https://github.com/ThomasCrouzet/deckmark/commit/77b742ad2b5c1aeb59785cf7e84b58ec01457ac1))
* **export:** add reusable HTML and PDF profiles ([9eea195](https://github.com/ThomasCrouzet/deckmark/commit/9eea195f97db7b09dbdecf7f46aa772a92d7a62d))
* **export:** publish projects as offline documentation sites ([134a012](https://github.com/ThomasCrouzet/deckmark/commit/134a012834d5a02347ee11bd98b7e9920d4e7ffd))
* **files:** add typed code and image documents ([4e30433](https://github.com/ThomasCrouzet/deckmark/commit/4e30433f5d81b2163763bb8f901406b31a267174))
* **files:** separate save, Save As, and copy actions ([6345055](https://github.com/ThomasCrouzet/deckmark/commit/6345055d195bbd6949e8676331ee288a51e25a01))
* **files:** show storage origin and sync state ([24aa42e](https://github.com/ThomasCrouzet/deckmark/commit/24aa42e1d1ff6ffdc2b9dce186c237eafc96c194))
* **import:** normalize Obsidian and Notion project imports ([11b2f43](https://github.com/ThomasCrouzet/deckmark/commit/11b2f43d4c43e2f8feab02ee0aadec997de6aa04))
* **json:** validate, format and minify JSON losslessly ([9a87358](https://github.com/ThomasCrouzet/deckmark/commit/9a8735871edf1d0d667b74df1b4958b7cec52391))
* **metadata:** add lazy table and board views ([5ed4c99](https://github.com/ThomasCrouzet/deckmark/commit/5ed4c99f7780938a0d67e29c2905d1d5ca8f9177))
* **metadata:** add YAML property editor and editorial comments ([1e605c7](https://github.com/ThomasCrouzet/deckmark/commit/1e605c7f88e39b03ec3e77bbec8d7eb970c6ea46))
* **native:** add the credential vault and AI request boundary ([29c0aae](https://github.com/ThomasCrouzet/deckmark/commit/29c0aaee3888654cabed4125716e218173da41d6))
* **projects:** add a persistent explorer and safe project drops ([b3f0e88](https://github.com/ThomasCrouzet/deckmark/commit/b3f0e88bb598591e78e9449212d73ec9507a5c3a)), closes [#211](https://github.com/ThomasCrouzet/deckmark/issues/211) [#212](https://github.com/ThomasCrouzet/deckmark/issues/212)
* **projects:** scale project limits and add a local search index ([36370f2](https://github.com/ThomasCrouzet/deckmark/commit/36370f2cb0b23f9c2e928284fa2fba9784865ac1))
* **search:** add selectable local search models and scale checks ([b7bf3d6](https://github.com/ThomasCrouzet/deckmark/commit/b7bf3d630a8aca4fe74602ebb4be9362e54b1f62))
* **settings:** add desktop backup schedule and restore ([33201b0](https://github.com/ThomasCrouzet/deckmark/commit/33201b057551dad3dd21be8adb519f1848d2b78d))
* **snippets:** add searchable snippet library ([34cda10](https://github.com/ThomasCrouzet/deckmark/commit/34cda1076e512da08129c997d7d432b05e7c06c0))
* **templates:** add typed starters and New File template choice ([d50adbb](https://github.com/ThomasCrouzet/deckmark/commit/d50adbb9fe18c76680fc6cb31ed21ba62bd9e60a))
* **viewer:** add a lazy local PDF document viewer ([3a167c8](https://github.com/ThomasCrouzet/deckmark/commit/3a167c8b9cd93b9e4fb40d7e59df0e5e77f75816))


### Bug Fixes

* **ai:** fail closed when the native vault is absent ([cec2e40](https://github.com/ThomasCrouzet/deckmark/commit/cec2e4097c021ff1c49dfcaa989e1c7a717d0f85))
* **ai:** keep the vault id parser compatible with older WebViews ([c3bd525](https://github.com/ThomasCrouzet/deckmark/commit/c3bd5258d4152111017d0cfc817365f660168796))
* **benchmark:** batch native seeding and wait for idle project panels ([d80b650](https://github.com/ThomasCrouzet/deckmark/commit/d80b6508467118a5a6f4d09a82cd3d39c8092faa))
* compact toolbars, preserve focus, and refresh release media ([#256](https://github.com/ThomasCrouzet/deckmark/issues/256)) ([094c8c6](https://github.com/ThomasCrouzet/deckmark/commit/094c8c6d4fb0cf4279b01c93544973005dd8ae2f))
* complete project review and release hardening ([#255](https://github.com/ThomasCrouzet/deckmark/issues/255)) ([3411882](https://github.com/ThomasCrouzet/deckmark/commit/341188234ed94a2d5ba4975d30b2da909560b0bc))
* defer annotation canvases and retain failure evidence ([be526fd](https://github.com/ThomasCrouzet/deckmark/commit/be526fde57d0758f682de8e146df7d31b5686a94))
* **editor:** open new notes in Edit with a ready caret ([c92dacc](https://github.com/ThomasCrouzet/deckmark/commit/c92dacc21937ee63d23e6b5cfa4703efcb58109f))
* **git:** allow unused filters without executing conversions ([a965cc7](https://github.com/ThomasCrouzet/deckmark/commit/a965cc7c32a8ddd17d74c5a00faf8cc3d74da6e9))
* keep document and presentation toolbars compact ([817945b](https://github.com/ThomasCrouzet/deckmark/commit/817945bcbc6052b0fb7636b41bccb3f6b98416bd))
* keep empty paragraphs as Markdown blank lines ([54844d7](https://github.com/ThomasCrouzet/deckmark/commit/54844d7953fc6a91c9553f37c256f9e10a8c85b5))
* keep slide controls visible at extreme browser zoom ([c389fae](https://github.com/ThomasCrouzet/deckmark/commit/c389faef9250ad01aae8e7c49647638be6a9f1ec))
* keep toolbar controls stable during offline setup ([7a45669](https://github.com/ThomasCrouzet/deckmark/commit/7a4566999a1b2c45e83ba9a25b6654cff55772b8))
* **native:** align the native smoke with the current shortcuts and editor ([ff84860](https://github.com/ThomasCrouzet/deckmark/commit/ff84860753b4aa5d49e152d54eb9931057e0aba1))
* **presentation:** reserve space for wrapped toolbars on narrow layouts ([d01b335](https://github.com/ThomasCrouzet/deckmark/commit/d01b3351045e27d45170e3432a5baa1b91542184))
* preserve binary files and synchronize changes across windows ([207065c](https://github.com/ThomasCrouzet/deckmark/commit/207065c7a6a6770d0a70b6f8bcf49d393cb0e7ef))
* preserve palette input and refresh release media ([0387c96](https://github.com/ThomasCrouzet/deckmark/commit/0387c96768e18934500fcfb8244d201075bd0abf))
* preserve paragraph spacing during visual edits ([a3113b3](https://github.com/ThomasCrouzet/deckmark/commit/a3113b38e273fd84253cd7cb12a0b126be96510c))
* **security:** bind native access to approved endpoints and roots ([742bd43](https://github.com/ThomasCrouzet/deckmark/commit/742bd4323fa82b57d523b7018e24122e21bf88d8))
* **ui:** keep presentation notes and drop overlays stable on narrow viewports ([4feac1a](https://github.com/ThomasCrouzet/deckmark/commit/4feac1aa28cfc658b0535baef34771e8920af9e3))
* **ui:** keep the layout usable at 200 percent browser zoom ([5cbdcd3](https://github.com/ThomasCrouzet/deckmark/commit/5cbdcd397ddd854ff23738c4dbb0881ba5239ccb))
* **ui:** stop toasts from blocking dialogs and bound project export ([f0db2c5](https://github.com/ThomasCrouzet/deckmark/commit/f0db2c52c21b97d50f40aaae8b193e878cc38782))
* use visible PDF commands in native checks ([3ad63c1](https://github.com/ThomasCrouzet/deckmark/commit/3ad63c1528e6067696fc9851e3973baf90823f18))

## [2.3.0](https://github.com/ThomasCrouzet/deckmark/compare/v2.2.2...v2.3.0) (2026-11-02)


### Features

* add separate presentation files and improve local workflows ([#192](https://github.com/ThomasCrouzet/deckmark/issues/192)) ([f0e89ad](https://github.com/ThomasCrouzet/deckmark/commit/f0e89adb9a7e2c706d5aa6f5b83de894a3c48b6c))

## [2.2.2](https://github.com/ThomasCrouzet/deckmark/compare/v2.2.1...v2.2.2) (2026-11-02)


### Bug Fixes

* **ci:** match the desktop validation gate to the platform matrix ([#187](https://github.com/ThomasCrouzet/deckmark/issues/187)) ([44397ac](https://github.com/ThomasCrouzet/deckmark/commit/44397ac57e59f8f133e6d323f2e83a03a2aca741))

## [2.2.1](https://github.com/ThomasCrouzet/deckmark/compare/v2.2.0...v2.2.1) (2026-11-01)


### Bug Fixes

* **deps:** force the patched minimatch and glob versions ([#184](https://github.com/ThomasCrouzet/deckmark/issues/184)) ([1bcd4fe](https://github.com/ThomasCrouzet/deckmark/commit/1bcd4fe18a0fb3e3cbdf46204ec42df4b7cc0589))
* **site:** use the official deckmark.dev address ([#185](https://github.com/ThomasCrouzet/deckmark/issues/185)) ([25672d2](https://github.com/ThomasCrouzet/deckmark/commit/25672d2b8d531e96993e21183f7be9e3105a0480))

## [2.2.0](https://github.com/ThomasCrouzet/deckmark/compare/v2.1.0...v2.2.0) (2026-11-01)


### Features

* apply the DeckMark Relay identity and refresh the README ([#176](https://github.com/ThomasCrouzet/deckmark/issues/176)) ([4edc12f](https://github.com/ThomasCrouzet/deckmark/commit/4edc12f4571e0bb4a0b1c2c24e355338eb88ee45))
* keep source bytes through visual edits ([#181](https://github.com/ThomasCrouzet/deckmark/issues/181)) ([3399808](https://github.com/ThomasCrouzet/deckmark/commit/3399808b424eaf9a8209678552c23b651029b705))

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
