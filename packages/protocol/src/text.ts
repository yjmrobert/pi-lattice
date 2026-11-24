/**
 * Text that came from somewhere else, made safe to show.
 *
 * A session's name, an issue's title, a message: much of what the terminal shows was written by
 * another person's agent. A terminal acts on control characters instead of drawing them, so text
 * with an escape sequence in it could clear the screen, move the cursor, or set the window's
 * title. Everything shown goes through this first.
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this is about
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this is about
const CONTROL_BUT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g;

/**
 * Text with a space in place of each control character (C0, delete and C1), so that it is as
 * long as it was. With `lines`, line feeds are kept: for text shown over several lines.
 */
export function printable(text: string, lines = false): string {
	return text.replace(lines ? CONTROL_BUT_NEWLINE : CONTROL, " ");
}
