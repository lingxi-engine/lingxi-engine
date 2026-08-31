#!/bin/bash
cd "$(dirname "$0")"
export NODE_ENV=development
export ALLOW_NO_AUTH=true
exec node --import tsx index.ts