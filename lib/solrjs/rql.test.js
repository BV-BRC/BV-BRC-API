const assert = require('chai').assert
const Rql = require('./rql')

describe('Test RqlParser', () => {
  it('should return Error starting with ?', (done) => {
    try {
      Rql('?eq(a,b)')
    } catch (err) {
      assert.equal(err.name, 'URIError')
      assert.equal(err.message, 'Query must not start with ?')
      done()
    }
  })
  it('Should return URI Error for Illegal character', (done) => {
    try {
      Rql('eq(a, b)')
    } catch (err) {
      assert.equal(err.name, 'URIError')
      assert.equal(err.message, 'Illegal character in query string encountered  ')
      done()
    }
  })
  it('Parse Date', (done) => {
    const rqlQueryGt = Rql('gt(field,date:2020-01-01T12:34:56Z)').toSolr({ defaultLimit: 25 })
    assert.equal(rqlQueryGt, '&q=field:[2020-01-01T12:34:56.000Z TO *]&rows=25')

    const rqlQueryGe = Rql('ge(field,date:2020-01-01T12:34:56Z)').toSolr({ defaultLimit: 25 })
    assert.equal(rqlQueryGe, '&q=field:{2020-01-01T12:34:56.000Z TO *}&rows=25')

    const rqlQueryLt = Rql('lt(field,date:2020-01-01T12:34:56Z)').toSolr({ defaultLimit: 25 })
    assert.equal(rqlQueryLt, '&q=field:[* TO 2020-01-01T12:34:56.000Z]&rows=25')

    const rqlQueryLe = Rql('le(field,date:2020-01-01T12:34:56Z)').toSolr({ defaultLimit: 25 })
    assert.equal(rqlQueryLe, '&q=field:{* TO 2020-01-01T12:34:56.000Z}&rows=25')

    const rqlQueryBetween = Rql('between(field,date:2020-01-01T12:34:56Z,date:2020-12-31T23:59:59Z)').toSolr({ defaultLimit: 25 })
    assert.equal(rqlQueryBetween, '&q=field:[2020-01-01T12:34:56.000Z TO 2020-12-31T23:59:59.000Z]&rows=25')

    done()
  })
})

