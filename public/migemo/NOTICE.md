# Migemo assets bundled with kuf

These files are shipped inside the application. Filtering does not contact a CDN,
send search terms to a server, or download a dictionary at runtime.

## Engine

- Package: `jsmigemo` **0.5.2**, installed as an exact npm dependency.
- Project: https://github.com/oguna/jsmigemo
- Package archive: https://registry.npmjs.org/jsmigemo/-/jsmigemo-0.5.2.tgz
- License: MIT; see `notices/LICENSE_jsmigemo.txt`.
- The JavaScript engine is bundled by Vite from the installed npm package.

## Dictionary

- Asset: `migemo-compact-dict`, copied without modification from the
  `jsmigemo@0.5.2` npm package.
- Size: **1,384,379 bytes**.
- SHA-256: `402baabd752bfd04e48609fa02bcdd99e2853ba9a1d2959c5deb6f35c30e371e`.
- Upstream dictionary project: https://github.com/oguna/yet-another-migemo-dict
- The npm package does not identify the exact dictionary-generation revision.
  The asset is therefore pinned by the npm version, lockfile integrity, and
  binary SHA-256 above, rather than an inferred source revision.
- The upstream dictionary uses the 3-clause BSD license and incorporates Mozc
  and UniDic data. UniDic's 3-clause BSD option is used for this distribution.

The following upstream notices are included in full:

- `notices/LICENSE_yet-another-migemo-dict.txt`
- `notices/LICENSE_Mozc.txt`
- `notices/LICENSE_UniDic.txt`

These three notices were retrieved unchanged from the dictionary project's
commit `d2865ff6855f1cb9b1bc4489d66948d2f40ae8e5` on 2026-10-23:

- https://github.com/oguna/yet-another-migemo-dict/blob/d2865ff6855f1cb9b1bc4489d66948d2f40ae8e5/LICENSE
- https://github.com/oguna/yet-another-migemo-dict/blob/d2865ff6855f1cb9b1bc4489d66948d2f40ae8e5/LICENSE_Mozc
- https://github.com/oguna/yet-another-migemo-dict/blob/d2865ff6855f1cb9b1bc4489d66948d2f40ae8e5/LICENSE_UniDic

## Updating

Upgrade the exact npm dependency and lockfile deliberately, inspect its engine
and dictionary licenses, copy its dictionary to this directory, update this
notice and all applicable license texts, and rerun the real-dictionary filtering
tests. Verify the binary hash before packaging. Vite copies this entire public
directory into the development server and the packaged application.
