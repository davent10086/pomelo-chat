export interface ReviewSource {
	id: number;
	sender: string;
	content: string;
	createdAt: string;
}
export interface ReviewItem {
	text: string;
	assignee?: string;
	due?: string;
	sources: ReviewSource[];
}
export interface ReviewResult {
	room: string;
	coverage: {
		since: string;
		until: string;
		scannedMessages: number;
		analyzedMessages: number;
		skippedMedia: number;
		contentTruncated: boolean;
		hasEarlier: boolean;
		newestId?: number;
		nextBeforeId?: number;
		oldestMessageAt?: string;
		newestMessageAt?: string;
		capturedAt: string;
	};
	topics: ReviewItem[];
	decisions: ReviewItem[];
	questions: ReviewItem[];
	actions: ReviewItem[];
	answer: ReviewItem[];
	omittedItems: number;
}
export interface ReviewRange {
	preset: 'today' | 'week' | 'custom';
	since?: string;
	until?: string;
}
