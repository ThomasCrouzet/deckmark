# Pristine Milkdown files

These files are the unmodified contents of the `@milkdown/components` 7.23.0
npm package. `scripts/patch-milkdown-images.mjs` copies them over a cached
`node_modules` tree before it applies `image-proxy-race.patch`.

The CI `node_modules` cache key does not include the patch file. A cache entry
from another branch can therefore hold an older applied patch. The reset keeps
the pinned patch apply path deterministic without a network install and without
a workflow change.

Do not edit these files. To refresh them, extract the published package:

```sh
npm pack @milkdown/components@7.23.0
tar -xzf milkdown-components-7.23.0.tgz
```

Then copy the seven files from `package/` into this directory with the same
relative paths. Bump the version check in the patch script at the same time.
