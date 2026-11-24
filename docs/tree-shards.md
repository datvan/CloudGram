# Encrypted tree shards

Records are assigned to 512 shards by FNV-1a of their id. Each shard is
compressed and encrypted separately with label `file-tree:<index>`. The server
stores opaque blobs and a version for each shard; a `since` read returns only
shards changed after that version. Writes use compare-and-swap and send dirty
shards in requests of at most 8 MiB. Shard files are versioned and metadata is
committed last, so an interrupted write leaves the previous version readable.

The first upgraded client reads the old `file-tree` blob and writes every
shard before asking the server to remove the old blob. During migration both
formats remain readable. Older clients cannot write once sharding begins.

This fixed shard count does not remove every size limit: an individual shard
is limited to 4 MiB of ciphertext. A sufficiently large or unevenly distributed
tree can still exceed that limit and requires a different subdivision scheme.
