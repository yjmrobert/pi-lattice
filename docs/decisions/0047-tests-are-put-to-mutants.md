# 0047 Tests are put to mutants

Builds on [0046](0046-machines-are-tested-as-containers.md). Status: built.

The tests passing says the code does what they ask. It does not say they ask much: a test can run a line and hold nothing of what it does. Nothing here said which code is held and which is only run.

**Decision**

- **A mutant is a small change to the code.** [Stryker](https://stryker-mutator.io) makes them one at a time: `<` for `<=`, a condition that is always true, a string emptied, a block with nothing in it. The tests that reach the changed code are run. A test that fails has noticed the mutant. A mutant every test passes with has survived, and is something no test holds.
- **A package's own tests judge them.** The tests in `packages/*/test` run the code in their own process, where a mutant can be switched on. Every package's tests are run on a package's mutants: a mutant in the contracts may be noticed by a test of the host.
- **The tests that start Pi do not.** `test/integration` runs the code in other processes, where no mutant is switched on, so those tests could only pass. The tests beside them (`test/*.test.ts`) read the source as text, which is not the text mutants are made in. Code that only those tests run is counted as not reached.
- **A test of how long something takes leaves itself out.** The code that switches mutants on is many times slower, and a slow answer is not a wrong one. Such a test is skipped where `LATTICE_TEST_MUTANTS` is set, which only the mutants' Vitest configuration does. There are two, both of the canopy.
- **So does the one test that is too slow to run on every mutant**: every key on every kind of item (`keys.test.ts`). It is half the time of all the canopy's tests and runs nearly all of its code, so it was run for nearly every mutant. With it, a run of the canopy was stopped at the five hours a job is given, with under half of its mutants tried.
- **They are made in a copy of the checkout**, so nothing that is being worked on changes under anyone. `@pi-lattice/*` is pointed at the copy for the run: `node_modules/@pi-lattice/*` are links back to the checkout, where nothing is mutated.
- **On GitHub's runners there is a job for each package**, on every push and pull request: the workflow `Mutants`. All of them together are some fourteen hours of one core, and a runner has four. The canopy is a job for each file: its tests draw whole screens, and are slow on every mutant.
- **Code that no test of a package reaches at all is said, and fails nothing.** Stryker stops there. The job says so in a notice, and the summary names a package there is no report for.
- **What a run found is carried to the next.** Stryker keeps what became of each mutant, and tries again only where the code or a test that reaches it changed. Each package's findings are kept in the runner's cache, a branch taking `main`'s where it has none. A run on `main` is never cancelled, because what it found is only kept at its end: pushes that come meanwhile wait, and the newest of them runs.
- **Once a week everything is tried again**, carrying nothing. What is carried does not see a change outside the code and its tests, such as a newer dependency or a package's neighbour.
- **The run says what it came to.** Its summary is a table by package (`scripts/mutants.ts`): mutants, noticed, survived, not reached. Each package's report is an artifact, `index.html`: every mutant in the code it was made in, with the tests that reach it.
- **There is a floor.** The run fails when, of the mutants the tests reach, under 70% were noticed, over all packages. That is two points under what it was when this was written. It is there to be raised.
- **It runs beside CI, and holds no release back**, as the tests between machines do.
- **On a person's machine it is for one file.** `npm run mutants -- --mutate packages/canopy/src/order.ts`, with two runners. Each runner is a Vitest of its own and takes half a gigabyte or more; all of the code at once, on every core, took all the memory of the machine it was first tried on.

**What it comes to**

31,620 mutants in nine packages, on 19 November 2026:

| package | mutants | noticed | survived | not reached | noticed, of what tests reach | noticed, of all |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| a2a | 1137 | 294 | 108 | 735 | 73.1% | 25.9% |
| app | 2091 | 388 | 207 | 1496 | 65.2% | 18.6% |
| canopy | 7228 | 4927 | 1921 | 380 | 71.9% | 68.2% |
| collab | 3070 | 1741 | 978 | 351 | 64.0% | 56.7% |
| host | 3722 | 268 | 108 | 3346 | 71.3% | 7.2% |
| pane | 8559 | 2849 | 893 | 4817 | 76.1% | 33.3% |
| protocol | 2553 | 1872 | 530 | 151 | 77.9% | 73.3% |
| roles | 1099 | 283 | 68 | 748 | 80.6% | 25.8% |
| server | 2161 | 1474 | 582 | 105 | 71.7% | 68.2% |
| **all** | 31620 | 14096 | 5395 | 12129 | **72.3%** | 44.6% |

Of what the packages' own tests reach, they notice 72% of the changes made to it: 5,395 changes passed every test that ran them. Two fifths of all mutants are in code those tests do not run: the host, the extensions, and what the app does with them, which the tests that start Pi hold or do not. `packages/graph` has no tests of its own, and nothing in it was tried.

From nothing, 21 jobs took 3.6 hours of runners between them, and the longest took 51 minutes (the contracts; then sharing, 44, and the canopy's screen, 26). The push after it changed nothing that is mutated: every job took what the last had found and was done in under 45 seconds.

Making it run found three things:

- A test of the host compared a path as written with where the package really is, and failed wherever `node_modules` is a link.
- Stryker with a runner for each core took all the memory of a machine with 15 GB, and the kernel stopped other programs on it. It is two runners on a person's machine, and for one file.
- A whole run of the canopy does not end in a job: see above.

**Not done**

- Mutants are not put to the tests that start Pi. Most of `packages/host`, the extensions and `packages/graph` are only run by those, and are counted as not reached or left out. A file of the canopy that no test of a package reaches (`extension.ts`) is not counted at all, where the same in another package is counted as not reached. Switching a mutant on in the processes a test starts would take those tests in; each of them takes seconds, and there are tens of thousands of mutants.
- A push is not told which survivors are in the lines it changed. They are in the package's report with the rest.
- Mutants that TypeScript would refuse are not taken out first (`@stryker-mutator/typescript-checker`). Some survive that could never be written.
- Nothing is sent to Stryker's dashboard. The reports are artifacts of the run and are gone when those are.
- No survivor was looked at for this. The numbers above are where the tests are, not yet a list of what to do.
- The floor is one number for everything. A package can fall while the whole stays above it.

**Costs**

- Twenty-one more jobs on every push, and a first run or a weekly one that takes as long as its largest piece.
- What only the test of every key holds in the canopy reads as survived or not reached.
- What is carried between runs can be stale for a week where a package changes and its neighbour's tests are what reach it.
- A mutant that makes a test wait for something that never comes is only noticed when its time is up, so a slow runner can turn a mutant from one kind of noticed to the other, and now and then from survived to noticed. Sharing, whose tests wait on real connections, came to 1743 noticed in one run and 1741 in the next.

**Evidence**

`test/mutation/stryker.config.mjs` and `test/mutation/vitest.config.ts`; `.github/workflows/mutants.yml`; `scripts/mutants.ts` with `test/mutants.test.ts`. The runs of the workflow on `ddc80ab` (everything, from nothing) and `1bd17fc` (nothing to try again).
