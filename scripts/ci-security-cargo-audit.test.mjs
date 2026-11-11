import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HELPER = join(ROOT, 'scripts', 'ci-security-cargo-audit.sh');

const FAKE_CARGO = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$CALL_LOG"
root=''
version=''
while [ $# -gt 0 ]; do
  case "$1" in
    --root) root=$2; shift 2 ;;
    --version) version=$2; shift 2 ;;
    *) shift ;;
  esac
done
test -n "$root"
test "$version" = '0.22.2'
mkdir -p "$root/bin"
cat > "$root/bin/cargo-audit" <<'EOF'
#!/usr/bin/env bash
if [ "\${1:-}" = '--version' ]; then
  echo 'cargo-audit 0.22.2'
  exit 0
fi
printf '%s\\n' "\$*" >> "\${AUDIT_LOG:?}"
EOF
chmod +x "$root/bin/cargo-audit"
`;

function fixture() {
	const home = mkdtempSync(join(tmpdir(), 'ci-cargo-audit-'));
	const bin = join(home, 'fake-bin');
	const cache = join(home, '.cache', 'cargo-audit');
	mkdirSync(bin, { recursive: true });
	mkdirSync(join(cache, 'bin'), { recursive: true });
	writeFileSync(join(bin, 'cargo'), FAKE_CARGO);
	chmodSync(join(bin, 'cargo'), 0o755);
	const env = {
		...process.env,
		HOME: home,
		PATH: `${bin}:/usr/bin:/bin`,
		CALL_LOG: join(home, 'cargo-calls.log'),
		AUDIT_LOG: join(home, 'audit-calls.log')
	};
	return {
		home,
		bin,
		cache,
		env,
		writeAuditBinary: (version) => {
			const path = join(cache, 'bin', 'cargo-audit');
			writeFileSync(
				path,
				`#!/usr/bin/env bash\nif [ "\${1:-}" = '--version' ]; then echo 'cargo-audit ${version}'; exit 0; fi\nprintf '%s\\n' "$*" >> "$AUDIT_LOG"\n`
			);
			chmodSync(path, 0o755);
		},
		run: (args) => spawnSync('bash', [HELPER, ...args], { env, encoding: 'utf8' }),
		cleanup: () => rmSync(home, { recursive: true, force: true })
	};
}

test('a matching cached cargo-audit is reused without installing', () => {
	const data = fixture();
	try {
		data.writeAuditBinary('0.22.2');
		const result = data.run(['ensure']);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /cache hit/i);
		assert.equal(existsSync(data.env.CALL_LOG), false);
	} finally {
		data.cleanup();
	}
});

test('a stale cached cargo-audit is replaced by the pinned version', () => {
	const data = fixture();
	try {
		data.writeAuditBinary('0.21.0');
		const result = data.run(['ensure']);
		assert.equal(result.status, 0, result.stderr);
		const calls = readFileSync(data.env.CALL_LOG, 'utf8');
		assert.match(calls, /install cargo-audit --locked --version 0\.22\.2/);
		const version = spawnSync(join(data.cache, 'bin', 'cargo-audit'), ['--version'], {
			env: data.env,
			encoding: 'utf8'
		});
		assert.equal(version.stdout.trim(), 'cargo-audit 0.22.2');
	} finally {
		data.cleanup();
	}
});

test('a cached binary whose version only starts with the pin is not reused', () => {
	// A substring test would accept 0.22.20 for the 0.22.2 pin. The check must
	// compare the exact reported version.
	const data = fixture();
	try {
		data.writeAuditBinary('0.22.20');
		const result = data.run(['ensure']);
		assert.equal(result.status, 0, result.stderr);
		assert.doesNotMatch(result.stdout, /cache hit/i);
		const calls = readFileSync(data.env.CALL_LOG, 'utf8');
		assert.match(calls, /install cargo-audit --locked --version 0\.22\.2/);
	} finally {
		data.cleanup();
	}
});

test('the audit mode passes the lock file and deny policy to cargo-audit', () => {
	const data = fixture();
	try {
		data.writeAuditBinary('0.22.2');
		const result = data.run(['audit', 'src-tauri/Cargo.lock']);
		assert.equal(result.status, 0, result.stderr);
		const calls = readFileSync(data.env.AUDIT_LOG, 'utf8').trim();
		assert.equal(calls, 'audit --file src-tauri/Cargo.lock --deny unsound');
	} finally {
		data.cleanup();
	}
});
