import assert from 'node:assert/strict';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const script = new URL('./configure-ubuntu-apt.sh', import.meta.url);

const deb822 = `Types: deb
URIs: mirror+file:/etc/apt/apt-mirrors.txt
Suites: noble noble-updates
Components: main universe
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

Types: deb
URIs: http://security.ubuntu.com/ubuntu
Suites: noble-security
Components: main universe
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
`;

const mirrors = `http://azure.archive.ubuntu.com/ubuntu/ priority:2
http://archive.ubuntu.com/ubuntu/ priority:1
`;

// Exact shape of /etc/apt/sources.list.d/ubuntu.sources on the Ubuntu 24.04
// runner image. The file starts with a comment paragraph, then an unseparated
// comment header directly above the first stanza.
const runnerSources = `# See http://help.ubuntu.com/community/UpgradeNotes for how to upgrade to
# newer versions of the distribution.

## Ubuntu distribution repository
##
## The following settings can be adjusted to configure which packages to use from Ubuntu.
## Mirror your choices (except for URIs and Suites) in the security section below to
## ensure timely security updates.
##
## Types: Append deb-src to enable the fetching of source package.
## URIs: A URL to the repository (you may add multiple URLs)
## Suites: The following additional suites can be configured
##   <name>-updates   - Major bug fix updates produced after the final release of the
##                      distribution.
##   <name>-backports - software from this repository may not have been tested as
##                      extensively as that contained in the main release, although it includes
##                      newer versions of some applications which may provide useful features.
##                      Also, please note that software in backports WILL NOT receive any review
##                      or updates from the Ubuntu security team.
## Components: Aside from main, the following components can be added to the list
##   restricted  - Software that may not be under a free license, or protected by patents.
##   universe    - Community maintained packages. Software in this repository receives maintenance
##                 from volunteers in the Ubuntu community, or a 10 year security maintenance
##                 commitment from Canonical when an Ubuntu Pro subscription is attached.
##   multiverse  - Community maintained of restricted. Software from this repository is
##                 ENTIRELY UNSUPPORTED by the Ubuntu team, and may not be under a free
##                 licence. Please satisfy yourself as to your rights to use the software.
##                 Also, please note that software in multiverse WILL NOT receive any
##                 review or updates from the Ubuntu security team.
##
## See the sources.list(5) manual page for further settings.
Types: deb
URIs: http://archive.ubuntu.com/ubuntu/
Suites: noble noble-updates noble-backports
Components: main universe restricted multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

## Ubuntu security updates. Aside from URIs and Suites,
## this should mirror your choices in the previous section.
Types: deb
URIs: http://security.ubuntu.com/ubuntu/
Suites: noble-security
Components: main universe restricted multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
`;

function shim(directory, name, body) {
	const path = join(directory, name);
	writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
	chmodSync(path, 0o755);
}

