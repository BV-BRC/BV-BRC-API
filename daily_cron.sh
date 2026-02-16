start=$(date +%s)
cd /disks/disk0/p3/production/p3-api/deployment/services/p3_api_service/app/

#
# Nov 2022 - index worker started by cron
# instead of doing a clean, we create the file clean_requested so that the worker cron can handle it next time around

#./node_modules/pm2/bin/pm2 stop p3-index-worker

# ./node_modules/pm2/bin/pm2 reload p3-api-service
#./bin/p3-clean-completed
touch clean_requested

for collection in feature_sequence genome genome_amr genome_typing genome_feature genome_sequence pathway subsystem sp_gene
do
  echo "Rebalance Leader $collection"
  curl -s "http://bio-gp1.mcs.anl.gov:8983/solr/admin/collections?action=REBALANCELEADERS&collection=$collection"
done

# restart index worker
#./node_modules/pm2/bin/pm2 start p3-index-worker

# print duration
echo "Duration: $((($(date +%s)-$start)/60)) minutes"
