#!/bin/env bash

source ./instance.vars

SINGULARITY=${SINGULARITY:-"$(which singularity)"}

CUR_INST=`$SINGULARITY instance list | grep $SINGULARITY_INSTANCE`

FOUND_INSTANCE=$?

if [ $FOUND_INSTANCE -eq 0 ]; then
	echo "Instance already running"
	$SINGULARITY run --app stop instance://$SINGULARITY_INSTANCE 
	$SINGULARITY instance stop $SINGULARITY_INSTANCE
else
	echo "Instance Not Found: $$SINGULARITY_INSTANCE"
	$SINGULARITY instance list
	exit 1
fi
