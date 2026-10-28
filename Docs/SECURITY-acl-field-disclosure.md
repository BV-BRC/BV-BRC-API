# SECURITY — ACL fields (`user_read`/`user_write`/`owner`) are readable and facetable

**Status:** reported, unfixed. Written 2026-08-21.
**Severity:** low-to-moderate. Not a data breach — no private *record content* is exposed. It
is an **account-enumeration and social-graph disclosure**, and the facet path makes it a bulk
one.
**Scope:** every private collection (`genome`, `genome_feature`, `genome_sequence`, `pathway`,
`sp_gene`, `subsystem`, `genome_amr`, `genome_typing`, and now `private_genome_metadata`).
**Predates** the `private_genome_metadata` work — that collection surfaced it, it did not cause it.
**UPDATE 2026-10-28 — the "requires an account" qualifier is WRONG.** An anonymous caller
can enumerate **30,513 account names** in a single request. See "Anonymous enumeration via
facet.mincount=0" below. The original text, retained for provenance, read: *"Requires an
authenticated account. Anonymous requests disclose nothing (verified)."* That verification
used the default `mincount=1`, which is exactly the case where nothing leaks.

---

## The behavior

Permission enforcement in this API is **row-level only**. `middleware/DecorateQuery.js:8-15`
appends an `fq` from `lib/permissionFilter.js` that decides *which documents* a user may see.
Nothing decides *which fields* of a visible document they may read, or which fields they may
facet or sort on.

`owner`, `user_read`, and `user_write` are ordinary indexed fields. So on any record shared
with you, you can read the full access-control list — including principals you were never told
about and have no relationship to.

### Observed, on records shared with the requesting user

```
owner=mshukla@patricbrc.org  user_read=["hyun@patricbrc.org","olson@patricbrc.org"]
owner=mshukla@patricbrc.org  user_read=["harry@patricbrc.org","olson@patricbrc.org"]
owner=bowers@bvbrc           user_read=["olson@patricbrc.org","mshukla@patricbrc.org"]
```

Each row discloses a third party. That alone is arguable design (see "Is this a bug?"). What
follows is not.

---

## Amplification: faceting turns it into bulk enumeration

The permission `fq` restricts the matched DocSet, but **facet counts are computed over that
whole DocSet**, not over the page. One request returns a ranked list of every principal with
access to anything the requester can see:

```
GET /genome/?eq(public,false)&limit(1)
    &facet((field,user_read),(mincount,1),(limit,20))&json(nl,map)
```

```
numFound: 14756
user_read: {"p3_viral@patricbrc.org":205, "olson@patricbrc.org":31, "hyun@patricbrc.org":20,
            "mshukla@patricbrc.org":7,    "aniewiad1@bvbrc":5,      "ARWattam@patricbrc.org":3,
            "jimdavis@patricbrc.org":3,   "bob@patricbrc.org":2,    "mkuscuog@bvbrc":2,
            "clark.cucinell@patricbrc.org":1, "harry@patricbrc.org":1, "semenleyn@patricbrc.org":1}
```

Twelve real accounts and their private-data volumes, from a single call. `owner` facets the
same way. Note `p3_viral@patricbrc.org` — **service accounts surface too**, and those names are
stable and often more privileged than user accounts.

What this yields:

- **A harvestable list of valid usernames** (they are email addresses) for phishing — with
  seniority hints from the counts.
- **A collaboration graph**: who works with whom, and at what volume.

### Targeted existence oracle

The same field is queryable, so it answers questions about *specific* people:

```
eq(user_read,hyun@patricbrc.org)     -> 20 rows
eq(user_read,jimdavis@patricbrc.org) -> 3 rows
eq(user_read,nonexistent@nowhere.org)-> 0 rows
```

A non-zero count confirms both that the account exists and that it has private data shared with
someone the requester can also see.

---

## Is this a bug?

Depends on intent, and that is a product call rather than a technical one.

**Defensible:** in a shared-workspace model, "everyone on a record can see who else is on it"
is normal — Google Docs works this way.

**Two things push against that reading:**

1. **The facet path is not "who else is on this document."** It aggregates across 14,756 rows
   the requester cannot individually inspect in any meaningful sense. That is a different
   disclosure than per-record ACL visibility, and it is the part worth treating as a defect
   regardless of how the per-record question is decided.
2. **No UI affordance exists.** Users sharing data almost certainly do not know their
   collaborator list is readable, let alone bulk-enumerable. Consent that was never sought is
   not consent.

---

## Fix options

### Option A — block ACL fields as facet/sort targets (cheap, kills the bulk vector)

Reject `facet.field=user_read|user_write|owner` (and the same as `sort` / `group.field` /
`facet.pivot` components) for any requester who is not the record owner — in practice, reject
for everyone, since ownership is per-record and a facet spans records.

