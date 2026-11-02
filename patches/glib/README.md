# glib 0.18.5 security backport

GTK3 still requires glib 0.18 in the Linux Tauri toolchain. This copy applies the
official fix for GHSA-wrw7-89jp-8q8g and RUSTSEC-2024-0429. It does not change
the API, package version, or licenses. Upstream metadata describes the original
source. This file describes the local change.

- Archive: https://static.crates.io/crates/glib/glib-0.18.5.crate
- SHA256: `233daaf6e83ae6a12a52055f568f9d7cf4671dabb78ff9560ab6da230ce00ee5`
- Package source: https://github.com/gtk-rs/gtk-rs-core/tree/42b9caf98e03ded086362d9653ca58fe94dc8658/glib
- Fix: https://github.com/gtk-rs/gtk-rs-core/commit/b5a4071e439bef2b5eea76c3aa25e5ae84839e34
- Upstream review: https://github.com/gtk-rs/gtk-rs-core/pull/1343
- Official backport on the 0.19 branch: https://github.com/gtk-rs/gtk-rs-core/commit/44ff04449535135aa82507ff492883bba77a9b75
- Advisory: https://rustsec.org/advisories/RUSTSEC-2024-0429.html
- License: MIT. Original notices remain in `src-tauri/vendor/glib/LICENSE`
  and `src-tauri/vendor/glib/COPYRIGHT`.

`variant-str-iter.patch` is the official diff with paths adjusted for the
published package root. It makes the output pointer given to GLib mutable.
Writing through the former immutable reference caused undefined behavior. Only
these two lines differ from the published archive. No upstream file is
reformatted or removed.

From the repository root, use Node 22, Git, and tar:

```sh
node scripts/vendor-glib.mjs --write
node scripts/vendor-glib.mjs --check
```

Both modes verify the SHA256 before extraction. `--check` rebuilds the copy in a
temporary directory. It compares the full inventory and each file byte for
byte. To use a downloaded archive, add `--archive chemin.crate`. Modify the
canonical patch and regenerate the copy. Do not edit the vendored copy.

The applicable upstream tests are `variant_iter::tests::test_variant_iter_array`,
`test_variant_str_iter_nth`, and `test_variant_str_iter_last`. Run them with
`cargo test --release --manifest-path chemin-vers-copie-temporaire/Cargo.toml variant_iter::tests::`.
The optimized mode is necessary to reproduce the defect. Isolate the process
that runs the unpatched version because it can terminate with SIGSEGV. Test a
temporary copy to keep generated files out of the vendored inventory.

Linux CI and Desktop publishing also run the six regression tests on the shipped
dependency graph. They first install the Tauri system libraries:

```sh
cargo test --manifest-path src-tauri/Cargo.toml --release --locked --test glib_variant_regression
cargo audit --file src-tauri/Cargo.lock --deny unsound
```

The inventory check runs on each Desktop platform. Git attributes preserve
upstream and patch bytes on Windows. The Cargo SBOM annotation tool records the
backport, patch SHA256, and upstream references in a supplied SBOM. It keeps the
actual 0.18.5 version.

The version remains 0.18.5. `cargo-audit 0.22.2` uses RustSec 0.33.0.
`Database::query_vulnerabilities` excludes packages without a registry source,
including local dependencies. Thus, no alert for this copy does not prove that
the defect is fixed. The verified origin, diff, and optimized tests provide the
evidence. Remove the backport when the GTK toolchain permits an officially fixed
version.
