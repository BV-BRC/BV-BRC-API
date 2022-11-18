#!/bin/env bash

source ./instance.vars
SINGULARITY=${SINGULARITY:-"$(which singularity)"}

CUR_INST=`$SINGULARITY instance list | grep $SINGULARITY_INSTANCE`

FOUND_INSTANCE=$?

if [ $FOUND_INSTANCE -eq 0 ]; then
	echo "Instance already running"
	exit 1
else
	$SINGULARITY instance start --bind $SINGULARITY_BIND $SINGULARITY_CONTAINER $SINGULARITY_INSTANCE $SINGULARITY_INSTANCE
fi
