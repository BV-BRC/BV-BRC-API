/**
 * Unit tests for MinHeap
 */

const assert = require('chai').assert
const MinHeap = require('../../lib/distributed/MinHeap')

describe('MinHeap', function () {
  describe('Basic Operations', function () {
    it('should create an empty heap', function () {
      const heap = new MinHeap()
      assert.equal(heap.size(), 0)
      assert.isTrue(heap.isEmpty())
      assert.isUndefined(heap.peek())
    })

    it('should push and pop elements in order', function () {
      const heap = new MinHeap((a, b) => a - b)
      heap.push(5)
      heap.push(3)
      heap.push(7)
      heap.push(1)
      heap.push(9)

      assert.equal(heap.size(), 5)
      assert.equal(heap.pop(), 1)
      assert.equal(heap.pop(), 3)
      assert.equal(heap.pop(), 5)
      assert.equal(heap.pop(), 7)
      assert.equal(heap.pop(), 9)
      assert.isTrue(heap.isEmpty())
    })

    it('should peek without removing', function () {
      const heap = new MinHeap((a, b) => a - b)
      heap.push(5)
      heap.push(3)

      assert.equal(heap.peek(), 3)
      assert.equal(heap.size(), 2)
      assert.equal(heap.peek(), 3)
    })

    it('should handle single element', function () {
      const heap = new MinHeap((a, b) => a - b)
      heap.push(42)

      assert.equal(heap.size(), 1)
      assert.equal(heap.peek(), 42)
      assert.equal(heap.pop(), 42)
      assert.isTrue(heap.isEmpty())
    })

    it('should handle duplicate values', function () {
      const heap = new MinHeap((a, b) => a - b)
      heap.push(5)
      heap.push(5)
      heap.push(3)
      heap.push(3)

      assert.equal(heap.pop(), 3)
      assert.equal(heap.pop(), 3)
      assert.equal(heap.pop(), 5)
      assert.equal(heap.pop(), 5)
    })
  })

  describe('Default Comparator', function () {
    it('should use value property by default', function () {
      const heap = new MinHeap()
      heap.push({ value: 10, id: 'a' })
      heap.push({ value: 5, id: 'b' })
      heap.push({ value: 15, id: 'c' })

      assert.equal(heap.pop().id, 'b')
      assert.equal(heap.pop().id, 'a')
      assert.equal(heap.pop().id, 'c')
    })
  })

  describe('replace() Method', function () {
    it('should replace min and return it', function () {
      const heap = new MinHeap((a, b) => a - b)
      heap.push(3)
      heap.push(5)
      heap.push(7)

      const replaced = heap.replace(4)
      assert.equal(replaced, 3)
      assert.equal(heap.peek(), 4)
      assert.equal(heap.size(), 3)
    })

    it('should handle replace on empty heap', function () {
      const heap = new MinHeap((a, b) => a - b)
      const replaced = heap.replace(10)

      assert.isUndefined(replaced)
      assert.equal(heap.size(), 1)
      assert.equal(heap.peek(), 10)
    })
  })

  describe('pushPop() Method', function () {
    it('should return item if smaller than min', function () {
      const heap = new MinHeap((a, b) => a - b)
      heap.push(5)
      heap.push(7)

      const result = heap.pushPop(3)
      assert.equal(result, 3)
      assert.equal(heap.peek(), 5)
      assert.equal(heap.size(), 2)
    })

    it('should return min if item is larger', function () {
      const heap = new MinHeap((a, b) => a - b)
      heap.push(5)
      heap.push(7)

      const result = heap.pushPop(6)
      assert.equal(result, 5)
      assert.equal(heap.peek(), 6)
      assert.equal(heap.size(), 2)
    })

    it('should return item on empty heap', function () {
      const heap = new MinHeap((a, b) => a - b)
      const result = heap.pushPop(10)

      assert.equal(result, 10)
      assert.isTrue(heap.isEmpty())
    })
  })

  describe('clear() Method', function () {
    it('should clear all elements', function () {
      const heap = new MinHeap((a, b) => a - b)
      heap.push(1)
      heap.push(2)
      heap.push(3)

      heap.clear()
      assert.isTrue(heap.isEmpty())
      assert.equal(heap.size(), 0)
    })
  })

  describe('toArray() Method', function () {
    it('should return array copy', function () {
      const heap = new MinHeap((a, b) => a - b)
      heap.push(3)
      heap.push(1)
      heap.push(2)

      const arr = heap.toArray()
      assert.isArray(arr)
      assert.equal(arr.length, 3)
      // Array is heap structure, not sorted
      assert.include(arr, 1)
      assert.include(arr, 2)
      assert.include(arr, 3)

      // Original heap unchanged
      assert.equal(heap.size(), 3)
    })
  })

  describe('isValid() Method', function () {
    it('should validate correct heap', function () {
      const heap = new MinHeap((a, b) => a - b)
      heap.push(5)
      heap.push(3)
      heap.push(7)
      heap.push(1)
      heap.push(9)

      assert.isTrue(heap.isValid())
    })

    it('should validate empty heap', function () {
      const heap = new MinHeap()
      assert.isTrue(heap.isValid())
    })

    it('should validate single element heap', function () {
      const heap = new MinHeap((a, b) => a - b)
      heap.push(1)
      assert.isTrue(heap.isValid())
    })
  })

  describe('fieldComparator', function () {
    it('should sort ascending by field', function () {
      const comparator = MinHeap.fieldComparator('score', 'asc')
      const heap = new MinHeap(comparator)

      heap.push({ score: 10 })
      heap.push({ score: 5 })
      heap.push({ score: 15 })

      assert.equal(heap.pop().score, 5)
      assert.equal(heap.pop().score, 10)
      assert.equal(heap.pop().score, 15)
    })

    it('should sort descending by field', function () {
      const comparator = MinHeap.fieldComparator('score', 'desc')
      const heap = new MinHeap(comparator)

      heap.push({ score: 10 })
      heap.push({ score: 5 })
      heap.push({ score: 15 })

      assert.equal(heap.pop().score, 15)
      assert.equal(heap.pop().score, 10)
      assert.equal(heap.pop().score, 5)
    })

    it('should handle nested doc property', function () {
      const comparator = MinHeap.fieldComparator('id', 'asc')
      const heap = new MinHeap(comparator)

      heap.push({ doc: { id: 'c' } })
      heap.push({ doc: { id: 'a' } })
      heap.push({ doc: { id: 'b' } })

      assert.equal(heap.pop().doc.id, 'a')
      assert.equal(heap.pop().doc.id, 'b')
      assert.equal(heap.pop().doc.id, 'c')
    })

    it('should handle null values', function () {
      const comparator = MinHeap.fieldComparator('score', 'asc')
      const heap = new MinHeap(comparator)

      heap.push({ score: 10 })
      heap.push({ score: null })
      heap.push({ score: 5 })

      assert.equal(heap.pop().score, 5)
      assert.equal(heap.pop().score, 10)
      assert.isNull(heap.pop().score)
    })

    it('should handle string comparison', function () {
      const comparator = MinHeap.fieldComparator('name', 'asc')
      const heap = new MinHeap(comparator)

      heap.push({ name: 'charlie' })
      heap.push({ name: 'alice' })
      heap.push({ name: 'bob' })

      assert.equal(heap.pop().name, 'alice')
      assert.equal(heap.pop().name, 'bob')
      assert.equal(heap.pop().name, 'charlie')
    })

    // Regression: this used to be localeCompare (ICU collation), which orders
    // by base letter and so disagrees with Solr on case. Each shard arrives
    // sorted by Solr, so a comparator that disagrees makes MergeSortStream
    // interleave correctly-sorted inputs into a wrongly-ordered output. A live
    // sort(+feature_id)&limit(25000) returned 7 out-of-order positions.
    it('should order mixed-case strings by byte order, not ICU collation', function () {
      const comparator = MinHeap.fieldComparator('id', 'asc')
      const heap = new MinHeap(comparator)

      // 'R' (0x52) sorts before 'f' (0x66), so misc_RNA precedes misc_feature.
      // localeCompare returns the opposite.
      heap.push({ id: 'misc_feature' })
      heap.push({ id: 'misc_RNA' })

      assert.equal(heap.pop().id, 'misc_RNA')
      assert.equal(heap.pop().id, 'misc_feature')
    })

    it('should sort uppercase before lowercase, matching Solr', function () {
      const comparator = MinHeap.fieldComparator('id', 'asc')
      const heap = new MinHeap(comparator)

      for (const id of ['apple', 'Banana', 'Apple', 'banana']) heap.push({ id })

      assert.deepEqual(
        [heap.pop().id, heap.pop().id, heap.pop().id, heap.pop().id],
        ['Apple', 'Banana', 'apple', 'banana']
      )
    })

    it('should reverse byte order for descending sorts', function () {
      const comparator = MinHeap.fieldComparator('id', 'desc')
      const heap = new MinHeap(comparator)

      heap.push({ id: 'misc_RNA' })
      heap.push({ id: 'misc_feature' })

      assert.equal(heap.pop().id, 'misc_feature')
      assert.equal(heap.pop().id, 'misc_RNA')
    })
  })

  describe('compareUtf8', function () {
    // The comparator must agree with Lucene's unsigned-byte BytesRef ordering
    // for every input, so Buffer.compare over UTF-8 is the oracle.
    const cases = [
      ['misc_feature', 'misc_RNA'],
      ['a', 'B'],
      ['Z', 'a'],
      ['', 'a'],
      ['abc', 'abcd'],
      ['abc', 'abc'],
      ['café', 'cafz'],
      ['ä', 'z'], // ICU sorts a-umlaut with 'a'; UTF-8 puts it after 'z'
      ['PATRIC.100.11.X.misc_feature.1.2.rev', 'PATRIC.100.11.X.misc_RNA.1.2.rev'],
      ['\u{1F600}', ''], // supplementary vs BMP: the surrogate fallback
      ['�', '\u{1F600}']
    ]

    it('should agree with UTF-8 byte order on every case', function () {
      for (const [a, b] of cases) {
        const expected = Math.sign(Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')))
        assert.equal(
          Math.sign(MinHeap.compareUtf8(a, b)), expected,
          `compareUtf8(${JSON.stringify(a)}, ${JSON.stringify(b)})`
        )
      }
    })

    it('should be antisymmetric', function () {
      for (const [a, b] of cases) {
        assert.equal(
          Math.sign(MinHeap.compareUtf8(a, b)),
          -Math.sign(MinHeap.compareUtf8(b, a)),
          `${JSON.stringify(a)} vs ${JSON.stringify(b)}`
        )
      }
    })

    it('should sort a list identically to a UTF-8 byte sort', function () {
      const values = [
        'misc_feature', 'misc_RNA', 'CDS', 'cds', 'assembly_gap', 'tRNA',
        'Z', 'a', 'ä', '\u{1F600}', '', 'source', 'Source'
      ]
      const byComparator = values.slice().sort(MinHeap.compareUtf8)
      const byBytes = values.slice().sort((a, b) =>
        Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')))

      assert.deepEqual(byComparator, byBytes)
    })
  })

  describe('multiFieldComparator', function () {
    it('should sort by multiple fields', function () {
      const comparator = MinHeap.multiFieldComparator([
        { field: 'category', order: 'asc' },
        { field: 'score', order: 'desc' }
      ])
      const heap = new MinHeap(comparator)

      heap.push({ category: 'B', score: 10 })
      heap.push({ category: 'A', score: 5 })
      heap.push({ category: 'A', score: 10 })
      heap.push({ category: 'B', score: 5 })

      // A comes before B, then within same category higher score first
      const first = heap.pop()
      assert.equal(first.category, 'A')
      assert.equal(first.score, 10)

      const second = heap.pop()
      assert.equal(second.category, 'A')
      assert.equal(second.score, 5)

      const third = heap.pop()
      assert.equal(third.category, 'B')
      assert.equal(third.score, 10)

      const fourth = heap.pop()
      assert.equal(fourth.category, 'B')
      assert.equal(fourth.score, 5)
    })
  })

  describe('Large Dataset', function () {
    it('should handle 10000 elements', function () {
      const heap = new MinHeap((a, b) => a - b)
      const values = []

      // Push random values
      for (let i = 0; i < 10000; i++) {
        const val = Math.floor(Math.random() * 100000)
        values.push(val)
        heap.push(val)
      }

      // Sort values for comparison
      values.sort((a, b) => a - b)

      // Pop all and verify order
      for (let i = 0; i < 10000; i++) {
        assert.equal(heap.pop(), values[i])
      }

      assert.isTrue(heap.isEmpty())
    })
  })
})
