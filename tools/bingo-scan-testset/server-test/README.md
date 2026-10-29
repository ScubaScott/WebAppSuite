# Training endpoint tests (step 1.6)

These tests run the real `htdocs/api/training.php` code on PHP with a real MySQL-compatible database, and the real Scan
page in Chrome against it. Nothing here touches the production database; the repo's `api/config.php` is not modified (a
copy of the site is pointed at the test database).

| File | What it does |
|---|---|
| `server-test.js` | 93 checks of `/api/training` over HTTP and in the database: uploads, every validation rule, size/rate/storage limits, who may use the admin routes, stats, paging, status changes, delete and purge |
| `training-e2e-test.js` | about 38 checks in Chrome: scan a photo, confirm the card, and see the sample arrive in MySQL; first-scan notice, settings, photo option, offline queue, export backup, "collection is full" pause |
| `make-fixtures.py` | makes the test images (needs Pillow) |
| `router.php` | stands in for the `.htaccess` rewrite rules when using PHP's built-in server |
| `sync-www.py` | copies `htdocs` to a test folder and points its `config.php` at the test database (and adds a test-only storage cap taken from an environment variable) |
| `seed.sql` | test accounts: admin, regular user, admin without a password |

The imaging-side logic of the store (`../imaging-test/training-store-test.js`) needs only Node.

## Running them
Tested with PHP 8.3 (NTS, with `pdo_mysql`) and MariaDB 10.11, the closest portable match to the production host.

1. Start a database on a private port with an empty `suite_test` database and a user the tests can use; install nothing into the repo.
2. `python sync-www.py <repo>/htdocs <work folder>` makes `<work folder>/www` (edit the host, port and credentials near the top if yours differ).
3. Start two PHP servers from `<work folder>`: `php -S 127.0.0.1:8081 -t www router.php` and the same on 8082 with the environment variable `TRAINING_TEST_CAP=60000` (a tiny storage cap).
4. Call `http://127.0.0.1:8081/api/cards` once (it creates the tables from `schema.sql`, which also tests that file), then run `seed.sql` on the database.
5. `python make-fixtures.py <work folder>/fixtures`
6. `node server-test.js` with these environment variables: `BASE=http://127.0.0.1:8081 CAP_BASE=http://127.0.0.1:8082 CAP_BYTES=60000 ADMIN_TOKEN=admintoken0123456789abcdef0123456789abcdef PLAIN_TOKEN=plaintoken0123456789abcdef0123456789abcdef NOPASS_TOKEN=nopasstoken0123456789abcdef0123456789abcdef FIXTURES=<work folder>/fixtures MARIADB=<path to the mariadb client> DBPORT=<port> DBNAME=suite_test`
7. `node training-e2e-test.js` (needs `puppeteer-core`, as for the other browser tests; run `sync-www.py` again first if the client code changed) with `BASE`, `CAP_BASE`, `REPO` (the repo folder), `MARIADB`, `DBPORT`, `DBNAME`, `CHROME` (path to Chrome) and `PROFILE` (a short folder path prefix for the browser profiles).

`server-test-last.txt` and `training-e2e-last.txt` are the output of the last passing runs (93 and 41 checks).