describe('Test Solr Translation', () => {
  it('Convert and operator', (done) => {
    const parsed = Rql('and(eq(field1Name,field1Value),eq(field2Name,field2Value))').toSolr({ defaultLimit: 25 })
    assert.equal(parsed, '&q=(field1Name:field1Value AND field2Name:field2Value)&rows=25')
    done()
  })
  it('Convert or operator', (done) => {
    const parsed = Rql('or(eq(field1Name,field1Value),eq(field2Name,field2Value))').toSolr({ defaultLimit: 25 })
    assert.equal(parsed, '&q=(field1Name:field1Value OR field2Name:field2Value)&rows=25')
    done()
  })
  it('Convert eq operator', (done) => {
    const parsed = Rql('eq(fieldName,fieldValue)').toSolr({ defaultLimit: 25 })
    assert.equal(parsed, '&q=fieldName:fieldValue&rows=25')
    done()
  })
  it('Convert ne operator', (done) => {
    const parsed = Rql('ne(fieldName,fieldValue)').toSolr({ defaultLimit: 25 })
    assert.equal(parsed, '&q=!fieldName:fieldValue&rows=25')
    done()
  })
  it('Convert exists operator', (done) => {
    const parsed = Rql('exists(fieldName)').toSolr({ defaultLimit: 25 })
    assert.equal(parsed, '&q=fieldName:*&rows=25')
    done()
  })
  // match() skip
  it('Convert ge operator', (done) => {
    const parsed = Rql('ge(fieldName,fieldValue)').toSolr({ defaultLimit: 25 })
    assert.equal(parsed, '&q=fieldName:{fieldValue TO *}&rows=25')
    done()
  })
  it('Convert gt operator', (done) => {
    const parsed = Rql('gt(fieldName,fieldValue)').toSolr({ defaultLimit: 25 })
    assert.equal(parsed, '&q=fieldName:[fieldValue TO *]&rows=25')
    done()
  })
  it('Convert le operator', (done) => {
    const parsed = Rql('le(fieldName,fieldValue)').toSolr({ defaultLimit: 25 })
    assert.equal(parsed, '&q=fieldName:{* TO fieldValue}&rows=25')
    done()
  })
  it('Convert lt operator', (done) => {
    const parsed = Rql('lt(fieldName,fieldValue)').toSolr({ defaultLimit: 25 })
    assert.equal(parsed, '&q=fieldName:[* TO fieldValue]&rows=25')
    done()
  })
  it('Convert between operator', (done) => {
    const parsed = Rql('between(fieldName,lowerFieldValue,upperFieldValue)').toSolr({ defaultLimit: 25 })
    assert.equal(parsed, '&q=fieldName:[lowerFieldValue TO upperFieldValue]&rows=25')
    done()
  })
  // field() skip
  // qf() skip
  // fq() skip
  it('Convert not operator', (done) => {
    const parsed = Rql('not(fieldValue)').toSolr({ defaultLimit: 25 })
    assert.equal(parsed, '&q=NOT fieldValue&rows=25')
    done()
  })
  it('Convert in operator', (done) => {
    const parsed = Rql('in(fieldName,(fieldValue1,fieldValue2,fieldValue3))').toSolr({ defaultLimit: 25 })
    assert.equal(parsed, '&q=(fieldName:(fieldValue1 OR fieldValue2 OR fieldValue3))&rows=25')
    done()
  })
  it('Convert keyword operator', (done) => {
    const parsed = Rql('keyword(searchKeyword)').toSolr({ defaultLimit: 25 })
    assert.equal(parsed, '&q=searchKeyword&rows=25')
    done()
  })
  // distinct() skip
  it('Convert json operator', (done) => {
    const parsed = Rql('eq(a,b)&facet((field,fieldName1),(mincount,1))&json(nl,map)').toSolr({ defaultLimit: 25 })
    assert.equal(parsed, '&q=a:b&rows=25&facet=true&facet.field=fieldName1&facet.mincount=1&json.nl=map')
    done()
  })
  it('Convert facet operator', (done) => {
    const parsed = Rql('eq(a,b)&facet((field,fieldName),(mincount,1))').toSolr({ defaultLimit: 25 })
    assert.equal(parsed, '&q=a:b&rows=25&facet=true&facet.field=fieldName&facet.mincount=1')
    done()
  })
  it('Convert group operator', (done) => {
    const parsed = Rql('eq(a,b)&group((field,fieldName),(format,simple),(ngroups,true),(limit,1),(facet,true))').toSolr({ defaultLimit: 25 })
    assert.equal(parsed, '&q=a:b&rows=25&group=true&group.field=fieldName&group.format=simple&group.ngroups=true&group.limit=1&group.facet=true')
    done()
  })
  // genome() - use rql.test.genome.js
  // cursor() skip
  // values() skip
  it('Convert select operator', (done) => {
    const parsed = Rql('eq(a,b)&select(fieldName1,fieldName2,fieldName3)').toSolr({ defaultLimit: 25 })
    assert.equal(parsed, '&q=a:b&rows=25&fl=fieldName1,fieldName2,fieldName3')
    done()
  })
  it('Convert sort operator', (done) => {
    const parsed = Rql('eq(a,b)sort(+fieldName1,-fieldName2)').toSolr({ defaultLimit: 25 })
    assert.equal(parsed, '&q=a:b&rows=25&sort=fieldName1 asc, fieldName2 desc')
    done()
  })
  it('Convert limit operator', (done) => {
    const parsed = Rql('eq(a,b)limit(123456)').toSolr({ defaultLimit: 25 })
    assert.equal(parsed, '&q=a:b&rows=123456')
    done()
  })
})