function fixture(options = {}) {
	const root = mkdtempSync(join(tmpdir(), 'deckmark-apt-'));
	const apt = join(root, 'etc', 'apt');
	const state = join(root, 'shim-state');
	const bin = join(root, 'bin');
	mkdirSync(join(apt, 'sources.list.d'), { recursive: true });
	mkdirSync(join(apt, 'apt.conf.d'), { recursive: true });
	mkdirSync(state, { recursive: true });
	mkdirSync(bin, { recursive: true });

	if (options.mirrors !== null) {
		writeFileSync(join(apt, 'apt-mirrors.txt'), options.mirrors ?? mirrors);
	}
	if (options.sources !== null) {
		writeFileSync(join(apt, 'sources.list.d', 'ubuntu.sources'), options.sources ?? deb822);
	}
	writeFileSync(join(apt, 'sources.list'), options.oneLine ?? '');

	writeFileSync(join(state, 'dns'), options.dns ?? '');
	writeFileSync(join(state, 'http'), options.http ?? '');
	writeFileSync(join(state, 'default_code'), options.defaultCode ?? '200');
	writeFileSync(join(state, 'apt_exit'), options.aptExit ?? '0');
	writeFileSync(join(state, 'apt_stdout'), options.aptStdout ?? '');
	writeFileSync(join(state, 'apt_stderr'), options.aptStderr ?? '');
	writeFileSync(join(state, 'curl.log'), '');
	writeFileSync(join(state, 'getent.log'), '');
	writeFileSync(join(state, 'apt.log'), '');
	writeFileSync(join(state, 'sudo.log'), '');

	shim(
		bin,
		'getent',
		`host="\${!#}"
printf '%s\\n' "$host" >> "$SHIM_STATE_DIR/getent.log"
if grep -qsx "$host fail" "$SHIM_STATE_DIR/dns"; then exit 2; fi
printf '127.0.0.1 %s\\n' "$host"`
	);
	shim(
		bin,
		'curl',
		`url=""
for arg in "$@"; do case "$arg" in http://*|https://*) url="$arg";; esac; done
printf '%s\\n' "$url" >> "$SHIM_STATE_DIR/curl.log"
code=""
while read -r match value; do if [ "$match" = "$url" ]; then code="$value"; fi; done < "$SHIM_STATE_DIR/http"
if [ -z "$code" ]; then code=$(cat "$SHIM_STATE_DIR/default_code"); fi
printf '%s' "$code"`
	);
	shim(
		bin,
		'apt-get',
		`printf '%s\\n' "$*" >> "$SHIM_STATE_DIR/apt.log"
cat "$SHIM_STATE_DIR/apt_stdout"
cat "$SHIM_STATE_DIR/apt_stderr" >&2
exit "$(cat "$SHIM_STATE_DIR/apt_exit")"`
	);
	// The host must stay untouched even if the helper asks for privilege.
	shim(
		bin,
		'sudo',
		`printf '%s\\n' "$*" >> "$SHIM_STATE_DIR/sudo.log"
exit 1`
	);

	const env = {
		...process.env,
		PATH: `${bin}:/usr/bin:/bin`,
		SHIM_STATE_DIR: state,
		MDSH_APT_MIRROR_FILE: join(apt, 'apt-mirrors.txt'),
		MDSH_APT_CONF: join(apt, 'apt.conf.d', 'zzz-mdsh-ci-network'),
		MDSH_APT_SOURCES_DIR: join(apt, 'sources.list.d'),
		MDSH_APT_SOURCES_LIST: join(apt, 'sources.list'),
		MDSH_APT_SUDO: '',
		MDSH_PROBE_TIMEOUT: '2',
		...(options.env ?? {})
	};
	return { root, apt, state, bin, env };
}

function run(context, args = []) {
	return spawnSync('/bin/bash', [script.pathname, ...args], {
		env: context.env,
		encoding: 'utf8'
	});
}

function read(context, relative) {
	return readFileSync(join(context.apt, relative), 'utf8');
}

function readState(context, name) {
	return readFileSync(join(context.state, name), 'utf8');
}

test('a healthy runner configuration passes and keeps every source', () => {
	const context = fixture();
	const result = run(context);
	assert.equal(result.status, 0, result.stderr);
	const sources = read(context, 'sources.list.d/ubuntu.sources');
	assert.match(sources, /URIs: http:\/\/security\.ubuntu\.com\/ubuntu/);
	assert.match(sources, /mirror\+file:\/etc\/apt\/apt-mirrors\.txt/);
	const conf = read(context, 'apt.conf.d/zzz-mdsh-ci-network');
	assert.match(conf, /Acquire::Retries "1";/);
	assert.match(conf, /Acquire::http::Timeout "15";/);
	assert.match(conf, /Acquire::https::Timeout "15";/);
	const mirrorList = read(context, 'apt-mirrors.txt');
	assert.match(mirrorList, /azure\.archive\.ubuntu\.com\/ubuntu\/ priority:2/);
	assert.match(mirrorList, /archive\.ubuntu\.com\/ubuntu\/ priority:1/);
	assert.equal(readState(context, 'apt.log'), '');
	assert.equal(readState(context, 'sudo.log'), '');
});

test('the stock runner source shape passes and keeps both stanzas', () => {
	const context = fixture({ sources: runnerSources });
	const result = run(context);
	assert.equal(result.status, 0, result.stderr);
	const sources = read(context, 'sources.list.d/ubuntu.sources');
	assert.equal(sources, runnerSources);
	const curlLog = readState(context, 'curl.log');
	assert.match(curlLog, /archive\.ubuntu\.com\/ubuntu\/dists\/noble\/InRelease/);
	assert.match(curlLog, /security\.ubuntu\.com\/ubuntu\/dists\/noble-security\/InRelease/);
	assert.equal(readState(context, 'sudo.log'), '');
});

