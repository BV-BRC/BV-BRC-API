# Local Solr 9.6.1 for API testing

Standing up a single-node SolrCloud instance to run the API's integration tests
against — in particular the permission-enrichment tests
(`PLAN_ENRICHMENT_PERMISSIONS.md`), which need real Solr query parsing and real
private/owned documents.

**Why local rather than the production cluster:** `DirectSolrClient` reads
`CLUSTERSTATUS` and then connects directly to each replica's `base_url`
(`lib/distributed/SolrClusterClient.js:158,243`). Against production that needs
VPN access to every Solr node. Against a single-node local instance, `base_url`
is your own localhost, so the same code path works unmodified — you are testing
the real client, not a degraded fallback.

**Must be SolrCloud mode, not standalone.** `CLUSTERSTATUS` is a collections-API
call and does not exist in standalone mode. Use `bin/solr start -c`.

---

## Prerequisites

### Java: use 17 or 21. Not 8, and NOT 24+.

Solr 9.6.1 supports JDK 11, 17, and 21. Both ends of that range matter:

- **Java 8 is too old** — Solr 9 will not start on it.
- **Java 24 and newer will not work**, for a reason that is not obvious from the
  error. See below.

```bash
brew install openjdk@21
export SOLR_JAVA_HOME=/opt/homebrew/opt/openjdk@21
```

`SOLR_JAVA_HOME` overrides `JAVA_HOME` for Solr alone, so the system default (Temurin
8 on this dev machine, pinned by the BV-BRC toolchain) is left untouched. `openjdk@21`
is keg-only and will not shadow it.

Check what you have:

```bash
java -version
/usr/libexec/java_home -V             # macOS: all installed JDKs
/opt/homebrew/opt/openjdk/bin/java -version   # Homebrew's unversioned openjdk
```

#### Why JDK 24+ fails: the Security Manager

Startup dies during VM init with:

```
Error occurred during initialization of VM
java.lang.Error: A command line option has attempted to allow or enable the
Security Manager. Enabling a Security Manager is not supported.
    at java.lang.System.initPhase3(java.base@26.0.2/System.java:1970)
```

`bin/solr` (lines 2205-2210) passes `-Djava.security.manager` unconditionally unless
told otherwise. JDK 24 removed the ability to enable it (JEP 486), so the JVM refuses
to boot rather than warning.

**Watch out:** plain `brew install openjdk` tracks the newest release — currently
**26.x** — so it lands squarely in the broken range. Install `openjdk@21` explicitly.

If you must run a newer JDK, Solr provides a supported opt-out:

```bash
export SOLR_SECURITY_MANAGER_ENABLED=false
```

