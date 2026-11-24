import { describe, expect, it } from "vitest";
import { printable } from "../src/index.ts";

describe("printable", () => {
	it("puts a space where each control character was, so that a terminal acts on nothing in it", () => {
		expect(printable("fix\u001b]0;pwned\u0007 the\u001b[2J bug")).toBe("fix ]0;pwned  the [2J bug");
		expect(printable("a\r\nb\tc\u007fd\u009be\u0000f")).toBe("a  b c d e f");
		expect(printable("a\u0085b").length).toBe(3);
	});

	it("leaves everything else as it was", () => {
		for (const text of ["plain", "café ☕ 结账 👨‍👩‍👧", "→ │ ✓", ""]) expect(printable(text)).toBe(text);
	});

	it("keeps line feeds, and only those, in text shown over several lines", () => {
		expect(printable("one\ntwo\r\nthree\u001b[31m\tred", true)).toBe("one\ntwo \nthree [31m red");
	});
});
