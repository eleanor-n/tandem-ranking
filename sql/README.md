# sql/

Standalone queries you paste into the Supabase SQL editor. **Read-only.** None
of these is a migration, none is on a code path, and running any of them twice
is harmless.

These are separate from `supabase/migrations/` (which changes the database) and
from `supabase/analysis/` (which holds queries the ranking work refers to
internally). Things in here are meant to be run by a person who wants an answer.

---

## `churn_per_empty_post.sql`

**What it answers.** How much more likely is a host to stop posting after a post
that nobody joined, compared with one that filled?

**Why it matters.** The demand-balancing layer — the part of the shipped
ordering that boosts nearly-empty posts happening soon — exists because an empty
post is believed to cost you a host. The size of that cost is currently a number
somebody typed into `scripts/population.ts` (`churnPerEmptyPost = 0.18`). Every
simulator result that says "boost empty posts harder" is downstream of it.

This query is how that number stops being invented.

**When to run it.**

| when | why |
|---|---|
| once now | to see how far off the data is, and to have a baseline |
| at **~100 judgeable posts** | the first point at which the answer means much |
| after any change to `demandWeight` | to check the assumption still holds |

Query 2 in the file tells you how many judgeable posts exist, so you do not have
to guess where you are.

**What it will say today.** Almost certainly "not enough data" — the confidence
intervals will overlap. That is a real answer, not a failed run. The file's
closing comment spells out the four cases and what to do in each; the short
version is that only Case B (empty posts cost *more* than modelled) justifies
raising `demandWeight`, and Case C — the likely one — means change nothing.

**What could change as a result.**

- `demandWeight` in `src/ranking/core/constants.ts`, currently `0.10`. It is the
  only constant this query can justify moving.
- If the difference turns out to include zero even at large n, the
  demand-balancing layer is solving a problem that may not exist, which is a
  bigger conversation than a constant.

**What it will never justify.** A change to any other scoring constant, or any
conclusion at all when the judgeable count is under about 30.

---

## Adding to this directory

Two rules, both learned the hard way in this repo:

1. **Report counts next to every rate.** A rate on n=4 and a rate on n=400 look
   identical otherwise, and the first one has already caused a wrong conclusion
   here (see `DIAGNOSTICS.md` §D4).
2. **Write the interpretation into the file**, as a comment, before anyone runs
   it. Deciding what a result means after seeing it is how a comfortable
   reading wins — which has happened three times in this project and is recorded
   each time.
