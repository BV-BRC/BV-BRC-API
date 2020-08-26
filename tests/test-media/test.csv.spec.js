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

describe('Test Media Types: csv', () => {
  it('Test call_method: stream', (done) => {
    (async () => {
      try {
        const body = await httpRequest(Object.assign(requestOptions, {
          headers: {
            'Accept': 'text/csv',
            'Content-Type': 'application/x-www-form-urlencoded',
            'download': true
          },
          method: 'POST',
          path: '/genome_feature/'
        }), 'rql=eq%28feature_id%252CPATRIC.83332.12.NC_000962.CDS.2052.3260.fwd%29%2526sort%28%252Bfeature_id%29%2526limit%281%29')

        const expected = 'Genome,Genome ID,Accession,PATRIC ID,RefSeq Locus Tag,Alt Locus Tag,Feature ID,Annotation,Feature Type,Start,End,Length,Strand,FIGfam ID,PATRIC genus-specific families (PLfams),PATRIC cross-genus families (PGfams),Protein ID,AA Length,Gene Symbol,Product,GO\n\
"Mycobacterium tuberculosis H37Rv","83332.12","NC_000962","fig|83332.12.peg.2","Rv0002","VBIMycTub87468_0002","PATRIC.83332.12.NC_000962.CDS.2052.3260.fwd","PATRIC","CDS",2052,3260,1209,"+","FIG00066425","PLF_1763_00000832","PGF_06473395","NP_214516.1",402,"dnaN","DNA polymerase III beta subunit (EC 2.7.7.7)","GO:0003887|DNA-directed DNA polymerase activity"\n'
        assert.equal(body, expected)
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
            'Accept': 'text/csv',
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          method: 'POST',
          path: '/genome_feature/'
        }), 'rql=eq%28feature_id%252CPATRIC.83332.12.NC_000962.CDS.2052.3260.fwd%29%2526sort%28%252Bfeature_id%29%2526limit%281%29')

        const expected = 'genome_name,genome_id,accession,patric_id,refseq_locus_tag,alt_locus_tag,feature_id,annotation,feature_type,start,end,na_length,strand,figfam_id,plfam_id,pgfam_id,protein_id,aa_length,gene,product,go\n\
"Mycobacterium tuberculosis H37Rv","83332.12","NC_000962","fig|83332.12.peg.2","Rv0002","VBIMycTub87468_0002","PATRIC.83332.12.NC_000962.CDS.2052.3260.fwd","PATRIC","CDS",2052,3260,1209,"+","FIG00066425","PLF_1763_00000832","PGF_06473395","NP_214516.1",402,"dnaN","DNA polymerase III beta subunit (EC 2.7.7.7)","GO:0003887|DNA-directed DNA polymerase activity"\n'
        assert.equal(body, expected)
        done()
      } catch (error) {
        done(error)
      }
    })()
  })
})