test('a comment-only header paragraph is not a source stanza', () => {
	const sources = `## Repository header
## Types: deb
## URIs: http://example.invalid/ubuntu
## Suites: noble

Types: deb
URIs: http://archive.ubuntu.com/ubuntu/
Suites: noble
Components: main
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
`;
	const context = fixture({ sources });
	const result = run(context);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(read(context, 'sources.list.d/ubuntu.sources'), sources);
});

test('a dead security host moves to a mirror that serves the same suite', () => {
	const context = fixture({ dns: 'security.ubuntu.com fail\n' });
	const result = run(context);
	assert.equal(result.status, 0, result.stderr);
	const sources = read(context, 'sources.list.d/ubuntu.sources');
	assert.doesNotMatch(sources, /security\.ubuntu\.com/);
	assert.match(sources, /URIs: http:\/\/archive\.ubuntu\.com\/ubuntu\nSuites: noble-security/);
	assert.match(`${result.stdout}${result.stderr}`, /noble-security/);
	const curlLog = readState(context, 'curl.log');
	assert.doesNotMatch(curlLog, /security\.ubuntu\.com/);
});

test('a failing suite with no serving mirror fails fast and names the suite', () => {
	const context = fixture({
		dns: 'security.ubuntu.com fail\n',
		http: `${'http://archive.ubuntu.com/ubuntu/dists/noble-security/InRelease'} 404\n${'http://azure.archive.ubuntu.com/ubuntu/dists/noble-security/InRelease'} 404\n`
	});
	const result = run(context);
	assert.notEqual(result.status, 0);
	assert.match(`${result.stdout}${result.stderr}`, /noble-security/);
	assert.match(`${result.stdout}${result.stderr}`, /security\.ubuntu\.com/);
	assert.equal(readState(context, 'apt.log'), '');
});

test('unreachable Ubuntu sources fail before any package work', () => {
	const context = fixture({
		dns: 'security.ubuntu.com fail\narchive.ubuntu.com fail\nazure.archive.ubuntu.com fail\n'
	});
	const started = Date.now();
	const result = run(context);
	const elapsed = Date.now() - started;
	assert.notEqual(result.status, 0);
	assert.match(`${result.stdout}${result.stderr}`, /unreachable|No reachable/i);
	assert.equal(readState(context, 'apt.log'), '');
	assert.ok(elapsed < 15000, `took ${elapsed} ms`);
});

test('a malformed deb822 source fails closed and names the file', () => {
	for (const sources of [
		'Types: deb\nSuites: noble\nComponents: main\n',
		'URIs: http://archive.ubuntu.com/ubuntu\nComponents: main\n',
		'Types: deb\nURIs: http://archive.ubuntu.com/ubuntu\nComponents: main\n',
		'# Header comment\n\nTypes: deb\nSuites: noble\nComponents: main\n'
	]) {
		const context = fixture({ sources });
		const result = run(context);
		assert.notEqual(result.status, 0, sources);
		assert.match(`${result.stdout}${result.stderr}`, /ubuntu\.sources/);
	}
});

test('no Ubuntu source configuration fails closed', () => {
	const context = fixture({ sources: null, oneLine: '' });
	const result = run(context);
	assert.notEqual(result.status, 0);
	assert.match(`${result.stdout}${result.stderr}`, /source/i);
});

test('a missing mirror list still repairs a dead security host', () => {
	const context = fixture({ mirrors: null, dns: 'security.ubuntu.com fail\n' });
	const result = run(context);
	assert.equal(result.status, 0, result.stderr);
	const sources = read(context, 'sources.list.d/ubuntu.sources');
	assert.doesNotMatch(sources, /security\.ubuntu\.com/);
	assert.match(sources, /URIs: http:\/\/archive\.ubuntu\.com\/ubuntu\nSuites: noble-security/);
	assert.match(`${result.stdout}${result.stderr}`, /mirror/i);
});

