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

    it('renders an unknown field as empty, returning 200 not 400', function () {
      // PINNED AS THE DOCUMENTED CONTRACT, not as an aspiration. An earlier version of
      // the contract comment claimed unknown names were rejected; they are not, and a
      // GUI client relied on that claim and hit a silently truncated header from a
      // typo. Validating a bare name needs the Solr schema, so clients must check
      // against /:collection/fields. If that ever changes, change this test with it.
      assert.equal(render('{patric_id} {no_such_field}'), '>fig|1.1.peg.1')
      assert.equal(render('{patric_id} {hostname}'), '>fig|1.1.peg.1',
        'the exact reported typo of host_name')
    })
  })

  describe('escaping braces', function () {
    // Reported live 2026-10-30: `A{{x}}B` rendered `>A{}B` instead of `>A{x}B`. The
    // renderer ran its field regex over the RAW string, so it matched the inner `{x}`
    // and substituted it away before the unescape pass ever saw it.
    it('renders escaped content, not an empty brace pair', function () {
      assert.equal(render('A{{x}}B'), '>A{x}B')
      assert.equal(render('{{lit}}'), '>{lit}')
      assert.equal(render('{{}}'), '>{}')
    })

    it('treats {{{field}}} as a literal brace around a real reference', function () {
      assert.equal(render('{{{patric_id}}}'), '>{fig|1.1.peg.1}')
    })

    it('mixes escapes and references in one template', function () {
      assert.equal(render('{patric_id} {{x}} {genome_id}'), '>fig|1.1.peg.1 {x} 1.1')
    })

    it('does not treat an escaped brace as a field reference', function () {
      assert.deepEqual(templateFields('{patric_id} {{not_a_field}}'), ['patric_id'])
    })
  })

  describe('discovery and rendering cannot disagree', function () {
    // They parsed SEPARATELY and did disagree: discovery blanked escapes with a
    // sentinel and returned a corrupted name for `{{{field}}}` while the renderer
    // substituted the real field -- so the join never fetched it and it rendered
    // empty. Both now go through scanTemplate(), and these cases pin that.
    const CASES = [
      '{patric_id}',
      '{{{patric_id}}}',
      'A{{x}}B',
      '{patric_id} {{x}} {genome_id}',
      '{{}}',
      '{patric_id}{genome_id}'
    ]

    it('every field the renderer substitutes is also discovered', function () {
      for (const tpl of CASES) {
        const discovered = templateFields(tpl)
        // Render with a doc whose values are the field names themselves; anything the
        // renderer substitutes must therefore appear in the output.
        const probe = {}
        for (const f of ['patric_id', 'genome_id', 'x', 'not_a_field']) probe[f] = `<${f}>`
        const out = createFastaHeaderFormatter({ template: tpl })(probe)
        for (const f of ['patric_id', 'genome_id', 'x']) {
          if (out.includes(`<${f}>`)) {
            assert.include(discovered, f,
              `${tpl}: renderer substituted ${f} but discovery missed it -- the join ` +
              'would not fetch it and the field would render empty')
          }
        }
      }
    })

    it('discovery never reports a name the renderer ignores', function () {
      // The converse: a spurious name makes the join fetch fields nobody asked for.
      assert.deepEqual(templateFields('A{{x}}B'), [])
      assert.deepEqual(templateFields('{{}}'), [])
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
