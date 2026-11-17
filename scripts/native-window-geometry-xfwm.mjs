import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const manager = spawn('xfwm4', ['--replace', '--sm-client-disable'], { stdio: 'inherit' });
let smoke;
try {
	let ready = false;
	for (let attempt = 0; attempt < 100; attempt++) {
		const probe = spawnSync('xprop', ['-root', '_NET_SUPPORTING_WM_CHECK'], {
			encoding: 'utf8'
		});
		if (probe.status === 0 && /window id # 0x[1-9a-f]/i.test(probe.stdout)) {
			ready = true;
			break;
		}
		if (manager.exitCode !== null) throw new Error(`xfwm4 exited ${manager.exitCode}`);
		await delay(100);
	}
	if (!ready) throw new Error('xfwm4 did not advertise a window manager');
	smoke = spawn(process.execPath, ['scripts/native-window-geometry.mjs'], {
		stdio: 'inherit',
		env: process.env
	});
	const result = await new Promise((resolve, reject) => {
		smoke.once('error', reject);
		smoke.once('exit', (code, signal) => resolve({ code, signal }));
	});
	if (result.code !== 0) process.exitCode = result.code || 1;
} finally {
	if (smoke && smoke.exitCode === null) smoke.kill('SIGTERM');
	if (manager.exitCode === null) manager.kill('SIGTERM');
}
