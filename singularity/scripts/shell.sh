#!/bin/env bash

source ./instance.vars
SINGULARITY=${SINGULARITY:-"$(which singularity)"}
CUR_INST=`$SINGULARITY instance list | grep $SINGULARITY_INSTANCE`

FOUND_INSTANCE=$?

if [ $FOUND_INSTANCE -eq 0 ]; then
	$SINGULARITY shell instance://$SINGULARITY_INSTANCE
else
  echo "Instance Not Running"
	exit 1
fi
