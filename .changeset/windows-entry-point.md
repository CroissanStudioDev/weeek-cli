---
'weeek-cli': patch
---

Fix the CLI doing nothing when installed from npm on Windows.

The entry point decided whether it had been started as a program by comparing `import.meta.url`
with `"file://" + process.argv[1]`. That concatenation only produces a valid URL on POSIX: on
Windows argv[1] is `C:\dir\weeek.js` while the URL is `file:///C:/dir/weeek.js`, so the check
never matched, `main()` never ran, and every command exited 0 having printed nothing. The paths
are now compared as paths.
