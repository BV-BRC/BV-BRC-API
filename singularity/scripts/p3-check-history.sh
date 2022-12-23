#!/bin/env bash

source ./instance.vars
SINGULARITY=${SINGULARITY:-"$(which singularity)"}

CUR_INST=`$SINGULARITY instance list | grep $SINGULARITY_INSTANCE`

FOUND_INSTANCE=$?

if [ $FOUND_INSTANCE -eq 0 ]; then
	echo "Instance running:"
	$SINGULARITY run --app p3-check-history instance://$SINGULARITY_INSTANCE
else
  echo "Instance not running."
	exit 1
fi
