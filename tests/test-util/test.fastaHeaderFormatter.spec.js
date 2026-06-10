/**
 * Unit tests for fastaHeaderFormatter utility
 */

const assert = require('chai').assert
const {
  createFastaHeaderFormatter,
  createFastaHeaderFormatterFromRequest,
  parseConfigFromRequest,
  formatLegacyHeader,
  formatLegacyGenomeSequenceHeader,
  getFieldValue,
  formatFields,
  DEFAULT_CONFIG
} = require('../../util/fastaHeaderFormatter')

describe('fastaHeaderFormatter', function () {
  describe('getFieldValue', function () {
    it('should get simple field values', function () {
      const doc = { name: 'test', id: 123 }
      assert.equal(getFieldValue(doc, 'name'), 'test')
      assert.equal(getFieldValue(doc, 'id'), '123')
    })

    it('should get nested field values', function () {
      const doc = {
        genome_metadata: {
          genome_name: 'E. coli',
          taxon_id: 562
        }
      }
      assert.equal(getFieldValue(doc, 'genome_metadata.genome_name'), 'E. coli')
      assert.equal(getFieldValue(doc, 'genome_metadata.taxon_id'), '562')
    })

    it('should return undefined for missing fields', function () {
      const doc = { name: 'test' }
      assert.isUndefined(getFieldValue(doc, 'missing'))
      assert.isUndefined(getFieldValue(doc, 'nested.missing'))
    })

    it('should handle null and undefined docs', function () {
      assert.isUndefined(getFieldValue(null, 'field'))
      assert.isUndefined(getFieldValue(undefined, 'field'))
    })

    it('should join array values with comma', function () {
      const doc = { tags: ['a', 'b', 'c'] }
      assert.equal(getFieldValue(doc, 'tags'), 'a,b,c')
    })
  })

  describe('formatFields', function () {
    it('should format multiple fields with delimiter', function () {
      const doc = { a: '1', b: '2', c: '3' }
      const result = formatFields(doc, ['a', 'b', 'c'], '|')
      assert.equal(result, '1|2|3')
    })

    it('should skip missing fields', function () {
      const doc = { a: '1', c: '3' }
      const result = formatFields(doc, ['a', 'b', 'c'], '|')
      assert.equal(result, '1|3')
    })

    it('should skip empty strings', function () {
      const doc = { a: '1', b: '', c: '3' }
      const result = formatFields(doc, ['a', 'b', 'c'], '|')
      assert.equal(result, '1|3')
    })
  })

  describe('createFastaHeaderFormatter', function () {
    it('should create formatter with default options', function () {
      const formatter = createFastaHeaderFormatter({})
      const header = formatter({ id: 'test123' })

      assert.match(header, /^>test123/)
      assert.match(header, /\n$/)
    })

    it('should format ID fields with delimiter', function () {
      const formatter = createFastaHeaderFormatter({
        idFields: ['a', 'b', 'c'],
        idDelimiter: '|'
      })

      const header = formatter({ a: '1', b: '2', c: '3' })
      assert.match(header, /^>1\|2\|3/)
    })

    it('should add ID prefix', function () {
      const formatter = createFastaHeaderFormatter({
        idFields: ['id'],
        idPrefix: 'gi|'
      })

      const header = formatter({ id: '12345' })
      assert.match(header, /^>gi\|12345/)
    })

    it('should add description fields', function () {
      const formatter = createFastaHeaderFormatter({
        idFields: ['id'],
        descriptionFields: ['product']
      })

      const header = formatter({ id: 'feat1', product: 'Kinase enzyme' })
      assert.include(header, 'Kinase enzyme')
    })

    it('should add context fields in brackets', function () {
      const formatter = createFastaHeaderFormatter({
        idFields: ['id'],
        contextFields: ['genome_name', 'genome_id'],
        contextDelimiter: ' | '
      })

      const header = formatter({
        id: 'feat1',
        genome_name: 'E. coli',
        genome_id: '123.456'
      })

      assert.include(header, '[E. coli | 123.456]')
    })

    it('should handle missing values gracefully', function () {
      const formatter = createFastaHeaderFormatter({
        idFields: ['id', 'missing'],
        descriptionFields: ['product', 'missing2'],
        contextFields: ['genome_name']
      })

      const header = formatter({
        id: 'feat1',
        product: 'Test'
      })

      assert.match(header, /^>feat1 Test/)
      assert.notInclude(header, 'undefined')
      assert.notInclude(header, 'null')
    })

    it('should return "unknown" for empty ID', function () {
      const formatter = createFastaHeaderFormatter({
        idFields: ['missing']
      })

      const header = formatter({})
      assert.match(header, /^>unknown/)
    })
  })

  describe('parseConfigFromRequest', function () {
    it('should parse ID fields from request', function () {
      const req = {
        query: {
          http_fasta_id_fields: 'patric_id,gene,locus_tag'
        }
      }

      const config = parseConfigFromRequest(req)
      assert.deepEqual(config.idFields, ['patric_id', 'gene', 'locus_tag'])
    })

    it('should parse ID delimiter from request', function () {
      const req = {
        query: {
          http_fasta_id_delimiter: ':'
        }
      }

      const config = parseConfigFromRequest(req)
      assert.equal(config.idDelimiter, ':')
    })

    it('should parse description fields from request', function () {
      const req = {
        query: {
          http_fasta_description_fields: 'product,function'
        }
      }

      const config = parseConfigFromRequest(req)
      assert.deepEqual(config.descriptionFields, ['product', 'function'])
    })

    it('should parse context fields from request', function () {
      const req = {
        query: {
          http_fasta_context_fields: 'genome_name,genome_id,strain'
        }
      }

      const config = parseConfigFromRequest(req)
      assert.deepEqual(config.contextFields, ['genome_name', 'genome_id', 'strain'])
    })

    it('should handle empty request', function () {
      const req = { query: {} }
      const config = parseConfigFromRequest(req)

      assert.isUndefined(config.idFields)
      assert.isUndefined(config.descriptionFields)
    })

    it('should trim whitespace from fields', function () {
      const req = {
        query: {
          http_fasta_id_fields: ' id , name , tag '
        }
      }

      const config = parseConfigFromRequest(req)
      assert.deepEqual(config.idFields, ['id', 'name', 'tag'])
    })
  })

  describe('createFastaHeaderFormatterFromRequest', function () {
    it('should use defaults for genome_feature collection', function () {
      const req = {
        call_collection: 'genome_feature',
        query: {}
      }

      const formatter = createFastaHeaderFormatterFromRequest(req)
      const header = formatter({
        patric_id: 'fig|123.456.peg.1',
        product: 'Test protein',
        genome_name: 'E. coli',
        genome_id: '123.456'
      })

      assert.include(header, 'fig|123.456.peg.1')
      assert.include(header, 'Test protein')
      assert.include(header, '[E. coli')
    })

    it('should override defaults with request params', function () {
      const req = {
        call_collection: 'genome_feature',
        query: {
          http_fasta_id_fields: 'gene,locus_tag',
          http_fasta_id_delimiter: ':'
        }
      }

      const formatter = createFastaHeaderFormatterFromRequest(req)
      const header = formatter({
        gene: 'dnaK',
        locus_tag: 'ABC_0001'
      })

      assert.match(header, /^>dnaK:ABC_0001/)
    })

    it('should use annotation-specific defaults', function () {
      const req = {
        call_collection: 'genome_feature',
        query: {
          annotation: 'RefSeq'
        }
      }

      const formatter = createFastaHeaderFormatterFromRequest(req)
      const header = formatter({
        gi: '12345',
        refseq_locus_tag: 'RS_0001',
        product: 'Test'
      })

      // RefSeq should use gi| prefix
      assert.include(header, 'gi|')
    })
  })

  describe('formatLegacyHeader', function () {
    it('should format PATRIC annotation correctly', function () {
      const doc = {
        annotation: 'PATRIC',
        patric_id: 'fig|123.456.peg.1',
        refseq_locus_tag: 'RS_0001',
        alt_locus_tag: 'ALT_0001',
        product: 'Hypothetical protein',
        genome_name: 'Escherichia coli',
        genome_id: '123.456'
      }

      const header = formatLegacyHeader(doc)

      assert.include(header, 'fig|123.456.peg.1')
      assert.include(header, 'RS_0001')
      assert.include(header, 'ALT_0001')
      assert.include(header, 'Hypothetical protein')
      assert.include(header, '[Escherichia coli | 123.456]')
      assert.match(header, /^>/)
      assert.match(header, /\n$/)
    })

    it('should format RefSeq annotation correctly', function () {
      const doc = {
        annotation: 'RefSeq',
        gi: '12345678',
        refseq_locus_tag: 'RS_0001',
        product: 'Kinase',
        genome_name: 'Test organism',
        genome_id: '789.012'
      }

      const header = formatLegacyHeader(doc)

      assert.include(header, 'gi|12345678')
      assert.include(header, 'RS_0001')
      assert.include(header, 'Kinase')
    })

    it('should handle missing optional fields', function () {
      const doc = {
        annotation: 'PATRIC',
        patric_id: 'fig|123.456.peg.1',
        genome_name: 'Test',
        genome_id: '123'
      }

      const header = formatLegacyHeader(doc)

      assert.include(header, 'fig|123.456.peg.1')
      assert.notInclude(header, 'undefined')
    })
  })

  describe('formatLegacyGenomeSequenceHeader', function () {
    it('should format genome sequence header correctly', function () {
      const doc = {
        accession: 'NC_000001',
        description: 'Chromosome 1',
        genome_name: 'E. coli K-12',
        genome_id: '511145.12'
      }

      const header = formatLegacyGenomeSequenceHeader(doc)

      assert.include(header, 'accn|NC_000001')
      assert.include(header, 'Chromosome 1')
      assert.include(header, '[E. coli K-12 | 511145.12]')
      assert.match(header, /^>/)
      assert.match(header, /\n$/)
    })

    it('should handle missing values', function () {
      const doc = {
        accession: 'NC_000001'
      }

      const header = formatLegacyGenomeSequenceHeader(doc)

      assert.include(header, 'accn|NC_000001')
      assert.notInclude(header, 'undefined')
    })
  })

  describe('DEFAULT_CONFIG', function () {
    it('should have genome_feature configuration', function () {
      assert.isDefined(DEFAULT_CONFIG.genome_feature)
      assert.isDefined(DEFAULT_CONFIG.genome_feature.PATRIC)
      assert.isDefined(DEFAULT_CONFIG.genome_feature.RefSeq)
      assert.isDefined(DEFAULT_CONFIG.genome_feature.default)
    })

    it('should have genome_sequence configuration', function () {
      assert.isDefined(DEFAULT_CONFIG.genome_sequence)
      assert.isDefined(DEFAULT_CONFIG.genome_sequence.default)
    })

    it('should have idFields in configs', function () {
      assert.isArray(DEFAULT_CONFIG.genome_feature.PATRIC.idFields)
      assert.isArray(DEFAULT_CONFIG.genome_feature.RefSeq.idFields)
      assert.isArray(DEFAULT_CONFIG.genome_sequence.default.idFields)
    })
  })
})
