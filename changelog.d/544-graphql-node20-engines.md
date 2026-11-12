---
section: Fixed
---
Keep the runtime `graphql` dependency on 16.x so a Node 20 install matches `engines.node >=20.0.0` instead of resolving graphql 17, which requires Node 22+ (#544).
