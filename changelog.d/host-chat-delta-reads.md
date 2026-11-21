### Changed
- An agent host chat read again sends only the turns that changed since the device last read it,
  and a chat seen before shows at once from the device while the network catches up: on a slow
  line a big chat no longer moves megabytes on every change.
