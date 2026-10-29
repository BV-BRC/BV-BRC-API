/**
 * ACL fields may not be used as aggregation targets.
 *
 * Permission enforcement here is row-level only — DecorateQuery appends an fq choosing
 * which documents you see, and nothing governs which FIELDS of a visible document you may
 * facet, sort, or group on. Because facet counts are computed over the entire
 * permission-filtered DocSet rather than the returned page, a facet over `user_read` turns
 * per-record ACL visibility into bulk account enumeration.
 *
 * Measured anonymously against alpha before the fix, no credentials required:
 *
 *   eq(public,false)&limit(1)&facet((field,user_read),(mincount,0))
 *     -> 100 account names (default facet limit; facet.limit=-1 yields 30,513)
 *
 * Offline: these exercise the pure matcher, so no API, Solr or Redis is needed.
 *
 * THE FALSE-POSITIVE CASES MATTER AS MUCH AS THE BLOCKS. A naive substring match on
 * "owner" would reject `facet.field=host_name` (no) but also `sort=downer_count` and any
 * field merely containing the word — breaking ordinary queries in a way that is far more
 * visible than the hole it closes, and inviting someone to weaken the check.
 */

const assert = require('chai').assert
const {
  findAclAggregation,
  ACL_FIELDS,
  FIELD_NAMING_PARAMS
} = require('../../middleware/SolrQuerySanitizer')

const blocked = (q) => assert.isNotNull(findAclAggregation(q), `should BLOCK: ${q}`)
const allowed = (q) => assert.isNull(findAclAggregation(q), `should ALLOW: ${q}`)

describe('ACL field aggregation', function () {
  describe('the measured vector', function () {
    it('blocks the exact query that enumerated 100 accounts anonymously', function () {
      blocked('q=*:*&fq=public:false&rows=1&facet=true&facet.field=user_read&facet.mincount=0')
    })

    it('blocks it with facet.limit=-1, the 30,513-account form', function () {
      blocked('q=*:*&facet=true&facet.field=user_read&facet.limit=-1')
    })
  })

  describe('every ACL field, through every field-naming parameter', function () {
    for (const field of ACL_FIELDS) {
      for (const param of FIELD_NAMING_PARAMS) {
        it(`blocks ${param}=${field}`, function () {
          blocked(`q=*:*&${param}=${field}`)
        })
      }
    }
  })

  describe('encoding bypasses', function () {
    // The module fully decodes before scanning; these pin that it applies here too.
    it('blocks a percent-encoded field name', function () {
      blocked('q=*:*&facet.field=%75ser_read') // u
    })

    it('blocks a double-encoded field name', function () {
      blocked('q=*:*&facet.field=%2575ser_read')
    })

    it('blocks an encoded parameter separator smuggling the facet', function () {
      blocked('q=*:*%26facet.field=owner')
    })
  })

  describe('list and decorated values — where a whole-value match would fail', function () {
    it('blocks an ACL field anywhere in a pivot chain, not just first', function () {
      blocked('q=*:*&facet.pivot=genome_status,user_read')
    })

    it('blocks an ACL field later in a multi-field sort', function () {
      blocked('q=*:*&sort=genome_id asc,owner desc')
    })

    it('blocks a sort with a direction suffix', function () {
      blocked('q=*:*&sort=user_read asc')
    })

    it('blocks a facet.field carrying a local param prefix', function () {
      blocked('q=*:*&facet.field={!ex=dt}owner')
    })

    it('is case-insensitive on the field name', function () {
      blocked('q=*:*&facet.field=User_Read')
    })

    it('is case-insensitive on the parameter name', function () {
      blocked('q=*:*&FACET.FIELD=owner')
    })
  })

  describe('legitimate queries must still pass', function () {
    it('allows faceting on ordinary fields', function () {
      allowed('q=*:*&facet=true&facet.field=genome_status&facet.field=host_name')
    })

    it('allows an ordinary multi-field sort', function () {
      allowed('q=*:*&sort=genome_id asc,genome_name desc')
    })

    it('allows a pivot over ordinary fields', function () {
      allowed('q=*:*&facet.pivot=superkingdom,genus')
    })

    it('does NOT block a field that merely contains an ACL field name', function () {
      // The hole a substring match would punch in ordinary queries.
      allowed('q=*:*&facet.field=owner_institution')
      allowed('q=*:*&sort=downer_count asc')
      allowed('q=*:*&facet.field=user_read_count')
    })

    it('allows ACL fields as FILTER terms — this blocks aggregation, not visibility', function () {
      // A user legitimately queries their own records; row-level permission still
      // applies. Blocking this would break sharing, and it is not the scaling vector.
      allowed('q=*:*&fq=owner:someone@patricbrc.org')
      allowed('q=user_read:someone@patricbrc.org')
    })

    it('allows ACL fields in fl — projection is per-record visibility, out of scope', function () {
      // Deliberately not blocked: fl returns the field only for rows already visible,
      // and owners need to read their own ACLs.
      allowed('q=*:*&fl=genome_id,owner,user_read')
    })

    it('ignores a bare parameter with no value', function () {
      allowed('q=*:*&facet.field')
    })
  })

  describe('input hygiene', function () {
    it('handles null, undefined, empty and non-string input', function () {
      for (const bad of [null, undefined, '', 0, {}, []]) {
        assert.isNull(findAclAggregation(bad))
      }
    })
  })
})
