#!/usr/bin/env node

/**
 * Check request traffic distribution across replicas for a SolrCloud collection.
 *
 * Queries each replica's metrics API to compare request counts and rates,
 * highlighting imbalances where one replica is handling disproportionate traffic.
 *
 * Usage:
 *   node scripts/check-replica-traffic.js -c <collection> [options]
 *
 * Options:
 *   -c, --collection    Collection name (required)
 *   -s, --shard         Specific shard to check (default: all shards)
 *   --config            Path to p3api.conf (default: auto-detect)
 *   --verbose           Show detailed metrics per replica
 *
 * Examples:
 *   node scripts/check-replica-traffic.js -c feature_sequence
 *   node scripts/check-replica-traffic.js -c feature_sequence -s shard11
 *   node scripts/check-replica-traffic.js -c genome_feature --verbose
 */

const https = require('https')
const http = require('http')
const fs = require('fs')
const path = require('path')

// Parse command line arguments
function parseArgs () {
  const args = {
    collection: null,
    shard: null,
    config: null,
    verbose: false,
    duration: 0 // seconds to monitor (0 = single snapshot)
  }

  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i]
    switch (arg) {
      case '-c':
      case '--collection':
        args.collection = process.argv[++i]
        break
      case '-s':
      case '--shard':
        args.shard = process.argv[++i]
        break
      case '--config':
        args.config = process.argv[++i]
        break
      case '--verbose':
        args.verbose = true
        break
      case '-d':
      case '--duration':
        args.duration = parseInt(process.argv[++i], 10)
        break
      case '-h':
      case '--help':
        console.log(`
Usage: node check-replica-traffic.js -c <collection> [options]

Options:
  -c, --collection    Collection name (required)
  -s, --shard         Specific shard to check (default: all shards)
  -d, --duration      Monitor for N seconds, showing traffic delta (default: single snapshot)
  --config            Path to p3api.conf (default: auto-detect)
  --verbose           Show detailed metrics per replica
`)
        process.exit(0)
    }
  }

  if (!args.collection) {
    console.error('Error: --collection is required')
    process.exit(1)
  }

  return args
}

// Load config
function loadConfig (configPath) {
  const searchPaths = configPath
    ? [configPath]
    : [
        path.join(process.cwd(), 'p3api.conf'),
        path.join(__dirname, '..', 'p3api.conf'),
        '/disks/p3/p3-api/BV-BRC-API/p3api.conf'
      ]

  for (const p of searchPaths) {
    try {
      const data = fs.readFileSync(p, 'utf8')
      console.log(`Loading config from: ${p}`)
      return JSON.parse(data)
    } catch (e) {
      // continue
    }
  }

  console.error('Could not find p3api.conf')
  process.exit(1)
}

