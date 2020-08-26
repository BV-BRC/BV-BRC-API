const assert = require('chai').assert
const {httpRequest} = require('../../util/http')
const http = require('http')
const config = require('../../config')

const agent = new http.Agent({
  keepAlive: true,
  maxSockets: 3
})
const requestOptions = {
  port: config.get('http_port'),
  agent: agent
}

describe('Test Media Types: protein+fasta', () => {
  it('Test call_method: stream', (done) => {
    (async () => {
      try {
        const body = await httpRequest(Object.assign(requestOptions, {
          headers: {
            'Accept': 'application/protein+fasta',
            'Content-Type': 'application/x-www-form-urlencoded',
            'download': true
          },
          method: 'POST',
          path: '/genome_feature/'
        }), 'rql=eq%28feature_id%252CPATRIC.83332.12.NC_000962.CDS.2052.3260.fwd%29%2526sort%28%252Bfeature_id%29%2526limit%281%29')

        assert.equal(body, ExpectedProtinFasta)
        done()
      } catch (error) {
        done(error)
      }
    })()
  })

  it('Test call_method: query', (done) => {
    (async () => {
      try {
        const body = await httpRequest(Object.assign(requestOptions, {
          headers: {
            'Accept': 'application/protein+fasta',
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          method: 'POST',
          path: '/genome_feature/'
        }), 'rql=eq%28feature_id%252CPATRIC.83332.12.NC_000962.CDS.2052.3260.fwd%29%2526sort%28%252Bfeature_id%29%2526limit%281%29')

        assert.equal(body, ExpectedProtinFasta)
        done()
      } catch (error) {
        done(error)
      }
    })()
  })
})

const ExpectedProtinFasta = ">fig|83332.12.peg.2|Rv0002|VBIMycTub87468_0002|   DNA polymerase III beta subunit (EC 2.7.7.7)   [Mycobacterium tuberculosis H37Rv | 83332.12]\n\
MDAATTRVGLTDLTFRLLRESFADAVSWVAKNLPARPAVPVLSGVLLTGSDNGLTISGFD\n\
YEVSAEAQVGAEIVSPGSVLVSGRLLSDITRALPNKPVDVHVEGNRVALTCGNARFSLPT\n\
MPVEDYPTLPTLPEETGLLPAELFAEAISQVAIAAGRDDTLPMLTGIRVEILGETVVLAA\n\
TDRFRLAVRELKWSASSPDIEAAVLVPAKTLAEAAKAGIGGSDVRLSLGTGPGVGKDGLL\n\
GISGNGKRSTTRLLDAEFPKFRQLLPTEHTAVATMDVAELIEAIKLVALVADRGAQVRME\n\
FADGSVRLSAGADDVGRAEEDLVVDYAGEPLTIAFNPTYLTDGLSSLRSERVSFGFTTAG\n\
KPALLRPVSGDDRPVAGLNGNGPFPAVSTDYVYLLMPVRLPG\n"
