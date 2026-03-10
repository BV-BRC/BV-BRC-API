# Distributed Query Quick Start

This guide gets you up and running with the distributed query system in 5 minutes.

## Prerequisites

- BV-BRC API server running
- Solr cluster with sharded collections
- Valid authentication token

## 1. Verify Installation

```bash
# Check if the endpoint is available
curl http://localhost:3001/test/distributed-query/config
```

Expected response:
```json
{
  "current": { "maxParallelism": 8, ... },
  "defaults": { ... }
}
```

## 2. Check Shard Topology

```bash
# See shards for a collection
curl http://localhost:3001/test/distributed-query/shards/genome_feature
```

## 3. Run Your First Query

```bash
# Simple unordered query
curl -X POST http://localhost:3001/test/distributed-query \
  -H "Content-Type: application/json" \
  -d '{
    "collection": "genome_feature",
    "query": "fq=genome_id:83332.12",
    "fields": "patric_id,product"
  }'
```

Output (newline-delimited JSON):
```
{"patric_id":"fig|83332.12.peg.1","product":"chromosomal replication initiator"}
{"patric_id":"fig|83332.12.peg.2","product":"DNA polymerase III beta subunit"}
...
{"_meta":{"queryId":1,"documentCount":4242,"elapsedMs":1523}}
```

## 4. Sorted Query

```bash
# Add sort for globally ordered output
curl -X POST http://localhost:3001/test/distributed-query \
  -H "Content-Type: application/json" \
  -d '{
    "collection": "genome_feature",
    "query": "fq=genome_id:83332.12&fq=feature_type:CDS",
    "sort": "start asc",
    "fields": "patric_id,start,end,product"
  }'
```

## 5. Limited Results

```bash
# Get first 100 results
curl -X POST http://localhost:3001/test/distributed-query \
  -H "Content-Type: application/json" \
  -d '{
    "collection": "genome",
    "query": "fq=taxon_lineage_ids:773",
    "sort": "genome_name asc",
    "limit": 100,
    "fields": "genome_id,genome_name,organism_name"
  }'
```

## 6. Save to File

```bash
# Stream results directly to file
curl -X POST http://localhost:3001/test/distributed-query \
  -H "Content-Type: application/json" \
  -d '{
    "collection": "genome_feature",
    "query": "fq=genome_id:83332.12",
    "fields": "patric_id,product,start,end,strand"
  }' > features.ndjson

# Count lines (excluding metadata)
grep -v '"_meta"' features.ndjson | wc -l
```

## 7. Convert to JSON Array

```bash
# Use jq to convert NDJSON to JSON array
curl -X POST http://localhost:3001/test/distributed-query \
  -H "Content-Type: application/json" \
  -d '{"collection": "genome_feature", "query": "fq=genome_id:83332.12", "limit": 10}' \
  | grep -v '"_meta"' | jq -s '.'
```

## 8. Check Query Stats

```bash
# See active queries and cache stats
curl http://localhost:3001/test/distributed-query/stats
```

## Common Query Patterns

### All features for multiple genomes
```json
{
  "collection": "genome_feature",
  "query": "fq=genome_id:(83332.12 OR 83333.1 OR 83334.1)",
  "fields": "genome_id,patric_id,product"
}
```

### Features by taxon
```json
{
  "collection": "genome_feature",
  "query": "fq=taxon_id:83332&fq=feature_type:CDS",
  "sort": "genome_id asc, start asc",
  "fields": "genome_id,patric_id,product,start,end"
}
```

### Genomes by criteria
```json
{
  "collection": "genome",
  "query": "fq=taxon_lineage_ids:773&fq=genome_status:Complete",
  "sort": "genome_name asc",
  "fields": "genome_id,genome_name,contigs,genome_length"
}
```

## Troubleshooting

**"collection is required"**
- Make sure request body is valid JSON
- Check Content-Type header

**Empty results**
- Verify query syntax
- Check shard availability: `/test/distributed-query/shards/{collection}`

**Timeout**
- Add a `limit` to your query
- Check Solr cluster health

## Next Steps

- Read the [full documentation](./DISTRIBUTED_QUERY_DOCS.md)
- Configure admin users for runtime config changes
- Integrate into your application
