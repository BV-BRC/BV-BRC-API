#!/usr/bin/env node
/**
 * Shard Consistency Checker
 *
 * Queries all shards and replicas for a collection and compares results
 * to detect potential index corruption or inconsistencies.
 *
 * Usage:
 *   node scripts/check-shard-consistency.js --collection <name> --query <solr-query> [options]
 *
 * Examples:
 *   node scripts/check-shard-consistency.js --collection genome_feature --query "genome_id:123"
 *   node scripts/check-shard-consistency.js --collection genome --query "*:*" --rows 0
 *   node scripts/check-shard-consistency.js --collection genome_feature --query "annotation:PATRIC" --field patric_id
 */

const http = require('http')
const https = require('https')
const { URL } = require('url')
const fs = require('fs')
const path = require('path')

// Parse command line arguments
function parseArgs() {
  const args = {
    collection: null,
    query: '*:*',
    fq: null,
    rows: 10,
    field: null,  // Field to compare values across replicas
    config: null,
    timeout: 30000,
    verbose: false,
    allReplicas: false,  // Query all replicas, not just one per shard
    countOnly: false,    // Only compare counts, not documents
  }

  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--collection':
      case '-c':
        args.collection = argv[++i]
        break
      case '--query':
      case '-q':
        args.query = argv[++i]
        break
      case '--fq':
        args.fq = argv[++i]
        break
      case '--rows':
      case '-r':
        args.rows = parseInt(argv[++i], 10)
        break
      case '--field':
      case '-f':
        args.field = argv[++i]
        break
      case '--config':
        args.config = argv[++i]
        break
      case '--timeout':
      case '-t':
        args.timeout = parseInt(argv[++i], 10)
        break
      case '--verbose':
      case '-v':
        args.verbose = true
        break
      case '--all-replicas':
      case '-a':
        args.allReplicas = true
        break
      case '--count-only':
        args.countOnly = true
        break
      case '--help':
      case '-h':
        printUsage()
        process.exit(0)
      default:
        if (argv[i].startsWith('-')) {
          console.error(`Unknown option: ${argv[i]}`)
          process.exit(1)
        }
    }
  }

  if (!args.collection) {
    console.error('Error: --collection is required')
    printUsage()
    process.exit(1)
  }

  return args
}

function printUsage() {
  console.log(`
Shard Consistency Checker - Detect index corruption across Solr shards/replicas

Usage:
  node scripts/check-shard-consistency.js --collection <name> [options]

Required:
  --collection, -c <name>    Solr collection to check

Options:
  --query, -q <query>        Solr query (default: "*:*")
  --fq <filter>              Filter query
  --rows, -r <num>           Number of rows to fetch per shard (default: 10)
  --field, -f <field>        Field to compare across replicas (shows value differences)
  --config <path>            Path to p3api.conf (default: ./p3api.conf)
  --timeout, -t <ms>         Request timeout in milliseconds (default: 30000)
  --verbose, -v              Verbose output
  --all-replicas, -a         Query ALL replicas (not just one per shard)
  --count-only               Only compare document counts, skip document comparison
  --help, -h                 Show this help

Examples:
  # Check document counts across all shards for a genome
  node scripts/check-shard-consistency.js -c genome_feature -q "genome_id:123.456" --count-only

  # Check all replicas for count consistency
  node scripts/check-shard-consistency.js -c genome_feature -q "genome_id:123.456" --all-replicas --count-only

  # Compare actual documents (first 100 per shard)
  node scripts/check-shard-consistency.js -c genome_feature -q "genome_id:123.456" -r 100

  # Check a specific field for inconsistencies
  node scripts/check-shard-consistency.js -c genome -q "*:*" -r 0 --count-only
`)
}

// Load configuration
function loadConfig(configPath) {
  const searchPaths = configPath
    ? [configPath]
    : [
        path.join(process.cwd(), 'p3api.conf'),
        path.join(__dirname, '..', 'p3api.conf'),
        '/etc/p3api.conf'
      ]

  for (const p of searchPaths) {
    if (fs.existsSync(p)) {
      console.log(`Loading config from: ${p}`)
      const content = fs.readFileSync(p, 'utf8')
      return JSON.parse(content)
    }
  }

  throw new Error(`Config file not found. Searched: ${searchPaths.join(', ')}`)
}

