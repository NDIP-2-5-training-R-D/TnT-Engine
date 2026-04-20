#!/bin/bash
helm upgrade --install tnt-engine ./helm/tnt-engine \
  -n tnt-engine --create-namespace \
  -f ./helm/values-k8s.yaml
