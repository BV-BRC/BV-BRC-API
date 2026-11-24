# Risk report: merging `alpha` (with distributed-query) into `master`

**Date:** 2026-08-24
**Refs measured:** `upstream/master` @ `7f94fc8b`, `upstream/alpha` @ `efc167af`
**Verdict:** **Low merge risk, moderate deployment risk.** The git merge is nearly trivial.
The real risk is entirely in what happens at *runtime on production* after the merge, and it
concentrates in one config default.

---

## 1. Shape of the merge

| measure | value |
|---|---|
| commits `alpha` ahead of `master` | **179** |
| commits `master` ahead of `alpha` | **10** |
| files changed `master → alpha` | **151** (+36,414 / −425) |
| files changed on the **master-only** side | **2** |
| textual conflicts (`git merge-tree` dry run) | **2 files** |

The 10 master-only commits are *all* dependency work, and they touch exactly two files:
`package.json` and `package-lock.json`. Nothing else on master has diverged.

```
7f94fc8b Merge PR #200 deps/drop-forever-master
416b20e3 Merge PR #198 deps/p3user-repin-master
40a944f9 Remove forever; the services run under pm2
6a9ba0be Repin p3-user to BV-BRC/BV-BRC-UserManagement
825f4426 Merge PR #195 deps/uuid-master
5db2b770 Bump uuid 2 -> 11
88ceb55d Merge PR #193 deps/engine-cleanup-master
64f693ad Remove accidental npm/install deps; bump apicache
94fabd5a Merge PR #192 deps/security-refresh-master
c64325af Security dependency refresh: npm audit 106 -> 57
```

So this is a **fast-forward-shaped merge with a two-file manifest reconciliation**, not a
179-commit conflict resolution. That is much better than the commit count suggests.

### The only real conflict: `package.json`

The full semantic diff between the two manifests is four lines:

```diff
+ "test-distributed": "mocha -R spec tests/test-distributed/test.*.spec.js",
+ "test-util":        "mocha -R spec tests/test-util/test.*.spec.js",
+ "dojo-declare":     "0.0.1",
- "solrjs": "github:BV-BRC-dependencies/solrjs#1.0.0",
```

**Take alpha's side on all four.** Alpha inlined solrjs into `lib/solrjs/` (verified: the
directory exists on alpha, is absent on master) and `dojo-declare` is the dependency that
inlined copy needs. Master still has three files doing `require('solrjs')`
(`middleware/APIMethodHandler.js`, `middleware/patch.js`,
`routes/genomePermissionRouter.js`), and alpha rewrites all of them.

**Resolution risk:** taking *master's* side on the `solrjs` line — the natural instinct,
since master's dependency work is newer — reintroduces the external package while the code
imports `lib/solrjs`. That is a silent divergence, not a build break: both resolve. Per
`CLAUDE.md`, **do not add solrjs back to `package.json`.**

For `package-lock.json`, do not hand-merge. Take alpha's `package.json` with master's four
dependency decisions applied (they are already present on alpha — `p3-user` pin, `uuid` 11,
no `forever`, no `npm`/`install`, `apicache` ^1.6.3 — verified identical on both lines), then
regenerate the lock with `npm install` and commit the result.

---

## 2. The one high-severity risk: distributed query is **on by default**

This is the finding that matters most and it is a *deployment* risk, not a merge risk.

**`master` has no `distributedQuery` config block at all** — verified: zero occurrences in
both `config.js` and `p3api.conf.sample`. Alpha's `config.js` defaults are:

```js
distributedQuery: {
  enabled: true,                          // ON
  minLimitThreshold: 10000,
  enabledCollections: ['genome_feature'],
  excludeNodes: [],                       // EMPTY
  maxParallelism: 8,
  ...
}
```

The distributed path **requires direct network access to every Solr shard replica**
(`CLAUDE.md`: "Each shard must have at least one accessible replica"). Production reaches
Solr through a pair of HAProxy load balancers, *not* directly. The on-prem deployment config
compensates with a six-entry `excludeNodes` list (balsam, arborvitae, butternut, chestnut,
elm, larch) — but **`p3api.conf` is not tracked in git** (only `p3api.conf.sample` is).

