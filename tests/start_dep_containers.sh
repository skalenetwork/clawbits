#!/usr/bin/env bash
docker compose -f ../compose.yaml -f ../compose.override.yaml up -d stalwart db redis



