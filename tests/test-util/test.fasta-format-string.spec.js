/**
 * http_fasta_header — format strings for FASTA headers.
 *
 * The three-zone scheme (id / description / context) cannot express a header whose
 * literal text does not match `>ID DESC [CTX]`, and the community parses these headers
 * with their own tooling, so the exact shape matters to them.
 *
 * Four decisions are pinned here, because each is a place where a later "improvement"
 * would silently change output: missing values render empty, the template is exclusive,
 * braces escape as {{ }}, and an unknown name renders empty rather than erroring at
 * render time (syntax errors DO 400, in routes/dataType.js, before the response starts).
 */

const assert = require('chai').assert
const {
  createFastaHeaderFormatter,
  createFastaHeaderFormatterFromRequest,
  templateFields,
  validateTemplate
} = require('../../util/fastaHeaderFormatter')

const DOC = {
  patric_id: 'fig|1.1.peg.1',
  genome_id: '1.1',
  product: 'ABC transporter',
  genome_name: 'E. coli K-12',
  strain: '',
  genome_metadata: { host_name: 'Homo sapiens' }
}

const render = (template, doc = DOC) =>
  createFastaHeaderFormatter({ template })(doc).trim()

describe('FASTA format strings', function () {
  describe('rendering', function () {
    it('substitutes fields into arbitrary literal text', function () {
      assert.equal(render('{patric_id}|{genome_id} {product} [{genome_name}]'),
        '>fig|1.1.peg.1|1.1 ABC transporter [E. coli K-12]')
    })

    it('supports a layout the zone scheme cannot express', function () {
      // The whole point: literals before the id, no brackets, custom ordering.
      assert.equal(render('db|{genome_id}|{patric_id}::{product}'),
        '>db|1.1|fig|1.1.peg.1::ABC transporter')
    })

    it('resolves joined metadata by bare name', function () {
      assert.equal(render('{patric_id} {host_name}'), '>fig|1.1.peg.1 Homo sapiens')
    })

    it('resolves the dotted genome_metadata form too', function () {
      assert.equal(render('{genome_metadata.host_name}'), '>Homo sapiens')
    })

    it('renders a missing value as empty WITHOUT rewriting the template', function () {
      // Decision 1. The zone scheme collapses the delimiter around an absent field; a
      // template cannot, and guessing which literals to drop would be worse than a
      // visible gap. Callers needing omit-when-absent keep using the zone parameters.
      assert.equal(render('{patric_id}|{strain}|{product}'),
        '>fig|1.1.peg.1||ABC transporter')
    })

    it('renders an unknown field as empty at render time', function () {
      // Syntax is rejected with 400 before the response starts; an unknown NAME is not
      // caught there because validating it needs the Solr schema. Documented trade.
      assert.equal(render('{patric_id} {no_such_field}'), '>fig|1.1.peg.1')
    })
  })

  describe('escaping braces', function () {
    it('renders {{ and }} as literal braces', function () {
      assert.equal(render('{{{patric_id}}}'), '>{fig|1.1.peg.1}')
    })

    it('does not treat an escaped brace as a field reference', function () {
      assert.deepEqual(templateFields('{patric_id} {{not_a_field}}'), ['patric_id'])
    })
  })

  describe('field discovery — this drives the genome join', function () {
    it('lists referenced fields in order, deduped', function () {
      assert.deepEqual(
        templateFields('{patric_id}|{genome_id} {product} {genome_id}'),
        ['patric_id', 'genome_id', 'product'])
    })

    it('returns nothing for a template with no references', function () {
      assert.deepEqual(templateFields('static text'), [])
    })

    it('tolerates empty and non-string input', function () {
      for (const bad of [null, undefined, '', 0, {}]) {
        assert.deepEqual(templateFields(bad), [])
      }
    })

    it('MAKES THE JOIN FETCH WHAT THE TEMPLATE NAMES', function () {
      // Without this the template renders enriched fields empty -- the exact
      // silent-drop bug lib/fastaGenomeFields.js exists to prevent.
      const g = require('../../lib/fastaGenomeFields')
      const req = {
        fastaParams: { http_fasta_header: '{patric_id} {host_name} [{habitat}]' },
        call_collection: 'genome_feature'
      }
      assert.isTrue(g.needsGenomeJoin(req, 'genome_feature'))
      const fetched = g.genomeFieldsFor(req, 'genome_feature')
      assert.include(fetched, 'host_name')
      assert.include(fetched, 'habitat')
    })

    it('IGNORES the zone parameters when a template is present', function () {
      // Decision 2. Joining the zone fields instead would fetch the wrong set.
      const g = require('../../lib/fastaGenomeFields')
      const req = {
        fastaParams: {
          http_fasta_header: '{patric_id} {habitat}',
          http_fasta_description_fields: 'host_name,disease'
        },
        call_collection: 'genome_feature'
      }
      const fetched = g.genomeFieldsFor(req, 'genome_feature')
      assert.include(fetched, 'habitat')
      assert.notInclude(fetched, 'disease', 'zone fields must not leak in')
    })
  })

  describe('exclusivity', function () {
    it('a template overrides every zone parameter', function () {
      const req = {
        call_collection: 'genome_feature',
        fastaParams: {
          http_fasta_header: 'TEMPLATE:{patric_id}',
          http_fasta_id_fields: 'genome_id',
          http_fasta_description_fields: 'product',
          http_fasta_context_fields: 'genome_name'
        }
      }
      assert.equal(createFastaHeaderFormatterFromRequest(req)(DOC).trim(),
        '>TEMPLATE:fig|1.1.peg.1')
    })

    it('the zone scheme is unchanged when no template is given', function () {
      const req = {
        call_collection: 'genome_feature',
        fastaParams: {
          http_fasta_id_fields: 'patric_id',
          http_fasta_description_fields: 'product',
          http_fasta_context_fields: 'genome_name'
        }
      }
      assert.equal(createFastaHeaderFormatterFromRequest(req)(DOC).trim(),
        '>fig|1.1.peg.1| ABC transporter [E. coli K-12]')
    })

    it('an empty template falls back to the zone scheme', function () {
      const req = {
        call_collection: 'genome_feature',
        fastaParams: { http_fasta_header: '', http_fasta_id_fields: 'patric_id', http_fasta_context_fields: '' }
      }
      assert.include(createFastaHeaderFormatterFromRequest(req)(DOC), 'fig|1.1.peg.1')
    })
  })

  describe('syntax validation (400s before the response starts)', function () {
    it('accepts a well-formed template', function () {
      assert.isNull(validateTemplate('{a}|{b} literal [{c}]'))
      assert.isNull(validateTemplate('{{escaped}} {a}'))
    })

    it('rejects unbalanced braces', function () {
      // Silent and TOTAL if unchecked: the raw template text lands in every header.
      assert.match(validateTemplate('{patric_id'), /unbalanced/)
      assert.match(validateTemplate('patric_id}'), /unbalanced/)
    })

    it('rejects an empty field reference', function () {
      assert.match(validateTemplate('{patric_id} {}'), /empty field reference/)
    })

    it('rejects an empty or non-string template', function () {
      assert.match(validateTemplate(''), /must not be empty/)
      assert.match(validateTemplate('   '), /must not be empty/)
      assert.match(validateTemplate(null), /must be a string/)
    })
  })
})