Acceptable for a local single-user test instance (the security manager sandboxes
Solr's own filesystem and network access, which does not matter here), but it is off
the supported configuration and may surface unrelated JDK-26 breakage. Prefer
`openjdk@21`.

### Redis

The API requires Redis (apicache). Already installed via Homebrew here:

```bash
redis-cli ping        # expect: PONG
brew services start redis    # if not running
```

---

## Install Solr 9.6.1

Solr 9 is a pure-Java tarball — no architecture-specific build, so the same
artifact works on Apple Silicon and x86.

```bash
cd ~/Downloads
VER=9.6.1
curl -LO "https://archive.apache.org/dist/solr/solr/${VER}/solr-${VER}.tgz"

# Verify the download (recommended — archive.apache.org publishes checksums)
curl -LO "https://archive.apache.org/dist/solr/solr/${VER}/solr-${VER}.tgz.sha512"
shasum -a 512 -c "solr-${VER}.tgz.sha512"

tar xzf "solr-${VER}.tgz"
sudo mv "solr-${VER}" /opt/solr-${VER}
```

Start in **cloud mode** with an embedded ZooKeeper:

```bash
export SOLR_JAVA_HOME=/opt/homebrew/opt/openjdk@21
/opt/solr-9.6.1/bin/solr start -c -p 8983 -m 4g
```

`-m 4g` is generous but this is a query-heavy workload; 2g works for small
fixtures. Confirm it is up and in cloud mode:

```bash
curl -s "http://localhost:8983/solr/admin/collections?action=CLUSTERSTATUS&wt=json" | head -c 300
```

A JSON response with a `cluster` key means `DirectSolrClient` will work. An error
about an unknown handler means it started in standalone mode — stop it
(`bin/solr stop -p 8983`) and restart with `-c`.

---

## Schema

Use **[bv-brc/bv-brc-solr](https://github.com/bv-brc/bv-brc-solr)** — the current,
actively maintained SolrCloud configset repo (last updated 2026-05). It is already
cloud-native and needs no adaptation.

> Note: the API's `tests/README.md` still points at
> [PATRIC3/patric_solr](https://github.com/PATRIC3/patric_solr). **That repo is
> archived** (last pushed 2019-04-08) and targets Solr 5.3 with the legacy
> `schema.xml` + `-Dlucene.version=5.3` layout. Ignore it; `tests/README.md` is
> stale on this point.

Layout, per collection:

```
genome/
  managed-schema        # the real schema (16.7 KB, schema version 1.6)
  solrconfig.xml        # SYMLINK -> ../sharedConfig/solrconfig.xml
sharedConfig/
  solrconfig.xml        # shared by all collections
```

`sharedConfig/solrconfig.xml` declares `<luceneMatchVersion>8.8.1</luceneMatchVersion>`.
Solr 9.6.1 accepts 8.x (n-1 major), so **no edit is required** — this configset works
against 9.6.1 as-is.

The permission fields the enrichment tests depend on are present and correctly typed
in `genome/managed-schema`:

```xml
<field name="genome_id"  type="string"    indexed="true" stored="true"/>
<field name="genome_name" type="string_ci" indexed="true" stored="true"/>
<field name="public"     type="boolean"   indexed="true" stored="true"/>
<field name="owner"      type="string"    indexed="true" stored="true"/>
<field name="user_read"  type="string"    indexed="true" stored="true" multiValued="true"/>
<field name="user_write" type="string"    indexed="true" stored="true" multiValued="true"/>
```

### Create the collections

The repo ships its own scripts. `initialize_cloud.sh` builds the full production
topology (3 shards, multiple tlog replicas, autoscaling policy) — **too heavy for a
laptop**. Use `create_one.sh`, or the equivalent inline, for just the three
collections the permission tests need.

```bash
git clone https://github.com/bv-brc/bv-brc-solr.git ~/bv-brc-solr
cd ~/bv-brc-solr

for core in genome genome_feature feature_sequence sp_gene; do
  # Upload the configset. `zip -r` follows the solrconfig.xml symlink and
  # stores the real shared file, which is what we want.
  (cd "$core" && zip -r - *) | \
    curl -s -X POST --header 'Content-Type:application/octet-stream' --data-binary @- \
    "http://localhost:8983/solr/admin/configs?action=UPLOAD&name=${core}_set"

  # Single shard, single replica — a laptop, not the cluster.
  curl -s "http://localhost:8983/solr/admin/collections?action=CREATE&name=${core}&numShards=1&replicationFactor=1&collection.configName=${core}_set"
  echo
done
```

Two things to watch:

- **The symlink must survive the clone.** `genome/solrconfig.xml` is a 30-byte
  symlink to `../sharedConfig/solrconfig.xml`. If `core.symlinks=false` is set in
  your git config (or on a filesystem that does not support them), you get a
  text file containing the path instead, and the configset upload will produce a
  collection that fails to load. Check with
  `file genome/solrconfig.xml` — expect `symbolic link`, not `ASCII text`. If it
  is wrong: `cp sharedConfig/solrconfig.xml genome/solrconfig.xml` before zipping.
- **`create_one.sh` hardcodes production replica counts** (`tlogReplicas=3`, and
  `maxShardsPerNode`, which was removed in Solr 9). The inline loop above avoids
  both.

Verify:

```bash
curl -s "http://localhost:8983/solr/admin/collections?action=LIST&wt=json"
curl -s "http://localhost:8983/solr/genome/schema/fields?wt=json" | grep -c '"name"'
```

---

## Load fixtures

`tests/generate-local-data-files.js` fetches from the public Data API (default is
now `https://www.bv-brc.org/api`, override with `DATA_API_URL`); it needs internet
but no VPN and no local Solr. `tests/index-local-data-files.js` POSTs to your
local instance.

```bash
cd tests

# Public set
./load-test-solr.js -e http://localhost:8983/solr \
  -g ./5-test-genome-ids.json -f ./test-files-public

# Private to alice, readable by bob — exercises all three branches of the
# permission fq (public / owner / user_read) in one fixture
./load-test-solr.js -e http://localhost:8983/solr \
  -g ./50-test-genome-ids-2.json -f ./test-files-private \
  -o alice@patricbrc.org -p -r bob@patricbrc.org

# Only load the cores you actually created collections for
./load-test-solr.js -e http://localhost:8983/solr \
  -g ./5-test-genome-ids.json -f ./test-files-public \
  -c genome,genome_feature,sp_gene
```

| flag | effect |
|---|---|
| `-o <user>` | sets `owner` on every doc |
| `-p` | sets `public: false` |
| `-r <u1,u2>` | sets `user_read` (multiValued array, not a comma string) |
| `-c <cores>` | only load these cores; others are skipped and reported |

The loader prints a per-run summary of which cores loaded, were skipped, and
failed, and **exits non-zero if any core failed**. A core whose collection does
not exist is called out by name:

```
  MISSING COLLECTION 'pathway' at http://localhost:8983/solr — skipping
```

That case is common when you have created only some collections — Solr answers an
unknown collection with a 404 whose body is an HTML "Searching for Solr?" page,
which previously scrolled past as an unremarkable error line among hundreds.

The downloader fetches all of `genome`, `genome_feature`, `genome_sequence`,
`pathway`, `sp_gene`, `genome_amr`, `subsystem` per genome, so either create all
seven collections or use `-c` to select a subset.

---

## Point the API at it

In `p3api.conf`:

```json
{
  "solr": { "url": "http://localhost:8983/solr" },
  "distributedQuery": {
    "enabled": false,
    "rejectUnauthorized": true
  }
}
```

`distributedQuery.enabled: false` turns off distributed *query routing*
(`middleware/DistributedQuery.js:160`). Note it does **not** disable enrichment:
`getJoiner()` builds a `DirectSolrClient` unconditionally
(`middleware/JoinEnrichment.js:38-50`), reading `distributedQuery` config only for
TLS options. That is fine and intended here — against a single-node instance the
direct client works, and it is the code path under test.

No `ca` or `rejectUnauthorized: false` needed: local Solr is plain HTTP, so the
self-signed-cert workarounds required for production do not apply.

```bash
npm start
curl -s localhost:3001/health      # expect: OK (version)
```

---

## Verify the permission fix

The three-way assertion, all on one request shape — query `genome_feature` for a
feature of a private genome, requesting the joined `genome_name`:

```
GET /genome_feature/?eq(genome_id,<PRIVATE_ID>)&select(feature_id,genome_name)&limit(5)
```

| as | expected |
|---|---|
| owner (`alice`) | `genome_name` present |
| other user (`bob`, authenticated) | `genome_name` absent |
| anonymous | `genome_name` absent |

The third user **must be a genuinely different authenticated identity**, not just
an anonymous request — anonymous-vs-owner passes even against a broken filter that
only checks `public:true`.

Then the cache test, which is the actual merge gate: issue alice's request and
bob's request **against the same running process, no restart**, same `genome_id`.
Bob must not receive alice's value from the warm cache. This is the scenario the
unit tests cover at `tests/test-permissions/test.enrichment-permissions.spec.js`
("2. Cache leak"), reproduced end-to-end.

Tokens go in `tests/config.json` (copy from `tests/config.sample.json`).

---

## Teardown

```bash
/opt/solr-9.6.1/bin/solr stop -p 8983
```

Collections and indexed data persist in `/opt/solr-9.6.1/server/solr/`. To reset a
collection without a full reinstall:

```bash
curl -s "http://localhost:8983/solr/admin/collections?action=DELETE&name=genome"
```
