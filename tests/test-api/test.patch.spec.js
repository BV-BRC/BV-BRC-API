// TODO: implement a test for usecase as below.
// May need user auth that matches the ownership of the genome
// curl "http://localhost:3001/genome/83332.228" \
// -H "Authorization: " \
// -X POST -H "Content-Type:application/jsonpatch+json" \
// -d '[{"op": "add", "path": "/comments", "value": ["patch test&&&&!!&"]}]'
//
// then before it is visible, you still can check via
// curl "http://localhost:8983/solr/genome/get?id=83332.228&fl=genome_id,comments" -H "Accept: application/json"
