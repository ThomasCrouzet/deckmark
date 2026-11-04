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

GitHub Pages publishes Web Light. The separate Desktop release channel publishes
Desktop Complete. No other Web host, proxy, or application server is part of the
production path.

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
records the edition, version, base path, features, and excluded capabilities.
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
| In-place disk editing with revision checks | Limited to supported browser file links | Yes, with native path capabilities and revision checks |
| Service worker application update | Yes | No. Install a new Desktop release. |
| First-class code and JSON files | Yes | Yes |
| Ephemeral Read-mode ink annotations | Yes | Yes |
| Image annotation canvas and flattened PNG export | Yes | Yes |
| Optional OpenAI-compatible AI connection | Yes, disabled by default, with a session-only browser key and explicit consent | Yes, disabled by default |
| Secure native API key vault | No. A browser-resident key is not a protected secret. | Not available in this release. |
| Secure browser API key vault | Unavailable | Unavailable |
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
| Windows x64 | `deckmark_<version>_x64-setup.exe` or `.msi` | WebView2. The installer can add WebView2 when it is absent. |
| Linux x64 | `.AppImage`, `.deb`, or `.rpm` | WebKitGTK 4.1 and the packaged native libraries. |

The Desktop workflow builds these targets from the same source tag as the stable
release. The installers are unsigned beta artifacts. macOS can show a Gatekeeper
warning, and Windows can show a SmartScreen warning. Compare each file with
`SHA256SUMS` and check the GitHub build provenance attestation before you install.

Desktop Complete has no automatic update channel. Download and install a new
release to update. Keep your JSON backups and exported files when you change
versions.

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
- Unknown deep links open the app shell from the cache. A refresh of a deep link
  does not need a server route.
- The workflow builds the base path that GitHub Pages reports. A custom domain
  uses the root. A project site uses `/deckmark/`.
- An application update waits for pending IndexedDB writes before it reloads.
  The update does not discard a draft that is not durable.
- Remote images are not part of the precache. Embed or import an image before
  you go offline.
- A PWA installed on the project URL keeps that origin. Install the app again
  from the custom domain after a domain change.

### Export and backup

Use **Settings > Export a backup** to keep a JSON copy outside browser storage.
A backup includes open and closed documents, projects, assets, workspaces, and
custom templates. It excludes trash, version history, browser file handles, and
Desktop path permissions. Optional encryption uses AES-GCM and PBKDF2. An
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

- DeckMark has no AI feature in this release. It has no model, prompt, AI
  network request, or AI settings.
- The Web client has no secure API key vault. Do not put provider secrets or
  other credentials in browser storage or in a Web build.
- The app has no product account, backend, cloud storage, telemetry, or runtime
  CDN.
- The app contacts its host to load and update application files. It does not
  upload documents.
- Remote images are blocked by default. A user action can fetch an approved
  remote image. That action contacts the image host and reveals the client IP
  address. The request sends no cookies or referrer and rejects redirects.
- If a later release adds an AI feature, it needs a separate privacy design,
  explicit user consent, and a documented network boundary. It is not part of
  the current product.

## Hosting and downloads

### Web Light

GitHub Pages is the only production publisher. The deployment workflow does not
use Cloudflare, Workers, a proxy, or an application server. It does not need
Cloudflare credentials, API tokens, or a Cloudflare Pages account.

The workflow keeps two build checks:

1. The production base path that GitHub Pages reports.
2. The other supported base path, either the root or `/deckmark/`.

The production build supplies the Pages artifact. The second build detects
absolute path and cache errors in the other hosting mode.

The official URL `https://www.deckmark.dev/` needs a custom domain. The workflow
does not set that domain or change DNS. A maintainer must complete these steps:

1. In the repository **Settings > Pages**, set the custom domain to
   `www.deckmark.dev`.
2. At the DNS provider, create or verify the record that GitHub Pages shows.
   For a `www` host, this is usually a CNAME record to
   `thomascrouzet.github.io`. Confirm the current value in the Pages settings.
3. Wait for the DNS check to pass, then enable **Enforce HTTPS**.
4. Run the **Deploy to GitHub Pages** workflow, or push a merge to `main`.
5. After the first root deployment, update the required `build` checks in branch
   protection if their names changed.

After the domain check passes, the workflow reads the new base path and deploys
the root build. GitHub Pages then redirects the project URL
`https://thomascrouzet.github.io/deckmark/` to the custom domain. The redirect
does not keep a separate native project-site origin.

Until the custom domain is active, use the GitHub Pages fallback
`https://thomascrouzet.github.io/deckmark/`. Do not claim that the custom domain
works before GitHub Pages and DNS report success.

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
- Desktop Complete has no auto-update channel.
- A browser or operating-system kill can lose text inside the 400 ms save delay.
- Browser file APIs cannot make the final revision check and write atomic. Avoid
  simultaneous writes to a linked file.
- Both editions use the same Markdown, project ZIP, and backup formats.
  Cross-edition round-trip tests are planned. Do not treat them as a current
  guarantee.
- AI, cloud sync, shared editing, accounts, plugins, a browser API key vault, and
  unrestricted filesystem access are unavailable.

## Release note checklist

Each release note must:

- identify the edition that changed;
- list the tested platforms and the known test limits;
- link to Web Light and the applicable `desktop-v<version>` prerelease;
- state the installer signing status;
- state any document, project, backup, or schema migration;
- describe Web Light as a complete free edition, not a trial.
