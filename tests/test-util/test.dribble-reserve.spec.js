/**
 * The dribble reserve in util/streamWithBackpressure.
 *
 * Cloudflare cuts a response that goes quiet for more than ~120-150s, even after it has
 * started, and returns HTTP 200 with a truncated body rather than an error. A sparse
 * batched join legitimately produces nothing for minutes, so long downloads die looking
 * successful.
 *
 * Rather than invent filler -- which cannot be made legal for every serializer, binary
 * xlsx least of all -- the reserve holds back the tail of what has already been produced
 * and spends it one byte at a time while the producer is quiet. One byte is enough:
 * measured against alpha, a single space every 100s kept a 300-second response alive.
 *
 * THE PROPERTY THAT MATTERS, and the reason this is safe at all: the bytes on the wire
 * are IDENTICAL with and without the reserve. Only their timing differs. Every test below
 * exists to defend that.
 */

const assert = require('chai').assert
const { Readable } = require('stream')
const { streamWithBackpressure } = require('../../util/streamWithBackpressure')

/** Minimal res double that records exactly what was written, in order. */
function fakeRes () {
  const chunks = []
  return {
    chunks,
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    set () {},
    write (c) { chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); return true },
    end () { this.writableEnded = true; if (this._onEnd) this._onEnd() },
    on (ev, fn) { if (ev === 'close') this._onClose = fn },
    removeListener () {},
    get body () { return Buffer.concat(chunks).toString() }
  }
}

const docsStream = (docs) => Readable.from(docs, { objectMode: true })

describe('dribble reserve', function () {
  const DOCS = [{ meta: true }, { a: 1 }, { b: 2 }, { c: 3 }]
  const transform = (d) => JSON.stringify(d) + '\n'

  it('produces byte-identical output with and without the reserve', async function () {
    // THE load-bearing test. If this ever fails, the reserve is corrupting downloads.
    const plain = fakeRes()
    await streamWithBackpressure(docsStream(DOCS), plain, { transform })

    const dribbled = fakeRes()
    await streamWithBackpressure(docsStream(DOCS), dribbled, {
      transform, dribbleMs: 60000, reserveBytes: 16
    })

    assert.equal(dribbled.body, plain.body)
  })

  it('holds bytes back mid-stream, then releases them all', async function () {
    const res = fakeRes()
    await streamWithBackpressure(docsStream(DOCS), res, {
      transform, dribbleMs: 60000, reserveBytes: 8
    })
    // Everything arrives by the end...
    assert.equal(res.body, '{"a":1}\n{"b":2}\n{"c":3}\n')
    // ...but not in one write: the reserve forced a split.
    assert.isAbove(res.chunks.length, 1)
  })

  it('emits ONE byte per tick while the producer is silent', function (done) {
    // A producer that stalls after the first doc, exactly the sparse-walk shape.
    const res = fakeRes()
    let push
    const stalling = new Readable({
      objectMode: true,
      read () { if (!push) { push = true; this.push({ meta: 1 }); this.push({ a: 1 }) } }
    })

    streamWithBackpressure(stalling, res, {
      transform, dribbleMs: 20, reserveBytes: 8
    }).catch(() => {})

    setTimeout(() => {
      const before = Buffer.concat(res.chunks).length
      setTimeout(() => {
        const after = Buffer.concat(res.chunks).length
        assert.isAbove(after, before, 'the reserve must keep trickling during silence')
        // One byte at a time, not a flood.
        assert.isAtMost(after - before, 4)
        stalling.destroy()
        done()
      }, 70)
    }, 40)
  })

  it('is inert when dribbleMs is 0 (the default)', async function () {
    const res = fakeRes()
    await streamWithBackpressure(docsStream(DOCS), res, { transform })
    // One write per doc, nothing held back.
    assert.equal(res.chunks.length, 3)
    assert.equal(res.body, '{"a":1}\n{"b":2}\n{"c":3}\n')
  })

  it('flushes the reserve BEFORE onEnd writes its trailer', async function () {
    // media/json.js appends ']' in onEnd. If the reserve flushed after that, the closing
    // bracket would land mid-array and the JSON would be invalid.
    const res = fakeRes()
    await streamWithBackpressure(docsStream(DOCS), res, {
      transform,
      dribbleMs: 60000,
      reserveBytes: 32,
      onEnd: () => { res.write(']') }
    })
    assert.equal(res.body, '{"a":1}\n{"b":2}\n{"c":3}\n]')
  })

  it('survives a reserve larger than the whole response', async function () {
    const res = fakeRes()
    await streamWithBackpressure(docsStream([{ meta: 1 }, { a: 1 }]), res, {
      transform, dribbleMs: 60000, reserveBytes: 100000
    })
    assert.equal(res.body, '{"a":1}\n')
  })

  it('handles a header row through the reserve too', async function () {
    const res = fakeRes()
    await streamWithBackpressure(docsStream(DOCS), res, {
      transform,
      onHeader: () => 'H\n',
      dribbleMs: 60000,
      reserveBytes: 8
    })
    assert.equal(res.body, 'H\n{"a":1}\n{"b":2}\n{"c":3}\n')
  })

  it('stops ticking once the stream ends', function (done) {
    const res = fakeRes()
    streamWithBackpressure(docsStream(DOCS), res, {
      transform, dribbleMs: 15, reserveBytes: 8
    }).then(() => {
      const atEnd = Buffer.concat(res.chunks).length
      setTimeout(() => {
        assert.equal(Buffer.concat(res.chunks).length, atEnd,
          'a leaked interval would keep writing after res.end()')
        done()
      }, 60)
    }).catch(done)
  })
})