`middleware/SolrQuerySanitizer.js` is the existing precedent for parameter policing: it already
blocks a `DANGEROUS_PARAMS` list, recursively decodes to catch smuggling, and hard-400s. This
would extend the same mechanism to a *value* allowlist rather than a parameter-name blocklist.

Removes bulk enumeration and the ranked graph. Leaves per-record ACL visibility and the
targeted oracle intact.

### Option B — field-level projection filtering (complete, more invasive)

Strip `user_read`/`user_write` from returned documents unless the requester is the `owner`.

This is a **new concern for the codebase** — every existing control is row-level `fq`. It needs:

- a projection step (in `DecorateQuery`, or post-query alongside `JoinEnrichment`);
- `fl=` policing so the fields cannot be requested back explicitly;
- the Option A facet/sort blocks as well, since a blocked field must not be reachable by
  aggregation either;
- an owner-visible path, because owners legitimately need to see and manage their own ACLs;
- care in the streaming and cross-collection paths, which bypass parts of the middleware chain
  (`CrossCollectionStream`, `JoinEnrichmentStream`) — the same bypass that produced the
  2026-08-06 enrichment leak.

### Option C — accept and document

If per-record ACL visibility is intended, still do **A**: the aggregate path is not what anyone
means by "collaborators can see each other," and it costs little to close.

**Recommendation: A now, B if the field-level model is wanted.** A is small, self-contained,
and removes the part that scales.

---

## Verification notes

Reproduced against **production Solr** through a dev server, as an ordinary authenticated user
(`olson@patricbrc.org`), using only the public API surface — no admin access, no direct Solr.

Checks performed:

- per-record ACL visibility on `private_genome_metadata` (3 shared records, 2 disclosing a
  third party) and on `genome` (4 shared rows, 3 disclosing a third party);
- `user_read` facet over `genome` → 12 principals, 14,756-row DocSet;
- `owner` facet → 4 principals;
- targeted `eq(user_read,<user>)` oracle → distinguishes real from non-existent accounts;
- **anonymous** equivalent at the default `mincount=1` → `numFound: 0`, empty facet.
  **But see below: `mincount=0` changes this completely.**

---

## Anonymous enumeration via `facet.mincount=0` (added 2026-10-28)

**This is the most serious part of the finding and it was missed in the original writeup.**

Solr's `facet.mincount=0` asks for terms with zero matches — so it enumerates the FIELD'S
TERM DICTIONARY rather than the permission-filtered DocSet. The permission `fq` restricts
which documents match; it does not restrict which terms Solr is willing to name.

Measured against production, **unauthenticated, no token, one request**:

```
GET /genome/?eq(public,false)&limit(1)&facet((field,owner),(limit,-1),(mincount,0))

  numFound: 0                      <- the permission filter works
  owner values returned: 30,513    <- every account that owns a private genome
  ...with nonzero counts: 0
  sample: ['-Biotech_123.@bvbrc', '-H0N6_F31-@bvbrc', '...@bvbrc', '.K04230423@patricbrc.org']
```

The contrast is the whole point:

```
mincount=1  ->      0 owner values
mincount=0  -> 30,513 owner values
```

Every count is zero — no private record content is exposed, and `numFound` is honestly 0.
What leaks is the **term dictionary**: a complete, alphabetised roster of BV-BRC accounts
that own private data, available to anyone on the internet. Most are `@patricbrc.org` or
`@bvbrc` identifiers, i.e. login names.

That is a bulk account-enumeration primitive, and unlike the authenticated case it needs no
relationship to the data and no credentials at all. It also makes the severity assessment at
the top of this document too generous.

`user_read` and `user_write` currently 400 on the same request (not facetable as configured),
so `owner` is the demonstrated vector. Do not read that as a guarantee — a schema change
could expose them the same way.

### What a fix has to cover

Blocking `mincount=0` alone is insufficient — `facet.prefix` and `terms.*` walk the same
dictionary. The durable fix is to stop ACL fields being facetable/termable at all, which is
the same conclusion the authenticated case reaches.

A regression test for any fix should assert on **exact counts** (`facet` returns zero ACL
buckets; a shared record's response omits `user_read`), not merely that a request succeeds —
the failure mode here is a 200 with too much data, which is this codebase's characteristic bug
(see `PLAN_CROSS_COLLECTION_DOWNLOAD.md` and the 2026-08-06 enrichment leak).

---

## Related

- `lib/permissionFilter.js` — the single source of row-level scoping; would gain the
  field/facet policy.
- `middleware/DecorateQuery.js:8-15` — where the `fq` is applied.
- `middleware/SolrQuerySanitizer.js` — the parameter-policing precedent for Option A.
- `PLAN_PRIVATE_METADATA_OVERLAY.md` — the overlay design has the same "permissions are
  row-level, facets are computed over the DocSet" property at its core.
- 2026-08-06 enrichment permission fix — prior art for a permission gap on a path that bypasses
  the middleware chain.
