const assert = require('chai').assert
const { httpRequest } = require('../../util/http')
const Http = require('http')
const Config = require('../../config')
const MAX_TIMEOUT = 2 * 60 * 1000
// const Path = require('path')
// const Fs = require('fs')
const agent = new Http.Agent({
  keepAlive: true,
  maxSockets: 1
})

describe('Test Panaconda', function () {
  const method = 'panaconda'

  it('should return graph', async function () {
    this.timeout(MAX_TIMEOUT)

    const params = ['and(ne(feature_type,source),eq(annotation,PATRIC),in(genome_id,(1151215.3,1169664.3)))&limit(2500000)&select(genome_id,genome_name,accession,annotation,feature_type,patric_id,refseq_locus_tag,alt_locus_tag,uniprotkb_accession,start,end,strand,na_length,gene,product,figfam_id,plfam_id,pgfam_id,go,ec,pathway)&sort(+genome_id,+sequence_id,+start)', 'patric_pgfam', 3, 'genome', 'species']
    const payload = JSON.stringify({ 'id': 1, 'method': method, 'params': params, 'jsonrpc': '2.0' })
    // const expected = Fs.readFileSync(Path.join(__dirname, 'expected.panaconda.json'))
    return httpRequest({
      port: Config.get('http_port'),
      agent: agent,
      headers: {
        'Content-Type': 'application/jsonrpc+json'
      },
      method: 'POST'
    }, payload).then((res) => {
      const data= JSON.parse(res)
      assert.isNotEmpty(data.result.graph)
      // assert.deepEqual(data, JSON.parse(expected))
    })
  })
})