So the merge ships `enabled: true` with `excludeNodes: []`, and whether production survives
depends entirely on a **deploy-local file that the merge does not touch and cannot
guarantee**.

**Blast radius is bounded but non-zero.** A query engages the distributed path only when it
targets `genome_feature`, is a plain `query`/`stream` (not `facet=true`/`group=true`), and
has `rows >= 10000`. Setup failures are caught and fall back to the standard path
(`middleware/DistributedQuery.js:417-424`, `console.error` + `next()`), which is genuinely
reassuring. But **mid-stream failures after headers are sent cannot fall back** — the
response is already committed. That is the same empty-200 class documented in
`Docs/BUG-stream-failure-returns-empty-200.md`.

**Mitigation — do this as part of the merge, not after:**

1. Set `"distributedQuery": { "enabled": false }` in production's `p3api.conf` *before* the
   merge deploys. Turn it on deliberately, afterwards, once replica reachability is verified.
2. Add the `distributedQuery` block to the tracked `p3api.conf.sample` so the setting is
   discoverable rather than folklore.
3. Consider flipping the shipped default to `enabled: false`. A subsystem that needs
   network topology the default deployment does not have should be opt-in. This is a
   one-line change in `config.js` and it removes the entire class of risk above.
4. Verify with the `X-Distributed-Query` response header (`exposeMetadataHeaders: true`)
   whether any production query actually engages the path.

---

## 3. Second finding: a vendored `node_modules` is committed, and it shadows a root dependency

Alpha commits **32 files under `lib/solrjs/node_modules/`** — a real directory in the tree,
not a submodule or gitlink. It contains two vendored packages:

| vendored | version | root `package.json` declares | lockfile resolves root to |
|---|---|---|---|
| `debug` | **2.6.9** | `^3.1.0` | 3.2.6 |
| `rql` | 0.3.3 | `^0.3.3` | (matches) |

Node's resolution walks upward from the requiring file, so **`lib/solrjs/index.js` and
`lib/solrjs/rql.js` load `debug@2.6.9` while the rest of the application uses `debug@3.2.6`**.
Verified directly:

```
$ node -e "console.log(require.resolve('debug',{paths:['./lib/solrjs']}))"
.../p3_api/lib/solrjs/node_modules/debug/src/index.js   → version 2.6.9
```

Three consequences:

- **`npm audit` cannot see it.** The lockfile has **zero** entries under `lib/solrjs`
  (verified). Vulnerabilities in the vendored copies are invisible to the audit workflow
  documented in `CLAUDE.md`, so the "35 advisories, 2 critical" baseline understates the
  tree. This directly undercuts the dependency-security work that is master's entire
  contribution to this merge.
- **`npm install` will not fix or update it.** It is checked-in content.
- **It survives the `.gitignore`.** `.gitignore` line 1 is `node_modules/*`, which does not
  match a nested path, and the files are already tracked (`git ls-files` → 32). Tracked
  files are unaffected by gitignore regardless.

Behavioral impact is likely small — `debug` 2→3 is mostly namespace/formatting — but the
audit blind spot is the real problem, and it lands on master silently.

**Recommendation:** not a merge blocker. File it as follow-up: delete
`lib/solrjs/node_modules/`, confirm `debug`/`rql` resolve from the root, and re-run the
offline suites. Do it *after* the merge so it does not enlarge an already-large diff.

---

## 4. What the merge brings that master has never run

Master gets the whole distributed-query, join-enrichment, and cross-collection-download
subsystem as net-new code. Notable additions (`--diff-filter=A`):

- `middleware/DistributedQuery.js`, `CrossCollectionSource.js`, `CrossCollectionStream.js`,
  `JoinEnrichment.js`, `JoinFieldInjector.js`
- `lib/distributed/*` (13 modules), `lib/solrjs/*`, `lib/userAgent.js`
- `media/genbank.js` (988 lines — a full rewrite), `media/ndjson.js`

