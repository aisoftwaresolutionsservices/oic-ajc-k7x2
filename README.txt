OIC APP v2.0 (Orders Intelligent Calculator, offline + payments)
A. I. Software Solutions Services

FILES
index.html     the screens (your demo design, upgraded)
app.js         the screen logic
db.js ids.js pin.js store.js sync.js   the offline engine (see the Step-by-Step guide, Lessons 3 to 6)
settings.js    YOU EDIT THIS: web app URL and sync key
sw.js          keeps an offline copy of the app (change CACHE_VERSION whenever any file changes)
manifest.json, icon-192.png, icon-512.png, logo.jpg

START
1. Do the Code.gs steps first (Sheet, OIC Admin menu, keys, PINs, Deploy).
2. Edit settings.js: paste the Web app URL and SYNC_KEY.
3. Upload ALL these files to a GitHub repository, turn on GitHub Pages.
4. Open the link on the phone with signal ON, sign in once, then Add to Home Screen.

RULES
- Never share settings.js (it holds the sync key).
- Change CACHE_VERSION in sw.js every time you change any file.
- Use a TEST Sheet and TEST key until every test passes on real phones.
