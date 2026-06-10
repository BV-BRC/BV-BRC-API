/**
 * Unit tests for streamWithBackpressure utility
 */

const assert = require('chai').assert
const { Readable, PassThrough } = require('stream')
const { streamWithBackpressure } = require('../../util/streamWithBackpressure')

describe('streamWithBackpressure', function () {
  // Create a mock response object
  function createMockResponse () {
    const res = new PassThrough()
    res.writableEnded = false
    const originalEnd = res.end.bind(res)
    res.end = function (...args) {
      res.writableEnded = true
      return originalEnd(...args)
    }
    return res
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

  describe('basic streaming', function () {
    it('should stream all documents with transform', async function () {
      const docs = [
        {}, // header doc to skip
        { id: 1, name: 'first' },
        { id: 2, name: 'second' },
        { id: 3, name: 'third' }
      ]

      const stream = createObjectStream(docs)
      const res = createMockResponse()
      const chunks = []

      res.on('data', (chunk) => chunks.push(chunk.toString()))

      const count = await streamWithBackpressure(stream, res, {
        transform: (doc) => JSON.stringify(doc) + '\n'
      })

      assert.equal(count, 3)
      const output = chunks.join('')
      assert.include(output, '{"id":1,"name":"first"}')
      assert.include(output, '{"id":2,"name":"second"}')
      assert.include(output, '{"id":3,"name":"third"}')
    })

    it('should skip first document by default', async function () {
      const docs = [
        { type: 'header', skip: true },
        { id: 1 },
        { id: 2 }
      ]

      const stream = createObjectStream(docs)
      const res = createMockResponse()
      const chunks = []
      let firstDocReceived = null

      res.on('data', (chunk) => chunks.push(chunk.toString()))

      await streamWithBackpressure(stream, res, {
        onFirstDoc: (doc) => { firstDocReceived = doc },
        transform: (doc) => JSON.stringify(doc) + '\n'
      })

      assert.deepEqual(firstDocReceived, { type: 'header', skip: true })
      const output = chunks.join('')
      assert.notInclude(output, 'header')
      assert.include(output, '{"id":1}')
      assert.include(output, '{"id":2}')
    })

    it('should not skip first doc when skipFirstDoc is false', async function () {
      const docs = [
        { id: 1 },
        { id: 2 }
      ]

      const stream = createObjectStream(docs)
      const res = createMockResponse()
      const chunks = []

      res.on('data', (chunk) => chunks.push(chunk.toString()))

      const count = await streamWithBackpressure(stream, res, {
        skipFirstDoc: false,
        transform: (doc) => JSON.stringify(doc) + '\n'
      })

      assert.equal(count, 2)
      const output = chunks.join('')
      assert.include(output, '{"id":1}')
      assert.include(output, '{"id":2}')
    })
  })

  describe('header handling', function () {
    it('should call onHeader with first real document', async function () {
      const docs = [
        {}, // header doc to skip
        { field1: 'a', field2: 'b' },
        { field1: 'c', field2: 'd' }
      ]

      const stream = createObjectStream(docs)
      const res = createMockResponse()
      const chunks = []
      let headerDoc = null

      res.on('data', (chunk) => chunks.push(chunk.toString()))

      await streamWithBackpressure(stream, res, {
        onHeader: (doc) => {
          headerDoc = doc
          return Object.keys(doc).join(',') + '\n'
        },
        transform: (doc) => Object.values(doc).join(',') + '\n'
      })

      assert.deepEqual(headerDoc, { field1: 'a', field2: 'b' })
      const output = chunks.join('')
      const lines = output.trim().split('\n')
      assert.equal(lines[0], 'field1,field2')
      assert.equal(lines[1], 'a,b')
      assert.equal(lines[2], 'c,d')
    })

    it('should only call onHeader once', async function () {
      const docs = [
        {},
        { id: 1 },
        { id: 2 },
        { id: 3 }
      ]

      const stream = createObjectStream(docs)
      const res = createMockResponse()
      let headerCallCount = 0

      await streamWithBackpressure(stream, res, {
        onHeader: () => {
          headerCallCount++
          return 'header\n'
        },
        transform: (doc) => `${doc.id}\n`
      })

      assert.equal(headerCallCount, 1)
    })
  })

  describe('onEnd callback', function () {
    it('should call onEnd with document count', async function () {
      const docs = [
        {},
        { id: 1 },
        { id: 2 },
        { id: 3 },
        { id: 4 }
      ]

      const stream = createObjectStream(docs)
      const res = createMockResponse()
      let endCount = null

      await streamWithBackpressure(stream, res, {
        transform: (doc) => `${doc.id}\n`,
        onEnd: (count) => { endCount = count }
      })

      assert.equal(endCount, 4)
    })

    it('should return document count from promise', async function () {
      const docs = [
        {},
        { id: 1 },
        { id: 2 }
      ]

      const stream = createObjectStream(docs)
      const res = createMockResponse()

      const count = await streamWithBackpressure(stream, res, {
        transform: (doc) => `${doc.id}\n`
      })

      assert.equal(count, 2)
    })
  })

  describe('transform function', function () {
    it('should receive document index as second parameter', async function () {
      const docs = [
        {},
        { val: 'a' },
        { val: 'b' },
        { val: 'c' }
      ]

      const stream = createObjectStream(docs)
      const res = createMockResponse()
      const indices = []

      await streamWithBackpressure(stream, res, {
        transform: (doc, index) => {
          indices.push(index)
          return `${index}:${doc.val}\n`
        }
      })

      assert.deepEqual(indices, [0, 1, 2])
    })

    it('should skip output when transform returns null', async function () {
      const docs = [
        {},
        { id: 1, skip: false },
        { id: 2, skip: true },
        { id: 3, skip: false }
      ]

      const stream = createObjectStream(docs)
      const res = createMockResponse()
      const chunks = []

      res.on('data', (chunk) => chunks.push(chunk.toString()))

      await streamWithBackpressure(stream, res, {
        transform: (doc) => doc.skip ? null : `${doc.id}\n`
      })

      const output = chunks.join('')
      assert.include(output, '1\n')
      assert.include(output, '3\n')
      assert.notInclude(output, '2\n')
    })
  })

  describe('error handling', function () {
    it('should reject on stream error', async function () {
      const stream = new Readable({
        objectMode: true,
        read () {
          this.destroy(new Error('Test error'))
        }
      })

      const res = createMockResponse()

      try {
        await streamWithBackpressure(stream, res, {
          transform: (doc) => JSON.stringify(doc)
        })
        assert.fail('Should have thrown')
      } catch (err) {
        assert.equal(err.message, 'Test error')
      }
    })
  })

  describe('empty streams', function () {
    it('should handle stream with only header doc', async function () {
      const docs = [{}] // Only header

      const stream = createObjectStream(docs)
      const res = createMockResponse()
      let onEndCalled = false

      const count = await streamWithBackpressure(stream, res, {
        transform: (doc) => JSON.stringify(doc) + '\n',
        onEnd: () => { onEndCalled = true }
      })

      assert.equal(count, 0)
      assert.isTrue(onEndCalled)
    })

    it('should handle completely empty stream', async function () {
      const stream = createObjectStream([])
      const res = createMockResponse()

      const count = await streamWithBackpressure(stream, res, {
        transform: (doc) => JSON.stringify(doc) + '\n'
      })

      assert.equal(count, 0)
    })
  })
})
