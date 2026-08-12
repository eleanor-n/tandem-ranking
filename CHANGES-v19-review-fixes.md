# v1.9 review fixes

Fork of `SBhat2026/tandem-ranking` with five fixes on top of `v1.9-separation`
(`dd6d355`). Work sits at `5603240`. Nothing was pushed to the source repo.
This is here to be read, run, and pulled if wanted.

## What prompted this

An outside review of v1.9 (Aug 11) raised five points. Four held up. One did
not, and that one is worth reading first.

## Fix 1: the review's premise was wrong

The review claimed the sweep harness runs out of memory at 12 seeds x N=600.

It does not. Run pre-fix, that configuration completes at exit 0, 31.2 minutes,
371 MB peak RSS against a 4288 MB heap limit. It also reproduces REPORT.md
section 1 exactly (0.958 / 0.948 / 0.940 / 0.935 / 0.862). Peak RSS is flat in
seed count (332 / 329 / 342 MB at 1 / 6 / 12 seeds at N=300), so worlds were
already being released between seeds. The reviewer hit their own container's
limit and reported it as a defect in this repo.

The real defect underneath is different and is fixed here: an interrupted run
lost everything. Per-seed rows now stream to a sibling `.rows.csv` as they
complete, so a killed run leaves recoverable cells. Killed mid-flight, pre-fix:
zero recoverable rows. Post-fix: five. The aggregate `--csv` contract is
unchanged, so `podium.ts` and the committed CSVs still work.

## Fix 2: dynamic range of the primary metric

Host retention at N=600 spans 0.862 (random) to 0.958 (shipped). The floor is
90% of the ceiling. The sweep now prints floor, ceiling, and each arm rescaled
to that span, under the podium for every metric carrying an SE.

## Fix 3: the top-of-ladder verdict is seed-count dependent

New `--seed-curve` mode re-runs the separation verdict on the first k seeds
without re-simulating:

| k | top group | shipped vs ranker_no_funnel |
|---|---|---|
| 4 | 4-way tie | TIE (gap 0.004, bar 0.014) |
| 8 | shipped alone | SEPARATES (gap 0.011, bar 0.009) |
| 12 | shipped alone | SEPARATES (gap 0.009, bar 0.007) |

At N=300 it is a 4-way tie at every k, so the dependence is an N=600
phenomenon, which is what the section 2 claim is about. The margins at k=8 and
k=12 are thin and stated as such.

## Fix 4: paired test reported alongside unpaired

Every arm runs the same population from the same seed, so seed effects can be
differenced out. The podium now prints both, clearly labeled. **Unpaired
remains the gate.** The conservative test was chosen deliberately and stands.

One pair disagrees, at N=600 on host retention:

ranker_no_funnel > ranker_repaired
UNPAIRED gap 0.008 vs bar 0.008 TIE
PAIRED mean +0.008 +/-0.004 SEPARATES


A new test asserts the paired computation is a per-seed difference and not a
difference of means, using two comparisons with identical means and identical
per-arm SEs.

## Fix 5: Gini promoted to co-headline

Host Gini is fully identified at N=600 (0.414 / 0.428 / 0.463 / 0.535 / 0.645,
no ties) while host retention still has a 3-way tie. It is the most robust
separation in the build and it was sitting in column nine. Host retention and
host Gini are now the first two metric columns.

## Constraints held

- `constants.ts`, `population.ts`, and all of `src/ranking/core/` untouched.
  Verified: `git diff dd6d355..HEAD -- src/ranking/core/ scripts/population.ts`
  returns empty.
- `RANKER_ENABLED` stays `false`.
- No test weakened or deleted. 261 pass (the original 257 plus 4 new).
- No scoring constant, weight, or funnel parameter changed.
- The disqualified `constants-tuned-variantD.ts` is not referenced anywhere.

## Files changed

scripts/sweep.ts +625
tests/sweep-rigour.test.ts +99
REPORT.md +55
README.md +5


## Known stale, left alone

`README.md` still says `npm test # 242 tests`. That was already wrong before
this work started (real count was 257, now 261). Not touched, since it predates
these changes.
