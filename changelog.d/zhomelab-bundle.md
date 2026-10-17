### Maintenance
- zhomelab deploy branch only: remote bundles are numbered from 1001, so a bridge installed from
  upstream's `remote-v28` release is never taken for this branch's own, and a missing local
  manifest fails instead of fetching upstream's bridge. Each change to the bundle's inputs bumps
  the number by one, which updates every connected PC's bridge.
- zhomelab bundle 1002: carries the Copilot form reader fix, so every connected PC updates its bridge.
- zhomelab bundle 1003: carries the wrapped-form reader fix.
- zhomelab bundle 1004: carries VS Code chats on the phone (the bridge reads and drives VS Code's agent host).
