#!/bin/sh

NAME="p3_api"
VERSION=`cat package.json | jq -r .version`;
IMAGE_NAME=$NAME-$VERSION.sif

sudo singularity build $IMAGE_NAME singularity/singularity.def
