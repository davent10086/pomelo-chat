/** Plain-text message compatibility helper. React owns HTML escaping. */
export const sanitizeAiContent = (text: string): string => {
	// Messages are rendered as React text, which escapes markup. Preserve code examples.
	return String(text);
};
