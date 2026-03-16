/**
 * Unit tests for SequenceJoinStream
 */

const assert = require('chai').assert
const { Readable, PassThrough } = require('stream')
const SequenceJoinStream = require('../../lib/distributed/SequenceJoinStream')
const { createSequenceJoinStream } = require('../../lib/distributed/SequenceJoinStream')

describe('SequenceJoinStream', function () {
  // Mock DirectSolrClient
  function createMockSolrClient (sequenceDict = {}) {
    return {
      fetchSequencesByMd5: async (hashes) => {
        const result = {}
        for (const hash of hashes) {
          if (sequenceDict[hash]) {
            result[hash] = sequenceDict[hash]
          }
        }
        return result
      }
    }
  }

  // Create a readable stream from an array of objects
  function createObjectStream (objects) {
    let index = 0
    return new Readable({
      objectMode: true,
      read () {
        if (index < objects.length) {
          this.push(objects[index++])
        } else {
          this.push(null)
        }
      }
    })
  }

  // Collect all output from a stream
  async function collectStream (stream) {
    const results = []
    return new Promise((resolve, reject) => {
      stream.on('data', (doc) => results.push(doc))
      stream.on('end', () => resolve(results))
      stream.on('error', reject)
    })
  }

  describe('basic functionality', function () {
    it('should require DirectSolrClient', function () {
      assert.throws(() => new SequenceJoinStream(), /DirectSolrClient is required/)
    })

    it('should enrich documents with sequences', async function () {
      const sequences = {
        md5_1: 'ATCGATCG',
        md5_2: 'GCTAGCTA',
        md5_3: 'TTTTAAAA'
      }

      const mockClient = createMockSolrClient(sequences)
      const joinStream = new SequenceJoinStream(mockClient, {
        sequenceField: 'na_sequence_md5',
        batchSize: 10,
        skipHeader: false
      })

      const input = [
        { id: 1, na_sequence_md5: 'md5_1' },
        { id: 2, na_sequence_md5: 'md5_2' },
        { id: 3, na_sequence_md5: 'md5_3' }
      ]

      const sourceStream = createObjectStream(input)
      sourceStream.pipe(joinStream)

      const results = await collectStream(joinStream)

      assert.equal(results.length, 3)
      assert.equal(results[0].sequence, 'ATCGATCG')
      assert.equal(results[1].sequence, 'GCTAGCTA')
      assert.equal(results[2].sequence, 'TTTTAAAA')
    })

    it('should skip first document by default', async function () {
      const mockClient = createMockSolrClient({ md5_1: 'SEQ1' })
      const joinStream = new SequenceJoinStream(mockClient, {
        batchSize: 10
        // skipHeader: true is the default
      })

      const input = [
        { type: 'header', metadata: true },
        { id: 1, na_sequence_md5: 'md5_1' }
      ]

      const sourceStream = createObjectStream(input)
      sourceStream.pipe(joinStream)

      const results = await collectStream(joinStream)

      // First doc (header) should be skipped
      assert.equal(results.length, 1)
      assert.equal(results[0].id, 1)
      assert.equal(results[0].sequence, 'SEQ1')
      // Verify header wasn't included
      assert.notProperty(results[0], 'type')
    })

    it('should handle missing sequences gracefully', async function () {
      const sequences = {
        md5_1: 'SEQ1'
        // md5_2 is missing
      }

      const mockClient = createMockSolrClient(sequences)
      const joinStream = new SequenceJoinStream(mockClient, {
        batchSize: 10,
        skipHeader: false
      })

      const input = [
        { id: 1, na_sequence_md5: 'md5_1' },
        { id: 2, na_sequence_md5: 'md5_2' },
        { id: 3 } // no sequence hash
      ]

      const sourceStream = createObjectStream(input)
      sourceStream.pipe(joinStream)

      const results = await collectStream(joinStream)

      assert.equal(results.length, 3)
      assert.equal(results[0].sequence, 'SEQ1')
      assert.isUndefined(results[1].sequence)
      assert.isUndefined(results[2].sequence)

      const stats = joinStream.getStats()
      assert.equal(stats.totalSequences, 1)
      assert.equal(stats.missingSequences, 1)
    })
  })

  describe('batching', function () {
    it('should batch sequence lookups', async function () {
      let fetchCallCount = 0
      const sequences = {}
      for (let i = 1; i <= 50; i++) {
        sequences[`md5_${i}`] = `SEQ_${i}`
      }

      const mockClient = {
        fetchSequencesByMd5: async (hashes) => {
          fetchCallCount++
          const result = {}
          for (const hash of hashes) {
            if (sequences[hash]) {
              result[hash] = sequences[hash]
            }
          }
          return result
        }
      }

      const joinStream = new SequenceJoinStream(mockClient, {
        batchSize: 10,
        prefetchBatches: 1,
        skipHeader: false
      })

      const input = []
      for (let i = 1; i <= 50; i++) {
        input.push({ id: i, na_sequence_md5: `md5_${i}` })
      }

      const sourceStream = createObjectStream(input)
      sourceStream.pipe(joinStream)

      const results = await collectStream(joinStream)

      assert.equal(results.length, 50)
      // Should batch: 50 docs / 10 per batch = 5 fetches
      assert.equal(fetchCallCount, 5)
    })

    it('should deduplicate hashes within a batch', async function () {
      let lastHashes = []
      const mockClient = {
        fetchSequencesByMd5: async (hashes) => {
          lastHashes = hashes
          return { md5_1: 'SEQ1' }
        }
      }

      const joinStream = new SequenceJoinStream(mockClient, {
        batchSize: 10,
        skipHeader: false
      })

      // Multiple docs with same hash
      const input = [
        { id: 1, na_sequence_md5: 'md5_1' },
        { id: 2, na_sequence_md5: 'md5_1' },
        { id: 3, na_sequence_md5: 'md5_1' }
      ]

      const sourceStream = createObjectStream(input)
      sourceStream.pipe(joinStream)

      await collectStream(joinStream)

      // Should only have one hash in the fetch call
      assert.deepEqual(lastHashes, ['md5_1'])
    })
  })

  describe('configuration', function () {
    it('should use custom output field name', async function () {
      const mockClient = createMockSolrClient({ md5_1: 'SEQ1' })
      const joinStream = new SequenceJoinStream(mockClient, {
        outputField: 'dna_sequence',
        skipHeader: false
      })

      const input = [{ id: 1, na_sequence_md5: 'md5_1' }]
      const sourceStream = createObjectStream(input)
      sourceStream.pipe(joinStream)

      const results = await collectStream(joinStream)

      assert.equal(results[0].dna_sequence, 'SEQ1')
      assert.isUndefined(results[0].sequence)
    })

    it('should use aa_sequence_md5 for protein sequences', async function () {
      const mockClient = createMockSolrClient({ aa_md5: 'MKVLF' })
      const joinStream = new SequenceJoinStream(mockClient, {
        sequenceField: 'aa_sequence_md5',
        skipHeader: false
      })

      const input = [{ id: 1, aa_sequence_md5: 'aa_md5' }]
      const sourceStream = createObjectStream(input)
      sourceStream.pipe(joinStream)

      const results = await collectStream(joinStream)

      assert.equal(results[0].sequence, 'MKVLF')
    })
  })

  describe('factory function', function () {
    it('should create DNA sequence join stream', function () {
      const mockClient = createMockSolrClient({})
      const joinStream = createSequenceJoinStream(mockClient, 'dna')

      assert.instanceOf(joinStream, SequenceJoinStream)
    })

    it('should create protein sequence join stream', function () {
      const mockClient = createMockSolrClient({})
      const joinStream = createSequenceJoinStream(mockClient, 'protein')

      assert.instanceOf(joinStream, SequenceJoinStream)
    })

    it('should throw for unknown sequence type', function () {
      const mockClient = createMockSolrClient({})
      assert.throws(() => createSequenceJoinStream(mockClient, 'unknown'), /Unknown sequence type/)
    })
  })

  describe('statistics', function () {
    it('should track statistics', async function () {
      const sequences = { md5_1: 'SEQ1', md5_2: 'SEQ2' }
      const mockClient = createMockSolrClient(sequences)
      const joinStream = new SequenceJoinStream(mockClient, {
        batchSize: 10,
        skipHeader: false
      })

      const input = [
        { id: 1, na_sequence_md5: 'md5_1' },
        { id: 2, na_sequence_md5: 'md5_2' },
        { id: 3, na_sequence_md5: 'md5_missing' },
        { id: 4 } // no hash
      ]

      const sourceStream = createObjectStream(input)
      sourceStream.pipe(joinStream)

      await collectStream(joinStream)

      const stats = joinStream.getStats()
      assert.equal(stats.totalDocs, 4)
      assert.equal(stats.totalSequences, 2)
      assert.equal(stats.missingSequences, 1)
    })
  })

  describe('error handling', function () {
    it('should handle fetch errors gracefully', async function () {
      const mockClient = {
        fetchSequencesByMd5: async () => {
          throw new Error('Fetch failed')
        }
      }

      const joinStream = new SequenceJoinStream(mockClient, {
        batchSize: 10,
        skipHeader: false
      })

      const input = [{ id: 1, na_sequence_md5: 'md5_1' }]
      const sourceStream = createObjectStream(input)
      sourceStream.pipe(joinStream)

      // Should still output docs, just without sequences
      const results = await collectStream(joinStream)

      assert.equal(results.length, 1)
      assert.isUndefined(results[0].sequence)
    })
  })

  describe('destroy', function () {
    it('should clean up on destroy', function () {
      const mockClient = createMockSolrClient({})
      const joinStream = new SequenceJoinStream(mockClient)

      joinStream.destroy()

      const stats = joinStream.getStats()
      assert.equal(stats.bufferSize, 0)
      assert.equal(stats.queuedBatches, 0)
    })
  })
})
