#!/bin/bash

# This is the solr8 backup
exit;

BACKUP_DIR="/vol/p3solrbackup/bio-gp-backup/"
SNAPSHOT="$(date '+%Y%m%d')"
SOLR_URL="http://bio-gp1.mcs.anl.gov:8983/solr"

function synchronous_backup() {
    local collection=$1
    local snapshot=$2
    echo "Running Backup: $collection $snapshot"

    async_key="$collection.$snapshot.x"
    # fire backup call
    curl --silent "$SOLR_URL/admin/collections?action=BACKUP&name=$snapshot/$collection&collection=$collection&location=$BACKUP_DIR&async=$async_key"

    # status check
    STATUS="running"
    while [ $STATUS == "running" ]
    do
        STATUS=$(curl --silent "$SOLR_URL/admin/collections?action=REQUESTSTATUS&requestid=$async_key&wt=json" | grep "state" | sed -e 's/[{},"]/''/g' | cut -d ':' -f 2 )
        echo "[$(date '+%m/%d/%Y %H:%M:%S')] $collection $STATUS"
        sleep 2m
    done
}

# stop indexer
cd /disks/disk0/p3/production/p3-api/deployment/services/p3_api_service/app/
export PATH=/disks/patric-common/runtime/node-v14.18.0/bin:$PATH
./node_modules/pm2/bin/pm2 stop p3-index-worker

echo "# large collections in asychronous mode"
COLLECTIONS="genome_feature genome_sequence feature_sequence pathway subsystem sp_gene protein_feature"
for COLLECTION in $COLLECTIONS
do
    synchronous_backup $COLLECTION $SNAPSHOT
done


echo "# small collections in sychronous mode"
COL1="genome_amr genome_typing genome taxonomy bioset bioset_result epitope epitope_assay experiment"
COL2="protein_structure serology spike_lineage spike_variant strain surveillance"
COLLECTIONS="$COL1 $COL2"
for collection in $COLLECTIONS
do
    echo "Running Backup: $collection $SNAPSHOT"
    curl -s "$SOLR_URL/admin/collections?action=BACKUP&name=$SNAPSHOT/$collection&collection=$collection&location=$BACKUP_DIR"
done

# start indexer
# ./node_modules/pm2/bin/pm2 start p3-index-worker
