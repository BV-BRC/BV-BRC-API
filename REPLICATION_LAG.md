# SolrCloud Replication Lag and Consistency Issues

This document describes common SolrCloud replication issues encountered in the BV-BRC infrastructure and how to diagnose and fix them.

## Overview

SolrCloud uses a leader/follower model where:
- Each shard has one **leader** that receives writes
- Leaders replicate changes to **followers** (replicas)
- Followers poll the leader periodically (default: every 5 minutes) or receive push notifications

When replication fails, followers can fall behind, resulting in inconsistent query results depending on which replica handles the request.

## Symptoms

- **Inconsistent counts**: Same query returns different document counts on different requests
- **Missing documents**: Recently indexed documents don't appear in some queries
- **Intermittent failures**: Some queries fail or return partial results

## Diagnostic Tool

The `scripts/check-shard-consistency.js` tool can diagnose and fix replication issues.

### Installation

No installation needed - it's part of the p3_api repository. Requires:
- Node.js
- Access to `p3api.conf` with Solr credentials

### Basic Usage

#### Check consistency for a specific query

```bash
# Check all replicas for a specific genome
node scripts/check-shard-consistency.js \
  -c genome_feature \
  -q "genome_id:123.456" \
  --all-replicas \
  --count-only
```

This will:
1. Query each shard's leader and followers directly
2. Compare document counts
3. Report any inconsistencies

#### Check all leaders for disabled replication

```bash
# Scan all leaders in a collection
node scripts/check-shard-consistency.js \
  -c genome_feature \
  --check-leaders
```

This will:
1. Get cluster status from ZooKeeper
2. Query each leader's replication handler
3. Report any leaders with replication disabled

### Command Reference

| Option | Description |
|--------|-------------|
| `-c, --collection <name>` | Solr collection to check (required) |
| `-q, --query <query>` | Solr query (default: `*:*`) |
| `--fq <filter>` | Filter query |
| `-r, --rows <num>` | Rows to fetch per shard (default: 10) |
| `-a, --all-replicas` | Query ALL replicas, not just one per shard |
| `--count-only` | Only compare counts, skip document comparison |
| `--check-leaders` | Check replication status on all leaders |
| `--fix` | Attempt to fix issues |
| `--dry-run` | Show what --fix would do without doing it |
| `--force-sync` | With --fix, also trigger follower recovery |
| `-v, --verbose` | Verbose output |
| `-t, --timeout <ms>` | Request timeout (default: 30000) |
| `--config <path>` | Path to p3api.conf |

## Common Issues and Fixes

### Issue 1: Leader Replication Disabled

**Symptom**: Followers consistently have fewer documents than leaders.

**Root Cause**: The leader's replication handler has `replicationEnabled: false`, preventing it from serving as a replication source.

**Diagnosis**:

```bash
# Check a specific leader
curl "https://USER:PASS@solr-host:8983/solr/CORE_NAME/replication?command=details&wt=json" | jq '.details.leader'

# Output showing the problem:
{
  "replicateAfter": ["commit"],
  "replicationEnabled": "false",  # <-- PROBLEM
  "replicableVersion": 1773673805010,
  "replicableGeneration": 28632
}
```

**Manual Fix**:

```bash
# Enable replication on the leader
curl "https://USER:PASS@solr-host:8983/solr/CORE_NAME/replication?command=enablereplication"
```

**Automated Fix**:

```bash
# Check and fix all leaders
node scripts/check-shard-consistency.js \
  -c genome_feature \
  --check-leaders \
  --fix

# Also trigger follower sync
node scripts/check-shard-consistency.js \
  -c genome_feature \
  --check-leaders \
  --fix \
  --force-sync
```

### Issue 2: Follower Needs Recovery

**Symptom**: Leader replication is enabled, but follower is still behind.

**Root Cause**: The follower hasn't polled recently or needs to re-sync.

**Manual Fix**:

```bash
# Trigger recovery on the follower (must be sent to the follower's node)
curl "https://USER:PASS@follower-host:8983/solr/admin/cores?action=REQUESTRECOVERY&core=CORE_NAME"
```

**Automated Fix**:

```bash
# Find and fix inconsistencies
node scripts/check-shard-consistency.js \
  -c genome_feature \
  -q "genome_id:123.456" \
  --all-replicas \
  --count-only \
  --fix
```

### Issue 3: Index Corruption

**Symptom**: Recovery fails, replication can't complete, or document counts are wildly different.

**Root Cause**: The index files are corrupted on leader or follower.

**Fix**: Delete and re-add the replica:

```bash
# Delete the corrupted replica
curl "https://SOLR_HOST:8983/solr/admin/collections?action=DELETEREPLICA&collection=genome_feature&shard=shard4&replica=core_node_XXX"

# Add a new replica (Solr will sync from leader)
curl "https://SOLR_HOST:8983/solr/admin/collections?action=ADDREPLICA&collection=genome_feature&shard=shard4&node=target-host:8983_solr"
```

