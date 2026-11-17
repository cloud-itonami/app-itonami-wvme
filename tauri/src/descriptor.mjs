// kotoba.app.client-runtime.v1 descriptor for the Tauri host. Pure data: tests import it too.
// Every external operation must be declared here with consent "each-operation"; anything
// not declared is refused by the host and blocked by the CSP derived from this file.
export const descriptor = {
  "schema": "kotoba.app.client-runtime.v1",
  "target": "browser",
  "profile": "trusted-page-v1",
  "entry": "index.html",
  "local-state": {
    "adapter": "memory",
    "schema": "wvme.session.v1",
    "version": 1
  },
  "workers": [],
  "operations": []
};

export const requestedCapabilities = (d) => [...new Set(d.operations.map((o) => o.capability))];
