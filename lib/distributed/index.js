/**
 * Distributed Query Module
 *
 * Provides parallel data downloads from Solr by querying shards directly.
 *
 * Usage:
 *   const { SolrClusterClient, getConfig, updateConfig } = require('./lib/distributed')
 *
 *   const client = new SolrClusterClient('http://localhost:8983/solr')
 *   const shards = await client.getShardsForCollection('genome_feature')
 */

const SolrClusterClient = require('./SolrClusterClient')
const CacheManager = require('./CacheManager')
const ShardCursorStream = require('./ShardCursorStream')
const ParallelQueryCoordinator = require('./ParallelQueryCoordinator')
const MergeSortStream = require('./MergeSortStream')
const MinHeap = require('./MinHeap')
const DistributedQueryManager = require('./DistributedQueryManager')
const {
  getConfig,
  getDefaults,
  updateConfig,
  resetConfig,
  isAdminUser,
  getAdminUsers
} = require('./DistributedQueryConfig')

module.exports = {
  // Main entry point
  DistributedQueryManager,

  // Cluster client
  SolrClusterClient,

  // Streaming components
  ShardCursorStream,
  ParallelQueryCoordinator,
  MergeSortStream,

  // Utilities
  MinHeap,
  CacheManager,

  // Configuration
  getConfig,
  getDefaults,
  updateConfig,
  resetConfig,
  isAdminUser,
  getAdminUsers
}