// HTTP request helper
function httpRequest (url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url)
    const httpModule = parsedUrl.protocol === 'https:' ? https : http

    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: { Accept: 'application/json' },
      timeout: options.timeout || 30000,
      rejectUnauthorized: options.rejectUnauthorized !== undefined
        ? options.rejectUnauthorized
        : true
    }

    if (options.ca) {
      reqOptions.ca = options.ca
    }

    if (parsedUrl.username && parsedUrl.password) {
      reqOptions.auth = `${decodeURIComponent(parsedUrl.username)}:${decodeURIComponent(parsedUrl.password)}`
    }

    const req = httpModule.request(reqOptions, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data))
          } catch (err) {
            reject(new Error(`Failed to parse JSON: ${err.message}`))
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`))
        }
      })
    })

    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('Request timeout'))
    })
    req.end()
  })
}

function formatNodeName (nodeName) {
  return (nodeName || '').replace(/_solr$/, '').replace(/\.cels\.anl\.gov/, '')
}

function extractHostname (baseUrl) {
  try {
    return new URL(baseUrl).hostname.replace(/\.cels\.anl\.gov$/, '')
  } catch {
    return baseUrl
  }
}

async function main () {
  const args = parseArgs()
  const config = loadConfig(args.config)
  const solrBaseUrl = config.solr?.url || config.solrUrl

  if (!solrBaseUrl) {
    console.error('Solr URL not found in config')
    process.exit(1)
  }

  console.log(`\nConnecting to Solr: ${solrBaseUrl.replace(/\/\/[^:]+:[^@]+@/, '//***:***@')}`)

  const requestOptions = {
    timeout: 30000,
    rejectUnauthorized: config.distributedQuery?.rejectUnauthorized !== false ? true : false
  }

  // Load CA certificate if configured
  if (config.distributedQuery?.ca) {
    const caPath = config.distributedQuery.ca
    try {
      if (caPath.startsWith('/') || caPath.startsWith('./')) {
        requestOptions.ca = fs.readFileSync(caPath)
        console.log(`Loaded CA certificate from: ${caPath}`)
      }
    } catch (err) {
      console.log(`Warning: Could not read CA file: ${err.message}`)
    }
  }

  // Get cluster status
  console.log('Fetching cluster status...')
  const clusterStatus = await httpRequest(
    `${solrBaseUrl}/admin/collections?action=CLUSTERSTATUS&collection=${args.collection}`,
    requestOptions
  )

  const collectionInfo = clusterStatus.cluster?.collections?.[args.collection]
  if (!collectionInfo) {
    // Check aliases
    const aliases = clusterStatus.cluster?.aliases || {}
    const resolvedName = aliases[args.collection]
    if (resolvedName) {
      console.log(`Collection '${args.collection}' is an alias for '${resolvedName}'`)
      const resolvedInfo = clusterStatus.cluster.collections[resolvedName]
      if (!resolvedInfo) {
        console.error(`Resolved collection '${resolvedName}' not found`)
        process.exit(1)
      }
      // Use resolved collection
      return processCollection(resolvedInfo, resolvedName, args, solrBaseUrl, requestOptions)
    }
    console.error(`Collection not found: ${args.collection}`)
    process.exit(1)
  }

  const resolvedCollection = collectionInfo
  const resolvedName = args.collection

  if (args.duration > 0) {
    await monitorCollection(resolvedCollection, resolvedName, args, solrBaseUrl, requestOptions)
  } else {
    await processCollection(resolvedCollection, resolvedName, args, solrBaseUrl, requestOptions)
  }
}

async function monitorCollection (collectionInfo, collectionName, args, solrBaseUrl, requestOptions) {
  const replicas = buildReplicaList(collectionInfo, args)

  console.log(`\nCollection: ${collectionName}`)
  console.log(`Shards: ${Object.keys(collectionInfo.shards || {}).length}, Replicas: ${replicas.length}`)
  console.log(`\nTaking first snapshot...`)

  const snapshot1 = await fetchAllMetrics(replicas, solrBaseUrl, args, requestOptions)
  const startTime = Date.now()

  console.log(`Monitoring for ${args.duration} seconds... (Ctrl+C to stop early)`)

  await new Promise(resolve => setTimeout(resolve, args.duration * 1000))

  console.log('Taking second snapshot...')
  const snapshot2 = await fetchAllMetrics(replicas, solrBaseUrl, args, requestOptions)
  const elapsed = (Date.now() - startTime) / 1000

  // Compute deltas
  const deltas = snapshot2.map((s2, i) => {
    const s1 = snapshot1[i]
    const reqDelta = (s2.requests >= 0 && s1.requests >= 0) ? s2.requests - s1.requests : -1
    return {
      ...s2,
      requests: reqDelta,
      reqPerSec: reqDelta >= 0 ? reqDelta / elapsed : 0,
      avgTime: reqDelta > 0 ? (s2.totalTime - s1.totalTime) / reqDelta : 0,
      totalTime: s2.totalTime - s1.totalTime,
      errors: (s2.errors >= 0 && s1.errors >= 0) ? s2.errors - s1.errors : 0
    }
  })

  // Print report
  console.log('\n' + '='.repeat(120))
  console.log(`REPLICA TRAFFIC REPORT (${elapsed.toFixed(0)}s monitoring window)`)
  console.log('='.repeat(120))
  console.log(`\nCollection: ${collectionName}`)
  console.log(`Time: ${new Date().toISOString()}`)
  console.log(`Window: ${elapsed.toFixed(1)} seconds`)

  printShardReport(deltas, true)
  printHostAggregate(deltas, elapsed)
}

function buildReplicaList (collectionInfo, args) {
  const shards = collectionInfo.shards || {}
  const replicas = []
  for (const shardName of Object.keys(shards).sort()) {
    if (args.shard && shardName !== args.shard) continue
    const shardData = shards[shardName]
    for (const [replicaName, replicaData] of Object.entries(shardData.replicas || {})) {
      replicas.push({
        shard: shardName,
        replica: replicaName,
        core: replicaData.core,
        node: replicaData.node_name,
        type: replicaData.type || 'NRT',
        state: replicaData.state,
        leader: replicaData.leader === 'true',
        baseUrl: replicaData.base_url
      })
    }
  }
  return replicas
}

async function fetchAllMetrics (replicas, solrBaseUrl, args, requestOptions) {
  const metricsPrefix = 'QUERY./select'

  // Probe first replica to discover metrics key format
  if (args.verbose && replicas.length > 0) {
    const probeReplica = replicas[0]
    const probeUrl = `${probeReplica.baseUrl}/${probeReplica.core}/admin/mbeans?stats=true&cat=QUERY&key=/select&wt=json`
    const parsedSolr = new URL(solrBaseUrl)
    const parsedProbe = new URL(probeUrl)
    if (parsedSolr.username) {
      parsedProbe.username = parsedSolr.username
      parsedProbe.password = parsedSolr.password
    }
    try {
      const probeResponse = await httpRequest(parsedProbe.toString(), requestOptions)
      console.log(`\nProbe response keys for ${probeReplica.core}:`)
      const handler = probeResponse?.['solr-mbeans']
      if (handler) {
        for (let i = 0; i < handler.length; i += 2) {
          if (handler[i] === 'QUERY') {
            const queryHandlers = handler[i + 1]
            for (const [name, stats] of Object.entries(queryHandlers)) {
              console.log(`  Handler: ${name}`)
              if (stats.stats) {
                console.log(`  Stats keys: ${Object.keys(stats.stats).join(', ')}`)
              }
            }
          }
        }
      }
    } catch (err) {
      console.log(`Probe failed: ${err.message}`)
    }
  }

  return Promise.all(replicas.map(async (replica) => {
    // Use the per-core MBeans handler stats endpoint — more reliable than /admin/metrics across Solr versions
    const metricsUrl = `${replica.baseUrl}/${replica.core}/admin/mbeans?stats=true&cat=QUERY&key=/select&wt=json`

    // Inject auth from solrBaseUrl
    const parsedSolr = new URL(solrBaseUrl)
    const parsedMetrics = new URL(metricsUrl)
    if (parsedSolr.username) {
      parsedMetrics.username = parsedSolr.username
      parsedMetrics.password = parsedSolr.password
    }

    try {
      const response = await httpRequest(parsedMetrics.toString(), requestOptions)

      // Parse MBeans response — array of alternating [category, {handler: stats}]
      let stats = {}
      const mbeans = response?.['solr-mbeans']
      if (mbeans) {
        for (let i = 0; i < mbeans.length; i += 2) {
          if (mbeans[i] === 'QUERY') {
            const handlers = mbeans[i + 1]
            // Look for /select handler
            const selectHandler = handlers['/select'] || handlers['select'] || handlers['/get']
            if (selectHandler?.stats) {
              stats = selectHandler.stats
            }
          }
        }
      }

      // Also try the /admin/metrics endpoint as fallback
      if (Object.keys(stats).length === 0) {
        const metricsUrl2 = `${replica.baseUrl}/admin/metrics?group=core&prefix=${metricsPrefix}&wt=json`
        const parsedMetrics2 = new URL(metricsUrl2)
        if (parsedSolr.username) {
          parsedMetrics2.username = parsedSolr.username
          parsedMetrics2.password = parsedSolr.password
        }
        const response2 = await httpRequest(parsedMetrics2.toString(), requestOptions)
        // Search all core keys for this replica's core
        for (const [key, val] of Object.entries(response2.metrics || {})) {
          if (key.includes(replica.core)) {
            stats = val
            break
          }
        }
      }

      // Extract stats — try multiple key formats
      const get = (...keys) => {
        for (const k of keys) {
          if (stats[k] !== undefined) return stats[k]
        }
        return 0
      }

      // Count both direct requests AND shard sub-queries from coordinators
      // QUERY./select.requests = direct requests
      // QUERY./select[shard].requests = sub-queries from coordinators (distrib=false&isShard=true)
      const directRequests = get('QUERY./select.requests', 'requests')
      const shardRequests = get('QUERY./select[shard].requests')
      const totalRequests = directRequests + shardRequests

      return {
        ...replica,
        requests: totalRequests,
        directRequests,
        shardRequests,
        totalTime: get('QUERY./select.totalTime', 'totalTime') + get('QUERY./select[shard].totalTime'),
        avgTime: totalRequests > 0
          ? (get('QUERY./select.totalTime', 'totalTime') + get('QUERY./select[shard].totalTime')) / totalRequests
          : 0,
        rate5min: get('QUERY./select.requestTimes.meanRate', 'requestTimes.meanRate', `${metricsPrefix}.requestTimes.meanRate`) +
                  get('QUERY./select[shard].requestTimes.meanRate'),
        rate15min: 0,
        errors: get('QUERY./select.errors.count', 'errors', `${metricsPrefix}.errors`) +
                get('QUERY./select[shard].errors.count'),
        error: null
      }
    } catch (err) {
      return {
        ...replica,
        requests: -1,
        totalTime: 0,
        avgTime: 0,
        rate5min: 0,
        rate15min: 0,
        errors: 0,
        error: err.message
      }
    }
  }))
}

function printShardReport (results, isDelta) {
  const rateLabel = isDelta ? 'Req/s' : 'Req/s(5m)'

  // Group by shard
  const byShardMap = new Map()
  for (const r of results) {
    if (!byShardMap.has(r.shard)) byShardMap.set(r.shard, [])
    byShardMap.get(r.shard).push(r)
  }
  const byShard = [...byShardMap.entries()].sort((a, b) => {
    const numA = parseInt(a[0].replace(/\D/g, '')) || 0
    const numB = parseInt(b[0].replace(/\D/g, '')) || 0
    return numA - numB
  })

  console.log('\n' + '-'.repeat(120))
  console.log('PER-SHARD TRAFFIC DISTRIBUTION')
  console.log('-'.repeat(120))

  const imbalanced = []

  for (const [shardName, shardReplicas] of byShard) {
    const successful = shardReplicas.filter(r => r.requests >= 0)
    if (successful.length === 0) continue

    const totalRequests = successful.reduce((s, r) => s + r.requests, 0)
    const maxRequests = Math.max(...successful.map(r => r.requests))

    const avgRequests = totalRequests / successful.length
    const imbalanceRatio = avgRequests > 0 ? maxRequests / avgRequests : 1
    const isImbalanced = imbalanceRatio > 1.5 && successful.length > 1

    if (isImbalanced) {
      imbalanced.push({ shard: shardName, ratio: imbalanceRatio, replicas: shardReplicas })
    }

    // Skip shards with zero traffic unless verbose
    if (totalRequests === 0) continue

    console.log(`\n  ${shardName}: ${successful.length} replicas, ${totalRequests.toLocaleString()} requests${isImbalanced ? '  *** IMBALANCED ***' : ''}`)

    const rows = shardReplicas.map(r => {
      const row = {
        Replica: r.core.substring(0, 45),
        Host: extractHostname(r.baseUrl),
        Type: r.type,
        Leader: r.leader ? 'Y' : '',
        Requests: r.requests >= 0 ? r.requests.toLocaleString() : 'ERR',
        'AvgTime(ms)': r.requests >= 0 ? r.avgTime.toFixed(1) : '-',
        Errors: r.requests >= 0 ? r.errors.toLocaleString() : '-',
        '% Share': totalRequests > 0 && r.requests >= 0
          ? ((r.requests / totalRequests) * 100).toFixed(1) + '%'
          : '-'
      }
      if (isDelta) {
        row['Req/s'] = r.reqPerSec !== undefined ? r.reqPerSec.toFixed(2) : '-'
      } else {
        row['Req/s(5m)'] = r.rate5min !== undefined ? r.rate5min.toFixed(2) : '-'
        row['Req/s(15m)'] = r.rate15min !== undefined ? r.rate15min.toFixed(2) : '-'
      }
      return row
    })

    console.table(rows)
  }

  if (imbalanced.length > 0) {
    console.log('\n' + '!'.repeat(120))
    console.log('TRAFFIC IMBALANCES DETECTED')
    console.log('!'.repeat(120))

    for (const { shard, ratio, replicas: shardReplicas } of imbalanced) {
      const sorted = shardReplicas.filter(r => r.requests >= 0).sort((a, b) => b.requests - a.requests)
      const heaviest = sorted[0]
      const lightest = sorted[sorted.length - 1]

      console.log(`\n  ${shard}: ${ratio.toFixed(1)}x imbalance`)
      console.log(`    Heaviest: ${heaviest.core} on ${extractHostname(heaviest.baseUrl)} (${heaviest.type}${heaviest.leader ? '/leader' : ''}) — ${heaviest.requests.toLocaleString()} requests`)
      console.log(`    Lightest: ${lightest.core} on ${extractHostname(lightest.baseUrl)} (${lightest.type}${lightest.leader ? '/leader' : ''}) — ${lightest.requests.toLocaleString()} requests`)
    }
  } else {
    console.log('\nNo significant traffic imbalances detected.')
  }
}

function printHostAggregate (results, elapsed) {
  console.log('\n' + '-'.repeat(120))
  console.log('PER-HOST AGGREGATE')
  console.log('-'.repeat(120))

  const byHost = new Map()
  for (const r of results) {
    if (r.requests < 0) continue
    const host = extractHostname(r.baseUrl)
    if (!byHost.has(host)) {
      byHost.set(host, { requests: 0, replicas: 0, errors: 0 })
    }
    const h = byHost.get(host)
    h.requests += r.requests
    h.errors += r.errors
    h.replicas++
  }

  const hostRows = [...byHost.entries()]
    .sort((a, b) => b[1].requests - a[1].requests)
    .map(([host, h]) => ({
      Host: host,
      Replicas: h.replicas,
      'Total Requests': h.requests.toLocaleString(),
      'Req/s': elapsed ? (h.requests / elapsed).toFixed(2) : '-',
      Errors: h.errors.toLocaleString()
    }))

  console.table(hostRows)
}

async function processCollection (collectionInfo, collectionName, args, solrBaseUrl, requestOptions) {
  const replicas = buildReplicaList(collectionInfo, args)

  console.log(`\nCollection: ${collectionName}`)
  console.log(`Shards: ${Object.keys(collectionInfo.shards || {}).length}, Replicas: ${replicas.length}`)
  console.log(`\nFetching metrics from ${replicas.length} replicas...`)

  const results = await fetchAllMetrics(replicas, solrBaseUrl, args, requestOptions)

  console.log('\n' + '='.repeat(120))
  console.log('REPLICA TRAFFIC REPORT (cumulative since JVM start)')
  console.log('='.repeat(120))
  console.log(`\nCollection: ${collectionName}`)
  console.log(`Time: ${new Date().toISOString()}`)

  printShardReport(results, false)
  printHostAggregate(results)
}

main().catch(err => {
  console.error(`Error: ${err.message}`)
  process.exit(1)
})
