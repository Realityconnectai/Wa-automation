#!/usr/bin/env bash
# scripts/test/run-node24-verification.sh
# Runs full test suite and health smoke check inside an isolated Node 24 Linux environment.
set -euo pipefail

echo "========================================================"
echo " Starting Isolated Node 24 / Linux Full Suite Run"
echo " Node Version: $(node -v)"
echo " OS: $(uname -s) $(uname -m) $(cat /etc/os-release | grep PRETTY_NAME | cut -d= -f2)"
echo " Time: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo "========================================================"

cd /app

echo "--> Installing dependencies from lockfile via npm ci..."
export PUPPETEER_SKIP_DOWNLOAD=true
npm ci --silent

export ALLOW_DESTRUCTIVE_TESTING=true
export DATABASE_URL="postgresql://wa_test_user:wa_test_password_2026@127.0.0.1:5432/wa_test_app"
export NODE_ENV=test

echo "--> Running full Jest test suite under Node 24..."
npx jest --runInBand --detectOpenHandles

echo "--> Verifying application startup and health smoke check under Node 24..."
export PORT=3999
node server.js > /tmp/server.log 2>&1 &
SERVER_PID=$!

# Ensure server process is terminated on exit
trap 'kill -9 $SERVER_PID 2>/dev/null || true' EXIT

echo "--> Waiting for server to initialize..."
for i in {1..30}; do
    if node -e "require('http').get('http://127.0.0.1:3999/health', (res) => { if (res.statusCode === 200) process.exit(0); else process.exit(1); }).on('error', () => process.exit(1));" 2>/dev/null; then
        echo "--> Server is listening and healthy on port 3999!"
        break
    fi
    sleep 0.5
done

echo "--> Exercising health/ready/API smoke checks..."
node -e "
const http = require('http');
function check(path, expectedStatus) {
    return new Promise((resolve, reject) => {
        http.get('http://127.0.0.1:3999' + path, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                console.log('GET ' + path + ' -> Status ' + res.statusCode);
                if (res.statusCode === expectedStatus) resolve({ status: res.statusCode, body });
                else reject(new Error('Unexpected status for ' + path + ': ' + res.statusCode + ' ' + body));
            });
        }).on('error', reject);
    });
}

async function smoke() {
    await check('/health', 200);
    await check('/ready', 200);
    await check('/api/auth/me', 401);
    console.log('✔ All local health/ready/API smoke checks PASSED under Node 24!');
}
smoke().catch(err => {
    console.error('Smoke check failed:', err);
    process.exit(1);
});
"

echo "--> Shutting down smoke server..."
kill -TERM $SERVER_PID 2>/dev/null || true
wait $SERVER_PID 2>/dev/null || true

echo "========================================================"
echo " Isolated Node 24 / Linux Full Suite: SUCCESS"
echo "========================================================"