## Understanding the Output

### Consistency Check Output

```
================================================================================
SHARD CONSISTENCY REPORT
================================================================================

Collection: genome_feature
Query: genome_id:123.456
Mode: All Replicas
Rows per shard: 0

----------------------------------------
OVERVIEW
----------------------------------------
Total Shards: 128
Total Replicas Queried: 384
Successful Queries: 384
Failed Queries: 0
Total Documents (sum of leaders): 15234

Leader vs Follower Comparison:
  Total in Leaders:   15234
  Total in Followers: 15226 (avg per shard)
  Difference:         +8 (0.05%)

----------------------------------------
SHARD BREAKDOWN
----------------------------------------
┌─────────┬──────────┬──────────┬─────────────────┐
│ Shard   │ Replicas │ Counts   │ Consistent      │
├─────────┼──────────┼──────────┼─────────────────┤
│ shard4  │ 3/3      │ 2, 1, 1  │ ✗ INCONSISTENT │
│ shard77 │ 3/3      │ 1, 0, 0  │ ✗ INCONSISTENT │
│ ...     │ ...      │ ...      │ ✓               │
└─────────┴──────────┴──────────┴─────────────────┘

!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
INCONSISTENCIES DETECTED
!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

[LEADER_FOLLOWER_MISMATCH] Shard shard4: Leader has 2, follower on balsam.cels.anl.gov:8983 has 1 (diff: +1)
[LEADER_FOLLOWER_MISMATCH] Shard shard77: Leader has 1, follower on balsam.cels.anl.gov:8983 has 0 (diff: +1)
```

### Leader Check Output

```
================================================================================
LEADER REPLICATION STATUS CHECK
================================================================================

Collection: genome_feature
Total shards: 128

Checking replication status on all leaders...

  shard4: ⚠ DISABLED on bio-gp3.cels.anl.gov:15383 (genome_feature_shard4_replica_n130)
  shard77: ⚠ DISABLED on bio-gp2.cels.anl.gov:15983 (genome_feature_shard77_replica_n331)

----------------------------------------
SUMMARY
----------------------------------------
Total shards checked: 128
Replication enabled:  126
Replication DISABLED: 2

!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
WARNING: 2 leader(s) have replication DISABLED
!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

Run with --fix to enable replication on these leaders.
```

## Prevention

### Monitoring

Set up periodic checks:

```bash
# Cron job to check leaders daily
0 6 * * * /path/to/node /path/to/scripts/check-shard-consistency.js \
  -c genome_feature --check-leaders 2>&1 | mail -s "Solr Leader Check" admin@example.com
```

### Why Does Replication Get Disabled?

This can happen due to:
1. **Leader election**: When a new leader is elected, replication configuration may not be properly initialized
2. **Core reload**: Reloading a core can reset replication settings
3. **Configuration drift**: Manual changes or failed operations
4. **Bugs in SolrCloud**: Edge cases in the replication protocol

### Best Practices

1. **Regular monitoring**: Run `--check-leaders` periodically
2. **After major operations**: Check replication after:
   - Adding/removing nodes
   - Large batch indexing
   - Collection configuration changes
3. **During incidents**: Use the tool to quickly diagnose consistency issues

## Technical Details

### How the Tool Works

1. **Cluster Discovery**: Queries `/admin/collections?action=CLUSTERSTATUS` to get shard/replica topology
2. **Direct Queries**: Queries each replica directly with `distrib=false` to get local-only results
3. **Comparison**: Compares document counts and optionally document IDs across replicas
4. **Fix**: Uses Solr's replication and recovery APIs to fix issues

### Solr APIs Used

| API | Purpose |
|-----|--------|
| `/admin/collections?action=CLUSTERSTATUS` | Get cluster topology |
| `/{collection}/schema` | Get unique key field |
| `/{core}/select?distrib=false` | Query single replica |
| `/{core}/replication?command=details` | Get replication status |
| `/{core}/replication?command=enablereplication` | Enable replication on leader |
| `/admin/cores?action=REQUESTRECOVERY` | Trigger follower sync |
| `/{collection}/update?commit=true` | Force commit |

## Troubleshooting

### Script fails with authentication errors

Check that `p3api.conf` has the correct Solr URL with credentials:

```json
{
  "solr": {
    "url": "https://user:password@solr-host:8983/solr"
  }
}
```

### Script fails with SSL errors

For self-signed certificates, add to config:

```json
{
  "distributedQuery": {
    "rejectUnauthorized": false
  }
}
```

### Recovery triggered but follower still behind

Recovery can take time for large shards. Wait a few minutes and check again.

If it still fails, check the follower's Solr logs:

```bash
grep -i "recovery\|replication" /var/solr/logs/solr.log | tail -100
```

### Leader shows `generation: 0` or `version: 0`

This indicates the leader's replication handler isn't properly configured. The `--fix` option will enable replication, which should resolve this.
