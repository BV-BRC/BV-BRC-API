#!/bin/bash

dir=$(cd $(dirname $0); pwd)

cd $dir

if [[ -f indexer_running ]] ; then
	echo "Indexer is still running"
	ls -l indexer_running
	exit 0
fi

echo "Indexer started at `date`" > indexer_running

pmout=/tmp/pmout.$$

echo "Index start at `date`" >> index-worker.log
node --unhandled-rejections=strict --max-old-space-size=4096 bin/p3-index-worker-once  >> index-worker.log 2> $pmout 2>&1
if [[ $? -ne 0 ]] ; then
	echo "Failure on p3-index-worker" 
	echo "Index failure at `date`" >> index-worker.log
	cat $pmout >> index-worker.log
	cat $pmout
	rm $pmout
	rm indexer_running
	exit 1
fi
rm indexer_running
echo "Index complete at `date`" >> index-worker.log

#if [[ -f clean_requested ]] ; then
#	rm clean_requested
#	echo "Cleaning jobs"
#	./bin/p3-clean-completed
#fi

