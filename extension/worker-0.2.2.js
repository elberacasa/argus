// The service worker entry for this release. Its file name carries the version
// because Chromium keeps serving a cached worker script for an unpacked
// extension under an unchanged URL -- across a version bump and a browser
// restart (measured: the cached script predated the release it claimed to be).
// A new name is a new URL, so every release runs its own code.
importScripts("background.js?v=0.2.2");
