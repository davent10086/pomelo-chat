export type MotionPhase = 'collapsed' | 'expanding' | 'expanded' | 'collapsing';

/** A latest-intent controller. No native collapse can run after a newer expansion. */
export class AssistantMotion {
	private ticket = 0;
	private expanded = false;
	private cancelAnimation?: () => void;
	constructor(private readonly effects: {
		resize(expanded: boolean, ticket: number): Promise<void>;
		animate(expanded: boolean): { finished: Promise<void>; cancel(): void };
		phase(phase: MotionPhase): void;
		error(error: unknown): void;
	}) {}
	get targetExpanded() { return this.expanded; }
	async setExpanded(expanded: boolean) {
		const ticket = ++this.ticket;
		this.expanded = expanded;
		this.cancelAnimation?.();
		this.effects.phase(expanded ? 'expanding' : 'collapsing');
		try {
			if (expanded) await this.effects.resize(true, ticket);
			if (ticket !== this.ticket) return;
			const animation = this.effects.animate(expanded);
			this.cancelAnimation = () => animation.cancel();
			await animation.finished;
			if (ticket !== this.ticket) return;
			if (!expanded) await this.effects.resize(false, ticket);
			if (ticket !== this.ticket) return;
			this.effects.phase(expanded ? 'expanded' : 'collapsed');
		} catch (error) {
			if (ticket === this.ticket) { this.effects.phase(expanded ? 'expanded' : 'collapsed'); this.effects.error(error); }
		}
	}
	reset() {
		++this.ticket;
		this.cancelAnimation?.();
		this.expanded = false;
		this.effects.phase('collapsed');
	}
}
