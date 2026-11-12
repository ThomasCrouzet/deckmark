# Editions, requirements, and support

DeckMark has two editions: **Web Light** and **Desktop Complete (Beta)**.
Both editions use the same local-first client, document format, and storage model.
Web Light is a complete browser product. It is free, open source, and not a trial.
It has no time limit, feature paywall, account, or server component.

## Choose an edition

| Edition | Delivery | Use it when |
| --- | --- | --- |
| **Web Light** | Install-free web app or installed PWA | You want notes, presentations, projects, search, history, backups, and exports in a browser. |
| **Desktop Complete (Beta)** | Tauri installer from GitHub Releases | You need native in-place file editing, native folder access, file associations, or the macOS print panel. |

- Web Light: [https://www.deckmark.dev/](https://www.deckmark.dev/)
- GitHub Pages fallback: [https://thomascrouzet.github.io/deckmark/](https://thomascrouzet.github.io/deckmark/)
- Desktop installers: [GitHub Releases](https://github.com/ThomasCrouzet/deckmark/releases)

Cloudflare Pages and GitHub Pages publish Web Light as independent sites. The
separate Desktop release channel publishes Desktop Complete. Web Light needs no
application server.

## Build each edition

Both editions come from the same source tree. The edition is a build input, not a
runtime preference.

```sh
npm run build:web       # Web Light, then verify the native boundary
npm run build:desktop   # Desktop Complete assets for Tauri
npm run check:edition   # Recheck the current build manifest and boundary
```

The Web build replaces the Tauri packages with a stub. `scripts/check-edition-boundaries.mjs`
fails the build if a native bridge string remains in the Web output. `build/edition.json`
records the edition, version, source commit as `sourceSha`, base path, features,
and excluded capabilities.
`npm run desktop:build` uses `build:desktop` through Tauri.

## Feature matrix

| Capability | Web Light | Desktop Complete (Beta) |
| --- | --- | --- |
| Notes in Edit, Source, and Read modes | Yes | Yes |
| Markdown presentations with slides, presenter notes, and Present mode | Yes | Yes |
| Portable projects with paths, assets, and link reports | Yes | Yes |
| Import from files, folders, and ZIP archives | Yes | Yes |
| Search, replacement, tags, backlinks, and link graph | Yes | Yes |
| Version history, trash, workspaces, and templates | Yes | Yes |
| Markdown, HTML, PDF, library ZIP, and project ZIP export | Yes | Yes |
| JSON backup, restore, merge, and optional encryption | Yes | Yes |
| Scheduled local backup snapshots with count retention and a restore preview | No | Yes, into a folder that you approve |
| Git status, diff, log, stage, and commit for a local project | No | Yes, inside an approved project root |
| Offline use after the offline resources are ready | Yes, through the service worker | Yes, from packaged application files |
| English and French interface | Yes | Yes |
| Themes, keyboard navigation, and reduced motion | Yes | Yes |
| Save a draft to a linked disk file | Chromium only, through the File System Access API, with an explicit action | Yes, through a native picker and a session capability |
| Rename a linked disk file in place | No. A browser rename disconnects the old link. | Yes, in the selected directory |
| Keep a project folder link and refresh it from disk | No | Yes |
| Restore approved disk access after an application restart | No | Yes |
| Native macOS print panel | No. Use the browser print dialog. | Yes on macOS |
| File associations and operating-system open events | PWA file handlers where the browser supports them | Yes |
| Native menus and window state restore | No | Yes |
| Global quick capture window for notes and snippets with an opt-in shortcut | No | Yes, disabled by default with a configurable shortcut |
| In-place disk editing with revision checks | Limited to supported browser file links | Yes, with native path capabilities and revision checks |
| Service worker application update | Yes | No. Install a new Desktop release. |
| First-class code and JSON files | Yes | Yes |
| Ephemeral Read-mode ink annotations | Yes | Yes |
| Image annotation canvas and flattened PNG export | Yes | Yes |
| Optional OpenAI-compatible AI connection | Yes, disabled by default, with a session-only browser key and explicit consent | Yes, disabled by default, through the native request boundary |
| Secure native API key vault | No. A browser-resident key is not a protected secret. | Yes, through the operating-system credential store |
| Secure browser API key vault | Unavailable | Unavailable |
| Signed update checks | No | No. Update delivery is on standby. Install a new release manually. |
| Local command-line interface and MCP server | No | Yes, from a source checkout |
| Unrestricted filesystem access | Unavailable | Unavailable. Access is limited to selected paths. |
| Cloud sync, shared editing, accounts, and plugins | Unavailable | Unavailable |
| Telemetry and crash reports | None | None |

"Unavailable" means that the release does not contain the capability. It is not a
hidden setting, a paid upgrade, or a disabled control.

## System requirements

### Web Light

| Requirement | Detail |
| --- | --- |
| Browser | A current Chromium, Firefox, or Safari browser with JavaScript and IndexedDB. |
| First load | A network connection to the application host. Later offline use needs the service worker installation to finish. |
| Offline use | Service worker support on a secure HTTPS origin. Wait for the **Ready offline** status before you disconnect. |
| Storage | Browser storage space for drafts, history, projects, assets, and templates. The working target is about 200 to 300 documents. |
| Linked disk files | Chromium with the File System Access API. Firefox and Safari use a download fallback. |
| Installation | Optional. Use the browser install action to add the PWA. |
| Layout | The interface is tested from 320 CSS pixels wide to a desktop viewport. |

The web app needs no account, API key, extension, or configuration file.
The browser support table in the [README](../README.md#browser-and-desktop-support)
describes the test scope. The configured suites do not prove that every workflow
passes on every device.

### Desktop Complete (Beta)

| Platform | Release artifact | Requirement |
| --- | --- | --- |
| macOS | `deckmark_<version>_macOS_Apple-Silicon.dmg` | macOS 14 or later on an Apple Silicon Mac. |
| Windows x64 | `deckmark_<version>_x64-setup.exe` | WebView2. The installer can add WebView2 when it is absent. |
| Linux x64 | `deckmark_<version>_amd64.deb` or `deckmark_<version>_amd64.AppImage` | WebKitGTK 4.1 and the packaged native libraries. |

The Desktop workflow builds these targets from the same source tag as the stable
release. The installers are unsigned beta artifacts. macOS can show a Gatekeeper
warning, and Windows can show a SmartScreen warning. Compare each file with
`SHA256SUMS` and check the GitHub build provenance attestation before you install.

The Beta channel publishes these four installers from three operating-system
builds. A managed MSI package and a Fedora or openSUSE native package are not
part of this channel. `scripts/desktop-release-policy.mjs` is the single format
policy for the build, the collector and the download table in the release notes.

Desktop Complete installers are unsigned. Update delivery is on standby: the
application does not check for updates, does not contact an update server, and
never installs an update by itself. Download and install a new release
manually, and keep your JSON backups and exported files when you change
versions. The native verification boundary stays in the code with its tests for
a future signed release. See [Desktop updates](UPDATES.md) and the
[standby decision](decisions/desktop-updates-standby.md).

## Data retention and offline behavior

### IndexedDB retention

- Drafts, projects, assets, history, workspaces, and templates use IndexedDB in
  the current browser profile or Desktop data directory.
- Interface preferences use localStorage.
- The app requests persistent storage when the browser supports it. The browser
  can still evict site data when storage is low or when the user clears site data.
- Private browsing can remove storage when the session ends.
- Changing the browser profile, clearing site data, or removing the application
  data can remove all local drafts.
- Draft saves use a 400 ms delay. A browser or system crash can lose text that did
  not reach IndexedDB.
- Each document keeps at most 30 history versions for 30 days. Trash keeps
  documents for 30 days.
- A JSON backup is the recovery method for a lost browser profile. Browser
  storage is not a backup.

### PWA offline behavior

- The service worker caches the application shell, editors, rendering modules,
  fonts, and export modules for the active base path.
- The service worker scope is `/` on a custom domain and `/deckmark/` on the
  GitHub Pages project URL.
- The manifest ID is `/` on `https://www.deckmark.dev/` and `/deckmark/` on
  `https://thomascrouzet.github.io/deckmark/`. The ID is the installed
  application identity, not the navigation scope. The two IDs do not overlap.
- A browser can treat a manifest ID change as a new application. Installations
  made before this change keep their earlier identity until the user removes
  them. Remove the old Home Screen or browser entry, install the current site,
  and confirm that the drafts remain. Browser storage stays with the origin and
  is not erased by the manifest change.
- Unknown deep links open the app shell from the cache. A refresh of a deep link
  does not need a server route.
- The workflow builds the root for Cloudflare Pages and `/deckmark` for the
  independent GitHub Pages fallback.
- An application update waits for pending IndexedDB writes before it reloads.
  The update does not discard a draft that is not durable.
- Remote images are not part of the precache. Embed or import an image before
  you go offline.
- Each host has separate browser storage and a separate PWA installation. To move
  drafts between hosts, export a backup and restore it on the other host.

### Export and backup

Use **Settings > Export a backup** to keep a JSON copy outside browser storage.
A backup includes open and closed documents, projects, assets, workspaces, and
custom templates. It excludes trash, version history, browser file handles, and
Desktop path permissions. Provider keys and native disk permission grants are
not backup fields. Web provider keys stay in the origin's session storage, and
Desktop provider keys stay in the Desktop credential store. Native disk grants
stay on the desktop that created them. A backup never transfers any of them to
another host or origin. Optional encryption uses AES-GCM and PBKDF2. An
encrypted backup cannot be recovered without its passphrase.

Markdown, HTML, PDF, library ZIP, and project ZIP exports are separate portable
copies. Use the project ZIP when relative links and local assets must stay
together. See [backups and storage health](USER_GUIDE.md#backups-and-storage-health).

## Native disk editing and the filesystem boundary

Desktop Complete adds in-place editing for files that the user selects. The
native picker or an operating-system open event approves a path. Rust returns an
opaque session token for that path. JavaScript cannot add a path to the native
access registry.

The application writes through a same-directory temporary file, synchronizes it,
checks the content revision, and then replaces the target. It keeps permissions
and refuses traversal, unsupported extensions, and an existing rename target.
An external edit requires an explicit decision. A noncooperating process can
still change a file after the final check. These operations are not a
filesystem-wide compare-and-swap.

The boundary is deliberate. Desktop Complete does not provide unrestricted
filesystem access to the WebView, background scanning of the disk, or a general
file browser.

## AI and network privacy

- AI is optional and disabled by default in both editions.
- Web Light keeps the provider key in page memory and tab session storage. A
  reload restores it, and a browser session restore can restore it. Browser
  storage is not a protected secret store, so do not reuse a provider key
  elsewhere. **Forget key** removes the stored key.
- Desktop Complete writes the provider key to the operating-system credential
  store after entry in Settings. Stored keys are not returned to the WebView.
  Rust binds each key to the full canonical endpoint and reads it for each
  request. Old host-only entries require key re-entry.
- The native AI boundary allows `https` endpoints and `http` only for loopback.
  It rejects user information, fragments, and redirects, and it returns stable
  error codes without the key or the response body.
- Sending local content always needs an explicit selection. Remote content
  cannot instruct a tool action.
- The app has no product account, backend, cloud storage, telemetry, or runtime
  CDN.
- The app contacts its host to load application files. Desktop update delivery
  is on standby, so no update check runs. Documents stay local unless you send
  selected context to an AI provider.
- Remote images are blocked by default. A user action can fetch an approved
  remote image. That action contacts the image host and reveals the client IP
  address. The request sends no cookies or referrer and rejects redirects.

## Hosting and downloads

### Web Light

Web Light has two independent production sites:

| Site | Publisher | Build base path |
| --- | --- | --- |
| `https://www.deckmark.dev/` | Cloudflare Pages project `deckmark` | Root |
| `https://thomascrouzet.github.io/deckmark/` | GitHub Pages fallback | `/deckmark` |

Both sites publish the same source commit after the build, E2E, and Lighthouse
checks pass. Cloudflare Pages receives the tested root artifact. GitHub Pages
receives the tested project-site artifact. Each site works without a redirect
through the other host.

The existing Cloudflare custom domain and DNS records remain in place. GitHub
Pages has no custom domain or `CNAME` file. The deployment needs the CI secrets
`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. Missing secrets cause a failure.
The browser app needs no hosting credentials, backend, or telemetry.

`edition.json` identifies the source commit, version, and base path at each site.
Production browser checks verify these values, startup, saved edits, and offline
use at both public URLs. A daily check detects stale sites and starts the same
gated deployment workflow. The detection run fails with a repair message.
Post-deployment checks must pass before the repair is confirmed.

The build writes the manifest identity for its base path. The canonical host
keeps `/`. The GitHub Pages build writes `/deckmark/`, so an unrelated project
application on the same `thomascrouzet.github.io` origin cannot share its install
identity. `start_url` and `scope` stay relative and resolve under the same
project path. After a change to the manifest identity, check both hosts:

1. In the browser application panel, read the effective manifest `id`,
   `start_url` and `scope` at the served URL.
2. Keep a draft, then install the site in a fresh browser profile. Confirm that
   the installed app opens offline and that the draft remains.
3. If an installed copy uses the earlier identity, remove that copy and install
   the current site once. Confirm that the origin still shows the earlier
   drafts. Do not expect the browser to merge two installed identities.
4. Repeat the check on Chromium, Android Chromium, and Safari Home Screen. The
   engines interpret manifest identity differently; record each result.

The sites do not share drafts or PWA installations. Export a backup from one
origin and restore it on the other to move local data. See
[Web publishing](DEVELOPMENT.md#web-publishing) for maintainer steps and
[hosting checks](TESTING.md#edition-and-hosting-checks) for verification.

### Desktop Complete

Desktop artifacts use the separate `desktop-v<version>` prerelease. The release
page also lists the stable source releases. Select the `desktop-v<version>`
prerelease for the installers, `SHA256SUMS`, and provenance records.

The Desktop release workflow does not publish to GitHub Pages. The Web workflow
does not publish Desktop installers.

## Support boundaries

- Support is community-based and best effort. The project does not provide
  account recovery, cloud data recovery, or recovery of an encrypted backup
  without its passphrase.
- Browser tests cover Chromium desktop and mobile workflows. Firefox and Safari
  cover selected workflows. The test scope is not a guarantee for every device,
  extension, input method, or network condition.
- Desktop installers are unsigned. The project cannot claim a warning-free
  installation.
- Desktop Complete has no update check. Update delivery is on standby, and the
  user installs every new release manually.
- A browser or operating-system kill can lose text inside the 400 ms save delay.
- Browser file APIs cannot make the final revision check and write atomic. Avoid
  simultaneous writes to a linked file.
- Both editions use the same Markdown, project ZIP, and backup formats. The
  portable project tests cover the round trip, but an unknown future metadata
  field can still need a newer release.
- Cloud sync, shared editing, accounts, plugins, a browser API key vault, and
  unrestricted filesystem access are unavailable. AI is optional in both editions.
  Git, the native vault, and quick capture are Desktop Complete features. Signed update delivery is
  implemented but dormant while it is on standby.

### Project capability matrix

The TypeScript limits in `src/lib/project-limits.ts` and the Rust limits in
`src-tauri/src/projects.rs` must agree. One project budget applies to portable
import and export, native pick, reconnect and refresh, directory drag and drop,
internal copy and move, and documentation-site export.

| Capability | Web Light | Desktop Complete |
| --- | --- | --- |
| Documents | 300 | 3,000 |
| Entries (documents and assets) | 1,300 | 6,500 |
| Uncompressed project bytes | 64 MiB | 256 MiB |
| Directory levels | 8 | 16 |
| One document | 16 MiB | 16 MiB |
| One image | 2 MiB | 2 MiB |

A backup is a separate JSON recovery format with its own 64 MiB import budget.
A Desktop project that is valid at 256 MiB can therefore be too large for that
JSON route. Use the project ZIP for portable recovery of such a project.

The entry limit counts stored documents and assets. An import into an existing
project reserves three entries for the generated project manifest and link
report. A new project ZIP may use the full stored entry count, and its export
fails if the generated metadata would exceed the same limit.


## Release note checklist

Each release note must:

- identify the edition that changed;
- list the tested platforms and the known test limits;
- link to Web Light and the applicable `desktop-v<version>` prerelease;
- state the installer signing status;
- state any document, project, backup, or schema migration;
- describe Web Light as a complete free edition, not a trial.
