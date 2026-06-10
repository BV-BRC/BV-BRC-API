/**
 * MinHeap
 *
 * A binary min-heap implementation for k-way merge sorting.
 * Supports custom comparator functions and tracks source information
 * for each element (e.g., which shard a document came from).
 */

class MinHeap {
  /**
   * Create a new min-heap.
   *
   * @param {Function} comparator - Comparison function (a, b) => number
   *   Returns negative if a < b, positive if a > b, zero if equal
   *   Default: numeric comparison
   */
  constructor (comparator) {
    this.heap = []
    this.comparator = comparator || ((a, b) => a.value - b.value)
  }

  /**
   * Get the number of elements in the heap.
   *
   * @returns {number} Heap size
   */
  size () {
    return this.heap.length
  }

  /**
   * Check if the heap is empty.
   *
   * @returns {boolean} True if empty
   */
  isEmpty () {
    return this.heap.length === 0
  }

  /**
   * Get the minimum element without removing it.
   *
   * @returns {*} Minimum element or undefined if empty
   */
  peek () {
    return this.heap[0]
  }

  /**
   * Add an element to the heap.
   *
   * @param {*} item - Element to add
   * @returns {number} New heap size
   */
  push (item) {
    this.heap.push(item)
    this._bubbleUp(this.heap.length - 1)
    return this.heap.length
  }

  /**
   * Remove and return the minimum element.
   *
   * @returns {*} Minimum element or undefined if empty
   */
  pop () {
    if (this.heap.length === 0) {
      return undefined
    }

    const min = this.heap[0]

    if (this.heap.length === 1) {
      this.heap.pop()
    } else {
      // Move last element to root and bubble down
      this.heap[0] = this.heap.pop()
      this._bubbleDown(0)
    }

    return min
  }

  /**
   * Remove and return the minimum element, then add a new element.
   * More efficient than pop() followed by push().
   *
   * @param {*} item - Element to add
   * @returns {*} The removed minimum element
   */
  replace (item) {
    if (this.heap.length === 0) {
      this.heap.push(item)
      return undefined
    }

    const min = this.heap[0]
    this.heap[0] = item
    this._bubbleDown(0)
    return min
  }

  /**
   * Add an element and remove the minimum.
   * More efficient than push() followed by pop().
   *
   * @param {*} item - Element to add
   * @returns {*} The minimum element (either the new item or previous min)
   */
  pushPop (item) {
    if (this.heap.length === 0 || this.comparator(item, this.heap[0]) <= 0) {
      return item
    }

    const min = this.heap[0]
    this.heap[0] = item
    this._bubbleDown(0)
    return min
  }

  /**
   * Clear all elements from the heap.
   */
  clear () {
    this.heap = []
  }

  /**
   * Convert heap to array (does not modify heap).
   *
   * @returns {Array} Array copy of heap elements (not sorted)
   */
  toArray () {
    return [...this.heap]
  }

  /**
   * Bubble up an element to maintain heap property.
   *
   * @param {number} index - Index of element to bubble up
   * @private
   */
  _bubbleUp (index) {
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2)

      if (this.comparator(this.heap[index], this.heap[parentIndex]) >= 0) {
        break
      }

      // Swap with parent
      this._swap(index, parentIndex)
      index = parentIndex
    }
  }

  /**
   * Bubble down an element to maintain heap property.
   *
   * @param {number} index - Index of element to bubble down
   * @private
   */
  _bubbleDown (index) {
    const length = this.heap.length

    while (true) {
      const leftChild = 2 * index + 1
      const rightChild = 2 * index + 2
      let smallest = index

      if (leftChild < length &&
          this.comparator(this.heap[leftChild], this.heap[smallest]) < 0) {
        smallest = leftChild
      }

      if (rightChild < length &&
          this.comparator(this.heap[rightChild], this.heap[smallest]) < 0) {
        smallest = rightChild
      }

      if (smallest === index) {
        break
      }

      this._swap(index, smallest)
      index = smallest
    }
  }

  /**
   * Swap two elements in the heap.
   *
   * @param {number} i - First index
   * @param {number} j - Second index
   * @private
   */
  _swap (i, j) {
    const temp = this.heap[i]
    this.heap[i] = this.heap[j]
    this.heap[j] = temp
  }

  /**
   * Validate heap property (for debugging/testing).
   *
   * @returns {boolean} True if valid min-heap
   */
  isValid () {
    for (let i = 0; i < this.heap.length; i++) {
      const leftChild = 2 * i + 1
      const rightChild = 2 * i + 2

      if (leftChild < this.heap.length &&
          this.comparator(this.heap[leftChild], this.heap[i]) < 0) {
        return false
      }

      if (rightChild < this.heap.length &&
          this.comparator(this.heap[rightChild], this.heap[i]) < 0) {
        return false
      }
    }
    return true
  }
}

/**
 * Create a comparator for sorting by a specific field.
 *
 * @param {string} field - Field name to sort by
 * @param {string} [order='asc'] - Sort order ('asc' or 'desc')
 * @returns {Function} Comparator function
 */
MinHeap.fieldComparator = function (field, order = 'asc') {
  const multiplier = order === 'desc' ? -1 : 1

  return (a, b) => {
    const aVal = a.doc ? a.doc[field] : a[field]
    const bVal = b.doc ? b.doc[field] : b[field]

    if (aVal === bVal) return 0
    if (aVal === null || aVal === undefined) return 1 * multiplier
    if (bVal === null || bVal === undefined) return -1 * multiplier

    if (typeof aVal === 'string' && typeof bVal === 'string') {
      return aVal.localeCompare(bVal) * multiplier
    }

    return (aVal < bVal ? -1 : 1) * multiplier
  }
}

/**
 * Create a comparator for sorting by multiple fields.
 *
 * @param {Array} fields - Array of { field, order } objects
 * @returns {Function} Comparator function
 */
MinHeap.multiFieldComparator = function (fields) {
  const comparators = fields.map(f =>
    MinHeap.fieldComparator(f.field, f.order)
  )

  return (a, b) => {
    for (const comparator of comparators) {
      const result = comparator(a, b)
      if (result !== 0) return result
    }
    return 0
  }
}

module.exports = MinHeap
