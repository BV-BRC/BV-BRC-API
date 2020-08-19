const assert = require('chai').assert
const {httpGet, httpRequest} = require('../../util/http')
const http = require('http')

const agent = new http.Agent({
  keepAlive: true,
  maxSockets: 3
})
const requestOptions = {
  port: 3001,
  agent: agent
}

describe('Test Media Types: tsv', () => {
  it('Test call_method: stream', (done) => {
    (async () => {
      try {
        const body = await httpRequest(Object.assign(requestOptions, {
          headers: {
            'Accept': 'text/tsv',
            'Content-Type': 'application/x-www-form-urlencoded',
            'download': true
          },
          method: 'POST',
          path: '/genome_feature/'
        }), 'rql=eq%28feature_id%252CPATRIC.83332.12.NC_000962.CDS.2052.3260.fwd%29%2526sort%28%252Bfeature_id%29%2526limit%281%29')

        const expected = 'Genome\tGenome ID\tAccession\tPATRIC ID\tRefSeq Locus Tag\tAlt Locus Tag\tFeature ID\tAnnotation\tFeature Type\tStart\tEnd\tLength\tStrand\tFIGfam ID\tPATRIC genus-specific families (PLfams)\tPATRIC cross-genus families (PGfams)\tProtein ID\tAA Length\tGene Symbol\tProduct\tGO\n\
"Mycobacterium tuberculosis H37Rv"\t"83332.12"\t"NC_000962"\t"fig|83332.12.peg.2"\t"Rv0002"\t"VBIMycTub87468_0002"\t"PATRIC.83332.12.NC_000962.CDS.2052.3260.fwd"\t"PATRIC"\t"CDS"\t2052\t3260\t1209\t"+"\t"FIG00066425"\t"PLF_1763_00000832"\t"PGF_06473395"\t"NP_214516.1"\t402\t"dnaN"\t"DNA polymerase III beta subunit (EC 2.7.7.7)"\t"GO:0003887|DNA-directed DNA polymerase activity"\n'
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
            'Accept': 'text/tsv',
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          method: 'POST',
          path: '/genome_feature/'
        }), 'rql=eq%28feature_id%252CPATRIC.83332.12.NC_000962.CDS.2052.3260.fwd%29%2526sort%28%252Bfeature_id%29%2526limit%281%29')

        const expected = 'genome_name\tgenome_id\taccession\tpatric_id\trefseq_locus_tag\talt_locus_tag\tfeature_id\tannotation\tfeature_type\tstart\tend\tna_length\tstrand\tfigfam_id\tplfam_id\tpgfam_id\tprotein_id\taa_length\tgene\tproduct\tgo\n\
"Mycobacterium tuberculosis H37Rv"\t"83332.12"\t"NC_000962"\t"fig|83332.12.peg.2"\t"Rv0002"\t"VBIMycTub87468_0002"\t"PATRIC.83332.12.NC_000962.CDS.2052.3260.fwd"\t"PATRIC"\t"CDS"\t2052\t3260\t1209\t"+"\t"FIG00066425"\t"PLF_1763_00000832"\t"PGF_06473395"\t"NP_214516.1"\t402\t"dnaN"\t"DNA polymerase III beta subunit (EC 2.7.7.7)"\t"GO:0003887|DNA-directed DNA polymerase activity"\n'
        assert.equal(body, expected)
        done()
      } catch (error) {
        done(error)
      }
    })()
  })
})