// HTTP request helper
function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url)
    const httpModule = parsedUrl.protocol === 'https:' ? https : http

    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: {
        'Accept': 'application/json'
      },
      timeout: options.timeout || 30000,
      // Allow self-signed certs for internal clusters
      rejectUnauthorized: options.rejectUnauthorized !== undefined
        ? options.rejectUnauthorized
        : true
    }

    // Handle basic auth - must decode URI components since URL encodes them
    if (parsedUrl.username && parsedUrl.password) {
      const username = decodeURIComponent(parsedUrl.username)
      const password = decodeURIComponent(parsedUrl.password)
      reqOptions.auth = `${username}:${password}`
      if (options.verbose) {
        console.log(`  Auth: ${username}:***`)
      }
    }

    if (options.verbose) {
      console.log(`  Request: ${parsedUrl.protocol}//${parsedUrl.host}${parsedUrl.pathname}${parsedUrl.search}`)
    }

    const req = httpModule.request(reqOptions, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
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

// Get cluster status
async function getClusterStatus(solrBaseUrl, options) {
  const url = `${solrBaseUrl}/admin/collections?action=CLUSTERSTATUS`
  const response = await httpRequest(url, options)
  return response.cluster
}

// Get all shards and replicas for a collection
function getShardsAndReplicas(clusterStatus, collection, allReplicas = false) {
  const collectionInfo = clusterStatus.collections[collection]
  if (!collectionInfo) {
    throw new Error(`Collection not found: ${collection}`)
  }

  const result = []
  const shards = collectionInfo.shards || {}

  for (const [shardName, shardData] of Object.entries(shards)) {
    const replicas = shardData.replicas || {}

    for (const [replicaName, replicaData] of Object.entries(replicas)) {
      const replicaInfo = {
        shard: shardName,
        replica: replicaName,
        core: replicaData.core,
        baseUrl: replicaData.base_url,
        state: replicaData.state,
        leader: replicaData.leader === 'true',
        nodeName: replicaData.node_name
      }

      if (allReplicas) {
        result.push(replicaInfo)
      } else {
        // Only include one replica per shard (prefer leader)
        const existingForShard = result.find(r => r.shard === shardName)
        if (!existingForShard) {
          result.push(replicaInfo)
        } else if (replicaData.leader === 'true' && !existingForShard.leader) {
          // Replace with leader
          const idx = result.indexOf(existingForShard)
          result[idx] = replicaInfo
        }
      }
    }
  }

  return result
}

// Query a specific replica
async function queryReplica(replica, query, fq, rows, auth, options) {
  // Build the query URL - replica.baseUrl is like "http://host:port/solr"
  const baseUrl = replica.baseUrl.replace(/\/$/, '')
  let url = `${baseUrl}/${replica.core}/select`

  const params = new URLSearchParams()
  params.set('q', query)
  params.set('rows', rows.toString())
  params.set('wt', 'json')
  params.set('sort', 'id asc')  // Consistent ordering

  if (fq) {
    params.set('fq', fq)
  }

  // Inject auth into URL if present
  if (auth) {
    const parsedUrl = new URL(url)
    parsedUrl.username = encodeURIComponent(auth.username)
    parsedUrl.password = encodeURIComponent(auth.password)
    url = parsedUrl.toString().replace(/\/$/, '')
  }

  url = `${url}?${params.toString()}`

  if (options.verbose) {
    console.log(`\nQuerying replica: ${replica.shard}/${replica.replica}`)
    console.log(`  URL: ${url.replace(/\/\/[^:]+:[^@]+@/, '//***:***@')}`)
  }

  const startTime = Date.now()
  try {
    const response = await httpRequest(url, options)
    const elapsed = Date.now() - startTime

    return {
      success: true,
      numFound: response.response?.numFound || 0,
      docs: response.response?.docs || [],
      qtime: response.responseHeader?.QTime || 0,
      elapsed,
      replica
    }
  } catch (err) {
    return {
      success: false,
      error: err.message,
      elapsed: Date.now() - startTime,
      replica
    }
  }
}

// Compare results across shards/replicas
function analyzeResults(results, args) {
  const summary = {
    totalShards: new Set(results.map(r => r.replica.shard)).size,
    totalReplicas: results.length,
    successfulQueries: results.filter(r => r.success).length,
    failedQueries: results.filter(r => !r.success).length,
    totalDocuments: 0,
    inconsistencies: [],
    shardBreakdown: {},
    replicaDetails: []
  }

  // Group by shard
  const byShards = {}
  for (const result of results) {
    const shard = result.replica.shard
    if (!byShards[shard]) {
      byShards[shard] = []
    }
    byShards[shard].push(result)
  }

  // Analyze each shard
  for (const [shardName, shardResults] of Object.entries(byShards)) {
    const successfulResults = shardResults.filter(r => r.success)
    const failedResults = shardResults.filter(r => !r.success)

    const shardInfo = {
      name: shardName,
      replicas: shardResults.length,
      successful: successfulResults.length,
      failed: failedResults.length,
      counts: successfulResults.map(r => r.numFound),
      consistent: true
    }

    // Check count consistency within shard
    if (successfulResults.length > 1) {
      const counts = new Set(successfulResults.map(r => r.numFound))
      if (counts.size > 1) {
        shardInfo.consistent = false
        summary.inconsistencies.push({
          type: 'COUNT_MISMATCH',
          shard: shardName,
          message: `Replica count mismatch in shard ${shardName}: ${[...counts].join(' vs ')}`
        })
      }
    }

    // Add to total (use first successful result's count)
    if (successfulResults.length > 0) {
      summary.totalDocuments += successfulResults[0].numFound
    }

    // Check document-level consistency if we have docs and multiple replicas
    if (!args.countOnly && successfulResults.length > 1 && successfulResults[0].docs.length > 0) {
      const docSets = successfulResults.map(r => {
        return new Set(r.docs.map(d => d.id || JSON.stringify(d)))
      })

      // Find documents that aren't in all replicas
      const allDocs = new Set()
      docSets.forEach(s => s.forEach(d => allDocs.add(d)))

      for (const docId of allDocs) {
        const presentIn = docSets.filter(s => s.has(docId)).length
        if (presentIn < docSets.length) {
          shardInfo.consistent = false
          summary.inconsistencies.push({
            type: 'DOCUMENT_MISSING',
            shard: shardName,
            documentId: docId,
            message: `Document ${docId} present in ${presentIn}/${docSets.length} replicas`
          })
        }
      }
    }

    summary.shardBreakdown[shardName] = shardInfo

    // Add replica details
    for (const result of shardResults) {
      summary.replicaDetails.push({
        shard: shardName,
        replica: result.replica.replica,
        node: result.replica.nodeName,
        leader: result.replica.leader,
        state: result.replica.state,
        success: result.success,
        numFound: result.success ? result.numFound : null,
        qtime: result.success ? result.qtime : null,
        elapsed: result.elapsed,
        error: result.success ? null : result.error
      })
    }
  }

  return summary
}

// Format output
function printReport(summary, args) {
  console.log('\n' + '='.repeat(80))
  console.log('SHARD CONSISTENCY REPORT')
  console.log('='.repeat(80))

  console.log(`\nCollection: ${args.collection}`)
  console.log(`Query: ${args.query}`)
  if (args.fq) console.log(`Filter Query: ${args.fq}`)
  console.log(`Mode: ${args.allReplicas ? 'All Replicas' : 'One per Shard'}`)
  console.log(`Rows per shard: ${args.rows}`)

  console.log('\n' + '-'.repeat(40))
  console.log('OVERVIEW')
  console.log('-'.repeat(40))
  console.log(`Total Shards: ${summary.totalShards}`)
  console.log(`Total Replicas Queried: ${summary.totalReplicas}`)
  console.log(`Successful Queries: ${summary.successfulQueries}`)
  console.log(`Failed Queries: ${summary.failedQueries}`)
  console.log(`Total Documents (sum across shards): ${summary.totalDocuments}`)

  console.log('\n' + '-'.repeat(40))
  console.log('SHARD BREAKDOWN')
  console.log('-'.repeat(40))

  const shardTable = []
  for (const [shardName, info] of Object.entries(summary.shardBreakdown).sort()) {
    shardTable.push({
      Shard: shardName,
      Replicas: `${info.successful}/${info.replicas}`,
      Counts: info.counts.join(', ') || 'N/A',
      Consistent: info.consistent ? '✓' : '✗ INCONSISTENT'
    })
  }
  console.table(shardTable)

  if (args.verbose || summary.failedQueries > 0 || summary.inconsistencies.length > 0) {
    console.log('\n' + '-'.repeat(40))
    console.log('REPLICA DETAILS')
    console.log('-'.repeat(40))

    const replicaTable = summary.replicaDetails.map(r => ({
      Shard: r.shard,
      Replica: r.replica.substring(0, 20),
      Node: r.node?.split(':')[0] || 'N/A',
      Leader: r.leader ? '✓' : '',
      State: r.state,
      Count: r.numFound !== null ? r.numFound : 'ERR',
      QTime: r.qtime !== null ? `${r.qtime}ms` : '-',
      Elapsed: `${r.elapsed}ms`,
      Error: r.error ? r.error.substring(0, 30) : ''
    }))
    console.table(replicaTable)
  }

  if (summary.inconsistencies.length > 0) {
    console.log('\n' + '!'.repeat(80))
    console.log('INCONSISTENCIES DETECTED')
    console.log('!'.repeat(80))

    for (const issue of summary.inconsistencies) {
      console.log(`\n[${issue.type}] ${issue.message}`)
      if (issue.documentId) {
        console.log(`  Document ID: ${issue.documentId}`)
      }
    }
  } else {
    console.log('\n' + '✓'.repeat(40))
    console.log('No inconsistencies detected')
    console.log('✓'.repeat(40))
  }

  console.log('\n')
}

// Main function
async function main() {
  const args = parseArgs()

  try {
    // Load config
    const config = loadConfig(args.config)
    const solrBaseUrl = config.solr?.url || config.solrUrl

    if (!solrBaseUrl) {
      throw new Error('Solr URL not found in config')
    }

    console.log(`\nConnecting to Solr: ${solrBaseUrl.replace(/\/\/[^:]+:[^@]+@/, '//***:***@')}`)

    // Extract auth from URL - need to decode since URL object encodes them
    const parsedSolrUrl = new URL(solrBaseUrl)
    const auth = parsedSolrUrl.username && parsedSolrUrl.password
      ? {
          username: decodeURIComponent(parsedSolrUrl.username),
          password: decodeURIComponent(parsedSolrUrl.password)
        }
      : null

    if (args.verbose) {
      console.log(`Auth present: ${auth ? 'yes' : 'no'}`)
      if (auth) {
        console.log(`Auth username: ${auth.username}`)
      }
    }

    // Determine SSL options
    const requestOptions = {
      timeout: args.timeout,
      rejectUnauthorized: config.distributedQuery?.rejectUnauthorized !== false,
      verbose: args.verbose
    }

    // Get cluster status
    console.log('Fetching cluster status...')
    const clusterStatus = await getClusterStatus(solrBaseUrl, requestOptions)

    // Get shards and replicas
    const replicas = getShardsAndReplicas(clusterStatus, args.collection, args.allReplicas)
    console.log(`Found ${replicas.length} ${args.allReplicas ? 'replicas' : 'shards'} to query`)

    if (replicas.length === 0) {
      console.error('No replicas found to query')
      process.exit(1)
    }

    // Query all replicas in parallel
    console.log('Querying replicas...\n')
    const results = await Promise.all(
      replicas.map(replica =>
        queryReplica(replica, args.query, args.fq, args.rows, auth, requestOptions)
      )
    )

    // Analyze results
    const summary = analyzeResults(results, args)

    // Print report
    printReport(summary, args)

    // Exit with error code if inconsistencies found
    if (summary.inconsistencies.length > 0 || summary.failedQueries > 0) {
      process.exit(1)
    }

  } catch (err) {
    console.error(`\nError: ${err.message}`)
    if (args.verbose) {
      console.error(err.stack)
    }
    process.exit(1)
  }
}

main()
