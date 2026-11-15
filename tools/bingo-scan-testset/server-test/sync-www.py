# Copies the site into www/ and points the real api/config.php at the test database (the repo's config.php is untouched).
import shutil, sys, os, re
src, dst = sys.argv[1], sys.argv[2]
# copy over the existing folder so a running PHP server keeps its document root
shutil.copytree(src, dst + '/www', dirs_exist_ok=True)
p = dst + '/www/api/config.php'
s = open(p, encoding='utf-8', newline='').read()
s = s.replace("define('DB_HOST', 'localhost');", "define('DB_HOST', '127.0.0.1;port=3399');")
s = s.replace("define('DB_NAME', 'epiz_xxxxxxx_suite');", "define('DB_NAME', 'suite_test');")
s = s.replace("define('DB_USER', 'epiz_xxxxxxx');", "define('DB_USER', 'suite');")
s = s.replace("define('DB_PASS', 'your_password_here');", "define('DB_PASS', 'suite_test_pw');")
s = s.replace("define('SUITE_ADMIN_USERNAME', 'your_username_here');", "define('SUITE_ADMIN_USERNAME', 'admin_t');")
# test-only: a tiny storage cap taken from the environment, to exercise the 507 path
s = s.replace("// Optional limits for the Bingo scan training endpoint", "if (getenv('TRAINING_TEST_CAP')) { define('TRAINING_MAX_STORE_BYTES', (int)getenv('TRAINING_TEST_CAP')); }\n// Optional limits for the Bingo scan training endpoint", 1)
open(p, 'w', encoding='utf-8', newline='').write(s)
print("www ready; DB host line:", re.search(r"define\('DB_HOST'[^\n]*", s).group(0))