Per `CLAUDE.md`, the files that alter **preexisting shared-path behavior** — where review
effort belongs — are `middleware/DistributedQuery.js`, `lib/solrjs/rql.js`,
`middleware/APIMethodHandler.js`, and `middleware/DecorateQuery.js`. Everything else is
additive or guard-gated.

**Mitigating evidence, and it is strong:** this delta has already been merged into alpha
(PR #189) and validated as **result-identical to production** across four real user
workloads using `scripts/replay-queries.js` in live A/B mode against
`https://www.bv-brc.org/api` — which *is* master's code. Five defects were found and fixed
during that shakedown. So "alpha vs master" has effectively already been differenced against
live production behavior. See `Docs/DISTRIBUTED_QUERY_SHAKEDOWN.md`.

**Caveat on that evidence:** not every trace exercises the distributed streaming path. A
query only engages it under the conditions in §2, and recent traces whose large queries were
facet requests or hit non-enabled collections took the standard path. Coverage of the
distributed path specifically is thinner than the headline suggests.

---

## 5. Test and lint baseline

Offline suites (`test-util`, `test-join`, `test-distributed`) on the current tree, run for
this report:

```
327 passing, 1 failing
1) fastaHeaderFormatter › should handle missing values gracefully
   expected '>feat1| Test' to match /^>feat1 Test/
```

**This one failure is the known pre-existing case** and is not a merge regression. Note
`tests/test-distributed/` and `tests/test-util/` **do not exist on master at all** — they
arrive with the merge, along with their `npm run` scripts. Post-merge, master should show
the same 327/1.

`test-api`, `test-security`, `test-media`, `test-download` require a live API and Solr and
will `ECONNREFUSED` without one — they are not a merge gate but should be run against a
staging instance before production deploy.

**Lint:** `npx eslint .` reports **1,167 errors** on the merged tree. `CLAUDE.md` records
"56 pre-existing errors on the files touched" by the dependency refresh — a much smaller,
differently-scoped count. The 1,167 figure is the whole tree including the newly-added
subsystem and the vendored `lib/solrjs/node_modules`. Lint is not currently a CI gate; do
not treat this as a merge blocker, but do not read the two numbers as comparable either.

---

## 6. Recommended sequence

1. Set `distributedQuery.enabled = false` in production `p3api.conf` **first**, independently
   of the merge. Ship this ahead of time.
2. Merge `alpha → master`. Resolve `package.json` in alpha's favour on all four lines
   (keep the inlined solrjs; do **not** restore the external package). Regenerate
   `package-lock.json` via `npm install` rather than hand-merging.
3. Confirm `npm audit` on the merged tree still reports **35 / 2 critical** — master's
   dependency wins must survive the merge. If the number jumps, the manifest resolution took
   the wrong side.
4. Run the offline suites; expect **327 / 1**.
5. Deploy to staging; run `test-api`, `test-media`, `test-download` against it.
6. Run `scripts/replay-queries.js` in `--compare` mode against production to confirm
   result-identity on the *merged* tree, not just on alpha.
7. Deploy to production with distributed query still **off**. Confirm normal operation.
8. Enable distributed query deliberately, with `excludeNodes` set, and verify via the
   `X-Distributed-Query` header that queries engage the path and return correct results.

Steps 1 and 7–8 are what convert this from a moderate-risk deployment into a low-risk one.
The merge itself is the easy part.

---

## 7. Follow-ups to file (not merge blockers)

- Delete `lib/solrjs/node_modules/` and let the root `debug@3.2.6` / `rql` resolve (§3).
- Add the `distributedQuery` block to `p3api.conf.sample` (§2).
- Consider defaulting `distributedQuery.enabled` to `false` in `config.js` (§2).
- Unrelated but adjacent, from the current production performance investigation: HTTP
  self-calls are the top consumer of API time (`127.0.0.1` measured at 4,035 requests /
  374,670s over 14 hours). These are **identical on master and alpha**, so the merge neither
  helps nor hurts — but the fix should land on master, which is what production runs. See the
  `feature/eliminate-self-call` plan.
