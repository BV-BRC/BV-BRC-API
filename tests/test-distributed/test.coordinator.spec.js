/**
 * Unit tests for ParallelQueryCoordinator
 *
 * Regression coverage for the backpressure-completion bug: when the last shard
 * completes while the consumer is applying backpressure, EOF (push(null)) must
 * NOT be emitted until the internal document buffer is fully drained. Emitting
 * EOF early dropped trailing docs and, on the next resume, crashed with
 * ERR_STREAM_PUSH_AFTER_EOF — which surfaced as a distributed download
 * truncating to a bare "[".
 */

const assert = require('chai').assert
const { Readable } = require('stream')

// Number of docs each mock shard emits (set per-test).
let MOCK_DOC_COUNT = 0

// Mock ShardCursorStream: pushes all its docs (then EOF) synchronously in the
// first _read, so that by the time the coordinator drains, every shard has
// already ended and its whole result set is sitting in the coordinator's buffer.
class MockShardStream extends Readable {
  constructor (options) {
    super({ objectMode: true })
    this.shard = options.shard
    this._emitted = false
  }

  _read () {
    if (this._emitted) return
    this._emitted = true
    for (let i = 0; i < MOCK_DOC_COUNT; i++) {
      this.push({ id: `${this.shard}-${i}`, n: i })
    }
    this.push(null)
  }

  getStats () { return { shard: this.shard } }
}

// Inject the mock in place of the real ShardCursorStream, then (re)load the
// coordinator so it binds to the mock. Restore afterward to avoid polluting
// other test files that share this process.
const scsPath = require.resolve('../../lib/distributed/ShardCursorStream')
const pqcPath = require.resolve('../../lib/distributed/ParallelQueryCoordinator')
const realScsEntry = require.cache[scsPath]

let ParallelQueryCoordinator

// A consumer that applies backpressure after every document (pause, resume next
// tick). This forces this.push() to return false mid-drain.
function collectWithBackpressure (stream) {
  return new Promise((resolve, reject) => {
    const docs = []
    stream.on('data', (doc) => {
      docs.push(doc)
      stream.pause()
      setImmediate(() => stream.resume())
    })
    stream.on('end', () => resolve(docs))
    stream.on('error', reject)
  })
}

describe('ParallelQueryCoordinator', function () {
  before(function () {
    require.cache[scsPath] = {
      id: scsPath, filename: scsPath, loaded: true, exports: MockShardStream
    }
    delete require.cache[pqcPath]
    ParallelQueryCoordinator = require('../../lib/distributed/ParallelQueryCoordinator')
  })

  after(function () {
    if (realScsEntry) {
      require.cache[scsPath] = realScsEntry
    } else {
      delete require.cache[scsPath]
    }
    delete require.cache[pqcPath]
  })

  it('emits every doc when shards complete during backpressure (single shard)', async function () {
    MOCK_DOC_COUNT = 300
    const coordinator = new ParallelQueryCoordinator({
      shardConfigs: [{ shard: 'shard1', solrUrl: 'http://mock/solr/c' }],
      query: '&fq=x:1'
    })

    const docs = await collectWithBackpressure(coordinator)
    assert.equal(docs.length, 300, 'all buffered docs must be delivered, none dropped at EOF')
  })

  it('emits every doc across multiple shards under backpressure', async function () {
    MOCK_DOC_COUNT = 100
    const coordinator = new ParallelQueryCoordinator({
      shardConfigs: [
        { shard: 'shard1', solrUrl: 'http://mock/solr/c' },
        { shard: 'shard2', solrUrl: 'http://mock/solr/c' },
        { shard: 'shard3', solrUrl: 'http://mock/solr/c' }
      ],
      query: '&fq=x:1'
    })

    const docs = await collectWithBackpressure(coordinator)
    assert.equal(docs.length, 300, '3 shards x 100 docs must all arrive')
  })

  it('delivers all docs to a fast (non-backpressuring) consumer', async function () {
    MOCK_DOC_COUNT = 50
    const coordinator = new ParallelQueryCoordinator({
      shardConfigs: [{ shard: 'shard1', solrUrl: 'http://mock/solr/c' }],
      query: '&fq=x:1'
    })

    const docs = await new Promise((resolve, reject) => {
      const out = []
      coordinator.on('data', (d) => out.push(d))
      coordinator.on('end', () => resolve(out))
      coordinator.on('error', reject)
    })
    assert.equal(docs.length, 50)
  })
})
