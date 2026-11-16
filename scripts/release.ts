#!/usr/bin/env node
/**
 * Work out the next release from the commits since the last one (ADR 0037).
 *
 * The last release is the highest tag `v1.2.3` that HEAD descends from; a tag with a suffix, such
 * as `v0.1.1-rc.0`, is not one. The commits since say what the next is, as conventional commits:
 * a `feat` is a minor version, a `fix` or `perf` is a patch, and a breaking change (`feat!:`, or a
 * `BREAKING CHANGE:` footer) is a major version, or a minor one while the version is `0.x`.
 * Anything else (`docs`, `test`, `chore`, `ci`, `refactor`) releases nothing.
 *
 *   node scripts/release.ts     say what the next release would be; nothing is changed
 *
 * In GitHub Actions it also hands `version` and `notes` to the steps that follow.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";

export interface Commit {
	hash: string;
	subject: string;
	body: string;
}

type Bump = "major" | "minor" | "patch";
interface Parsed {
	type: string;
	scope: string | undefined;
	breaking: boolean;
	text: string;
	hash: string;
}

function parse(commit: Commit): Parsed | undefined {
	const match = /^(\w+)(?:\(([^)]*)\))?(!)?: (.+)$/.exec(commit.subject);
	if (!match) return undefined;
	const breaking = match[3] === "!" || /^BREAKING[ -]CHANGE: /m.test(commit.body);
	return { type: match[1] as string, scope: match[2], breaking, text: match[4] as string, hash: commit.hash };
}

function bumpOf(commits: Parsed[]): Bump | undefined {
	if (commits.some((commit) => commit.breaking)) return "major";
	if (commits.some((commit) => commit.type === "feat")) return "minor";
	if (commits.some((commit) => commit.type === "fix" || commit.type === "perf")) return "patch";
	return undefined;
}

/** The version after `last` (`1.2.3`, no `v`) given the commits since, or nothing when none of them is released. */
export function nextVersion(last: string, commits: Commit[]): string | undefined {
	const [major = 0, minor = 0, patch = 0] = last.split(".").map(Number);
	const bump = bumpOf(commits.flatMap((commit) => parse(commit) ?? []));
	if (!bump) return undefined;
	// While it is 0.x, a minor version may break things (ADR 0025).
	if (bump === "major" && major > 0) return `${major + 1}.0.0`;
	if (bump === "major" || bump === "minor") return `${major}.${minor + 1}.0`;
	return `${major}.${minor}.${patch + 1}`;
}

/** What the release says about itself: the commits that are released, under what they are. */
export function releaseNotes(commits: Commit[]): string {
	const parsed = commits.flatMap((commit) => parse(commit) ?? []);
	const line = (commit: Parsed) => `- ${commit.scope ? `**${commit.scope}:** ` : ""}${commit.text} (${commit.hash.slice(0, 7)})`;
	const section = (title: string, list: Parsed[]) => (list.length ? [`### ${title}`, "", ...list.map(line), ""] : []);
	return [
		...section("Breaking changes", parsed.filter((commit) => commit.breaking)),
		...section("Features", parsed.filter((commit) => commit.type === "feat" && !commit.breaking)),
		...section("Fixes", parsed.filter((commit) => (commit.type === "fix" || commit.type === "perf") && !commit.breaking)),
	]
		.join("\n")
		.trim();
}

/** The highest of the tags that are a release, `v1.2.3` and nothing after it. */
export function lastRelease(tags: string[]): string | undefined {
	const parts = (tag: string) => tag.slice(1).split(".").map(Number);
	return tags
		.filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag))
		.sort((a, b) => {
			const [x, y] = [parts(a), parts(b)];
			return (x[0] as number) - (y[0] as number) || (x[1] as number) - (y[1] as number) || (x[2] as number) - (y[2] as number);
		})
		.at(-1);
}

if (process.argv[1]?.endsWith("release.ts")) {
	const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	const last = lastRelease(git("tag", "--merged", "HEAD", "--list", "v*").split("\n"));
	const commits = git("log", "--format=%H%x1f%s%x1f%b%x1e", last ? `${last}..HEAD` : "HEAD")
		.split("\x1e")
		.map((record) => record.trim())
		.filter(Boolean)
		.map((record) => {
			const [hash = "", subject = "", body = ""] = record.split("\x1f");
			return { hash, subject, body };
		});
	const version = nextVersion(last?.slice(1) ?? "0.0.0", commits);
	const since = `${commits.length} commit${commits.length === 1 ? "" : "s"} since ${last ?? "the first"}`;
	if (!version) {
		console.log(`Nothing to release: ${since}, none a feat, a fix or a breaking change.`);
	} else {
		const notes = releaseNotes(commits);
		console.log(`${version}: ${since}\n\n${notes}`);
		if (process.env.GITHUB_OUTPUT) {
			const end = `end-${randomUUID()}`;
			appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\nnotes<<${end}\n${notes}\n${end}\n`);
		}
	}
}