test('a one-line sources.list entry is parsed and repaired', () => {
	const context = fixture({
		sources: null,
		oneLine:
			'deb http://archive.ubuntu.com/ubuntu noble main universe\ndeb http://security.ubuntu.com/ubuntu noble-security main universe\n',
		dns: 'security.ubuntu.com fail\n',
		// A real archive serves suites, not components. Without per-URL codes
		// a parser that probes dists/main and dists/universe would pass.
		defaultCode: '404',
		http: `${'http://archive.ubuntu.com/ubuntu/dists/noble/InRelease'} 200\n${'http://archive.ubuntu.com/ubuntu/dists/noble-security/InRelease'} 200\n`
	});
	const result = run(context);
	assert.equal(result.status, 0, result.stderr);
	const sources = read(context, 'sources.list');
	assert.match(sources, /^deb http:\/\/archive\.ubuntu\.com\/ubuntu noble main universe$/m);
	assert.match(
		sources,
		/^deb http:\/\/archive\.ubuntu\.com\/ubuntu noble-security main universe$/m
	);
	assert.doesNotMatch(sources, /security\.ubuntu\.com/);
	assert.doesNotMatch(readState(context, 'curl.log'), /dists\/(?:main|universe)\//);
});

test('a one-line source keeps options, suite and components after repair', () => {
	const options = '[arch=amd64 signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg]';
	const context = fixture({
		sources: null,
		oneLine: `deb ${options} http://archive.ubuntu.com/ubuntu noble main universe\ndeb-src ${options} http://security.ubuntu.com/ubuntu noble-security main\n`,
		dns: 'security.ubuntu.com fail\n',
		defaultCode: '404',
		http: `${'http://archive.ubuntu.com/ubuntu/dists/noble/InRelease'} 200\n${'http://archive.ubuntu.com/ubuntu/dists/noble-security/InRelease'} 200\n`
	});
	const result = run(context);
	assert.equal(result.status, 0, result.stderr);
	const sources = read(context, 'sources.list');
	assert.match(
		sources,
		new RegExp(
			`^deb ${options.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} http://archive\\.ubuntu\\.com/ubuntu noble main universe$`,
			'm'
		)
	);
	assert.match(
		sources,
		new RegExp(
			`^deb-src ${options.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} http://archive\\.ubuntu\\.com/ubuntu noble-security main$`,
			'm'
		)
	);
	assert.doesNotMatch(sources, /security\.ubuntu\.com/);
	assert.doesNotMatch(readState(context, 'curl.log'), /dists\/main\//);
});

test('a non-Ubuntu source is never rewritten', () => {
	const context = fixture({
		sources: `${deb822}
Types: deb
URIs: https://packages.microsoft.com/ubuntu/24.04/prod
Suites: noble
Components: main
`
	});
	const result = run(context);
	assert.equal(result.status, 0, result.stderr);
	assert.match(read(context, 'sources.list.d/ubuntu.sources'), /packages\.microsoft\.com/);
});

test('index verification rejects a refresh that silently ignored failures', () => {
	const context = fixture({
		env: { MDSH_APT_VERIFY_INDEX: '1' },
		aptStderr:
			'W: Failed to fetch http://security.ubuntu.com/ubuntu/dists/noble-security/InRelease\n'
	});
	const result = run(context);
	assert.notEqual(result.status, 0);
	assert.match(`${result.stdout}${result.stderr}`, /Failed to fetch/);
	assert.match(readState(context, 'apt.log'), /^update/);
});

test('index verification passes a complete refresh', () => {
	const context = fixture({ env: { MDSH_APT_VERIFY_INDEX: '1' } });
	const result = run(context);
	assert.equal(result.status, 0, result.stderr);
	const call = readState(context, 'apt.log');
	assert.match(call, /update/);
	assert.match(call, /Acquire::Retries=1/);
});

test('missing probe tools stop the helper with an explicit error', () => {
	const context = fixture();
	context.env.PATH = join(context.root, 'empty-bin');
	mkdirSync(context.env.PATH, { recursive: true });
	const result = run(context);
	assert.notEqual(result.status, 0);
	assert.match(`${result.stdout}${result.stderr}`, /curl|getent/);
});

test('the helper writes only inside the configured root', () => {
	const context = fixture({ dns: 'security.ubuntu.com fail\n' });
	assert.equal(run(context).status, 0);
	assert.ok(existsSync(join(context.apt, 'apt.conf.d', 'zzz-mdsh-ci-network')));
});
