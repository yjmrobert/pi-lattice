# 0037 A push to main releases

Changes how a release is made in [0025](0025-one-published-package.md). Status: built; the workflow has not run yet.

A release took three steps by hand: set the version in `packages/app/package.json`, commit, and push a tag with the same number. Which number was a judgement made each time, and 33 commits, 14 of them features, sat on `main` unreleased because nobody had made it. The commits already say what they are: every one is a conventional commit.

**Decision**

- **A push to `main` releases what it brought.** `.github/workflows/release.yml` runs on every push to `main`, and does nothing when the commits since the last release hold nothing to release.
- **The version is worked out from the commits** since the last release, by `scripts/release.ts`:
  - a breaking change (`!` after the type, or a `BREAKING CHANGE:` footer) is a major version, and a minor one while the version is `0.x`, as 0025 has it;
  - a `feat` is a minor version;
  - a `fix` or a `perf` is a patch;
  - anything else releases nothing.
- **The last release is a tag.** It is the highest tag `v1.2.3` that the pushed commit descends from. A tag with a suffix, such as `v0.1.1-rc.0`, is not a release.
- **Nothing is committed back.** The version is in the tags and on npm, and no longer in `packages/app/package.json`, which stays `0.0.0`. The build is given the version (`RELEASE_VERSION`, read by `scripts/pack.mjs`). A workflow that committed the version to `main` would make every push be followed by a pull.
- **The suite passes first, on the commit being released.** Then the package is published as `latest`, the commit is tagged, and a GitHub release lists the breaking changes, features and fixes, each with its scope and commit.
- **It can be run again.** The package is published before the tag is made. If the tag fails, running the workflow again finds the version on npm, skips the publish, and tags.
- **Only as a trusted publisher.** The `NPM_TOKEN` path of 0025 was for the first release, and is removed. The workflow file and the environment keep their names, which are what npm trusts.
- **`node scripts/release.ts` says what the next push would release**, and changes nothing.

**Evidence**

- `test/release.test.ts`: the version for each kind of commit, on `0.x` and after; the last release among tags that include a suffixed one; the notes.
- `node scripts/release.ts` on this repository, before the first such release: `0.2.0`, from 33 commits since `v0.1.0`.
- `RELEASE_VERSION=9.9.9 npm run build` writes a manifest with that version; without it, `0.0.0`.

**Not verified**

- The workflow itself, until the push that brings it. Trusted publishing has only been used from a tag push (`v0.1.1-rc.0`); npm matches the repository, the workflow file and the environment, none of which changed.

**Not done**

- Versions with a suffix. Nothing publishes to `next` any more.
- Leaving `0.x`. A breaking change is a minor version while the version is `0.x`, so nothing here ever makes `1.0.0`.
- A changelog file. What changed is in the GitHub releases.

**Costs**

- The suite runs twice on a push that releases: once in CI, once before the publish.
- A commit whose subject is not a conventional commit is not released by itself, and is not in the notes.
- A `feat` that is pushed is published. Work that should not be released yet belongs on a branch.
