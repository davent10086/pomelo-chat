/** Coalesce invalidations without cancelling useful work or losing a trailing update. */
export class CoalescedRefresh<T> {
	private timer?: ReturnType<typeof setTimeout>;
	private controller?: AbortController;
	private flight?: Promise<T | undefined>;
	private dirty = false;
	private nextStart = 0;

	constructor(
		private readonly load: (signal: AbortSignal) => Promise<T>,
		private readonly onResult: (value: T) => void,
		private readonly onError: () => void,
		private readonly intervalMs = 500
	) {}

	invalidate(): void {
		this.dirty = true;
		if (this.flight || this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.refresh();
		}, Math.max(this.intervalMs, this.nextStart - Date.now()));
	}

	refresh(): Promise<T | undefined> {
		if (this.flight) return this.flight;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.dirty = false;
		const controller = new AbortController();
		this.controller = controller;
		this.nextStart = Date.now() + this.intervalMs;
		this.flight = Promise.resolve().then(() => this.load(controller.signal)).then(value => {
			if (controller.signal.aborted) return;
			this.onResult(value);
			return value;
		}).catch(() => {
			if (!controller.signal.aborted) this.onError();
			return undefined;
		}).finally(() => {
			if (this.controller !== controller) return;
			this.flight = undefined;
			this.controller = undefined;
			if (this.dirty) this.invalidate();
		});
		return this.flight;
	}

	cancel(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.dirty = false;
		this.controller?.abort();
		this.controller = undefined;
		this.flight = undefined;
		this.nextStart = 0;
	}
}
