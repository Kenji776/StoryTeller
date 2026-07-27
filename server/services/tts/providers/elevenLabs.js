/** Stub — awaiting implementation. */
export function charAlignmentToWords() {
	return [];
}

/** Stub — awaiting implementation. */
export const elevenLabsProvider = {
	id: "elevenlabs",
	label: "ElevenLabs",
	audioFormat: "mpeg",
	async isAvailable() { return false; },
	async listVoices() { return []; },
	async *synthesize() { /* yields nothing */ },
	async preview() { return { contentType: "", body: Buffer.alloc(0) }; },
};
