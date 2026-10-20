### Added
- Plan limits from an [OmniRoute](https://github.com/diegosouzapw/OmniRoute) gateway: set
  `HERDR_WEB_OMNIROUTE_URL` and `HERDR_WEB_OMNIROUTE_TOKEN` (a `read` access token) and its
  connected accounts join the meters, any provider it reports. Each provider is off until
  switched on in Settings → Subscription usage, where new ones are marked New and a long list
  gets a search; the usage panel can put the accounts closest to a limit first.
- The usage panel's account header takes two lines: name and plan, then account and source. A long
  account ellipsizes on its own line, and plans read as sold ("Max 20x", not
  `default_claude_max_20x`).
