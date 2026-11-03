// Sample the resident memory of an application process tree. The helper reads
// local process data only. It sends no telemetry and no network request.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';

/**
 * @param {number} pid
 * @returns {{ bytes: number, mb: number, processes: number | null }}
 */
export function processTreeMemory(pid) {
	if (process.platform === 'linux') {
		const rows = [];
		for (const entry of readdirSync('/proc')) {
			const childPid = Number(entry);
			if (!childPid) continue;
			try {
				const stat = readFileSync(`/proc/${childPid}/stat`, 'utf8');
				const close = stat.lastIndexOf(')');
				const fields = stat.slice(close + 2).split(' ');
				const status = readFileSync(`/proc/${childPid}/status`, 'utf8');
				const rss = /VmRSS:\s+(\d+)\s+kB/.exec(status);
				rows.push({
					pid: childPid,
					ppid: Number(fields[1]),
					bytes: rss ? Number(rss[1]) * 1024 : 0
				});
			} catch {
				// The process exited during the scan.
			}
		}
		return sumTree(pid, rows);
	}
	if (process.platform === 'darwin') {
		const output = execFileSync('ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8' });
		const rows = output
			.split('\n')
			.map((line) => line.trim().split(/\s+/))
			.filter((parts) => parts.length === 3)
			.map(([childPid, ppid, rss]) => ({
				pid: Number(childPid),
				ppid: Number(ppid),
				bytes: Number(rss) * 1024
			}));
		return sumTree(pid, rows);
	}
	const script = `$ids=@(${pid});$all=Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId;do{$n=@($all|Where-Object{$ids -contains $_.ParentProcessId}|ForEach-Object{$_.ProcessId}|Where-Object{$ids -notcontains $_});$ids+=$n}while($n.Count);(Get-Process -Id $ids -ErrorAction SilentlyContinue|Measure-Object WorkingSet64 -Sum).Sum`;
	const output = execFileSync(
		'powershell.exe',
		['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
		{ encoding: 'utf8', timeout: 10_000, windowsHide: true }
	).trim();
	const bytes = Number(output) || 0;
	return { bytes, mb: Number((bytes / (1024 * 1024)).toFixed(1)), processes: null };
}

/** @param {number} pid @param {Array<{ pid: number, ppid: number, bytes?: number }>} rows */
function sumTree(pid, rows) {
	const owned = new Set([pid]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const row of rows) {
			if (owned.has(row.ppid) && !owned.has(row.pid)) {
				owned.add(row.pid);
				changed = true;
			}
		}
	}
	const bytes = rows
		.filter((row) => owned.has(row.pid))
		.reduce((total, row) => total + (row.bytes ?? 0), 0);
	return {
		bytes,
		mb: Number((bytes / (1024 * 1024)).toFixed(1)),
		processes: owned.size
	};
}
