start=$(date +%s)
cd /disks/disk0/p3/production/p3-api/deployment/services/p3_api_service/app/
./node_modules/pm2/bin/pm2 stop p3-index-worker
./node_modules/pm2/bin/pm2 reload p3-api-service
./bin/p3-clean-completed

for collection in feature_sequence genome genome_amr genome_feature genome_sequence pathway subsystem sp_gene id_ref ppi protein_family_ref structured_assertion
do
  echo "Rebalance Leader $collection"
  curl -s "http://willow.mcs.anl.gov:8983/solr/admin/collections?action=REBALANCELEADERS&collection=$collection"
done

# restart index worker
./node_modules/pm2/bin/pm2 start p3-index-worker

# print duration
echo "Duration: $((($(date +%s)-$start)/60)) minutes"
