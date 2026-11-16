import { describe, expect, it } from "vitest";
import { type Commit, lastRelease, nextVersion, releaseNotes } from "../scripts/release.ts";

const commits = (...subjects: (string | [string, string])[]): Commit[] =>
	subjects.map((entry, i) => (typeof entry === "string" ? { hash: `${i}`.repeat(40), subject: entry, body: "" } : { hash: `${i}`.repeat(40), subject: entry[0], body: entry[1] }));

describe("the next release", () => {
	it("is a patch for a fix, a minor version for a feature, and nothing for the rest", () => {
		expect(nextVersion("1.2.3", commits("fix(pane): a role is applied", "docs: ADR 0036"))).toBe("1.2.4");
		expect(nextVersion("1.2.3", commits("perf: the tree is read once"))).toBe("1.2.4");
		expect(nextVersion("1.2.3", commits("fix: one", "feat(canopy): two", "chore: three"))).toBe("1.3.0");
		expect(nextVersion("1.2.3", commits("docs: one", "test: two", "ci: three", "chore: four", "refactor(host): five", "not a conventional commit"))).toBeUndefined();
		expect(nextVersion("1.2.3", [])).toBeUndefined();
	});

	it("is a major version for a breaking change, and a minor one while the version is 0.x", () => {
		expect(nextVersion("1.2.3", commits("feat(host)!: networks are gone"))).toBe("2.0.0");
		expect(nextVersion("1.2.3", commits(["fix: the address has the fingerprint", "Why.\n\nBREAKING CHANGE: old addresses are refused"]))).toBe("2.0.0");
		expect(nextVersion("0.2.3", commits("fix!: old addresses are refused"))).toBe("0.3.0");
		expect(nextVersion("0.2.3", commits("fix: one"))).toBe("0.2.4");
	});

	it("starts from the highest tag that is a release, not one with a suffix", () => {
		expect(lastRelease(["v0.1.0", "v0.1.1-rc.0", "v0.10.0", "v0.9.2", "vnext", ""])).toBe("v0.10.0");
		expect(lastRelease(["v0.1.1-rc.0"])).toBeUndefined();
	});

	it("says what is released, under what it is", () => {
		expect(releaseNotes(commits("feat(canopy): the first message", "docs: ADR 0035", "fix: a result is said", "feat!: networks are gone"))).toBe(
			["### Breaking changes", "", "- networks are gone (3333333)", "", "### Features", "", "- **canopy:** the first message (0000000)", "", "### Fixes", "", "- a result is said (2222222)"].join("\n"),
		);
	});
});
