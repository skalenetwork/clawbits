#!/usr/bin/env bash
docker compose -f ../compose.yaml -f ../compose.override.yaml stop stalwart db redis
