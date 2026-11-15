/**
 * Files and folders attached to a prompt. omp runs on this machine, so a non-image attachment reaches it as an absolute
 * path it can read with its own tools; the hub appends one block to the prompt text. Image files are additionally sent as
 * image content (≤ MAX_PROMPT_IMAGE_BYTES, within MAX_PROMPT_IMAGES) so the model sees them. The block is plain English
 * text because the model reads it; the UI parses it back into chips.
 */
export interface Attachment {
	/** Absolute path on this machine. */
	path: string;
}

export const MAX_ATTACHMENTS = 50;

const HEADER = "Attached files (absolute paths on this machine; read them with your tools):";
const LINE = /^- (.+?)( \(folder\))?$/;

export function formatAttachmentBlock(items: { path: string; folder: boolean }[]): string {
	return [HEADER, ...items.map(item => `- ${item.path}${item.folder ? " (folder)" : ""}`)].join("\n");
}

/** Appends the block after the user's text, separated by a blank line. */
export function withAttachmentBlock(text: string, items: { path: string; folder: boolean }[]): string {
	if (!items.length) return text;
	const block = formatAttachmentBlock(items);
	return text.trim() ? `${text.replace(/\s+$/, "")}\n\n${block}` : block;
}

/** Splits a sent prompt back into the user's text and its attachments; text without a block is returned unchanged. */
export function parseAttachmentBlock(text: string): { text: string; attachments: { path: string; folder: boolean }[] } {
	const at = text.lastIndexOf(HEADER);
	if (at === -1 || (at > 0 && !text.slice(0, at).endsWith("\n\n"))) return { text, attachments: [] };
	const lines = text.slice(at + HEADER.length).split("\n").filter(Boolean);
	const attachments: { path: string; folder: boolean }[] = [];
	for (const line of lines) {
		const match = LINE.exec(line);
		if (!match) return { text, attachments: [] };
		attachments.push({ path: match[1]!, folder: Boolean(match[2]) });
	}
	return { text: text.slice(0, at).replace(/\s+$/, ""), attachments };
}
