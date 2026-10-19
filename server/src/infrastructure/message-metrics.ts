import { timingSafeEqual } from 'crypto';
import { readFileSync } from 'fs';
import type { RequestHandler } from 'express';

const counters = new Map<string, number>();
const gauges = new Map<string, number>();
const bounds = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60];
const histograms = new Map<string, { count: number; sum: number; buckets: number[] }>();
// Names are fixed in application code; never use user IDs, rooms or message content.
export const countMessageMetric = (name: string): void => {
	counters.set(name, (counters.get(name) || 0) + 1);
};
export const setMessageGauge = (name: string, value: number): void => {
	if (Number.isFinite(value)) gauges.set(name, value);
};
export const observeMessageMetric = (name: string, seconds: number): void => {
	if (!Number.isFinite(seconds) || seconds < 0) return;
	const row = histograms.get(name) || { count: 0, sum: 0, buckets: bounds.map(() => 0) };
	row.count++;
	row.sum += seconds;
	bounds.forEach((bound, i) => {
		if (seconds <= bound) row.buckets[i]++;
	});
	histograms.set(name, row);
};
export const renderMessageMetrics = (): string => {
	const lines: string[] = [];
	for (const [name, value] of counters) lines.push(`# TYPE ${name} counter`, `${name} ${value}`);
	for (const [name, value] of gauges) lines.push(`# TYPE ${name} gauge`, `${name} ${value}`);
	for (const [name, row] of histograms) {
		lines.push(`# TYPE ${name} histogram`);
		bounds.forEach((bound, i) => lines.push(`${name}_bucket{le="${bound}"} ${row.buckets[i]}`));
		lines.push(
			`${name}_bucket{le="+Inf"} ${row.count}`,
			`${name}_sum ${row.sum}`,
			`${name}_count ${row.count}`
		);
	}
	return lines.join('\n') + '\n';
};
/** Opt-in, authenticated scrape endpoint. */
export const messageMetricsHandler: RequestHandler = (req, res) => {
	const secret = process.env.METRICS_TOKEN;
	const supplied = req.headers.authorization || '';
	const expected = `Bearer ${secret || ''}`;
	if (
		!secret ||
		Buffer.byteLength(supplied) !== Buffer.byteLength(expected) ||
		!timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
	) {
		res.sendStatus(404);
		return;
	}
	res.setHeader('Cache-Control', 'no-store');
	const backupStatus = process.env.BACKUP_STATUS_FILE;
	setMessageGauge('pomelo_backup_monitoring_enabled', backupStatus ? 1 : 0);
	if (backupStatus) {
		let timestamp = 0;
		try { const row = JSON.parse(readFileSync(backupStatus, 'utf8')); if (Number.isFinite(row.lastSuccess) && row.lastSuccess > 0) timestamp = row.lastSuccess; } catch { /* missing or invalid status is unhealthy */ }
		setMessageGauge('pomelo_backup_last_success_timestamp_seconds', timestamp);
	}
	res.type('text/plain; version=0.0.4').send(renderMessageMetrics());
};
