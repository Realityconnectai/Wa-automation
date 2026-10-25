const assert = require('assert');
const {
    createSessionToken,
    verifySessionToken,
    blacklistToken,
    isTokenBlacklisted,
    revokeSession,
    revokeAllSessionsForUser,
    getAllTokensFromRequest,
    getTokenFromRequest
} = require('../src/config/auth');

console.log('Testing WhatsApp Automation Token Revocation...');

const fakeUser = { id: 42, role: 'user', auth_version: 1 };
const accessToken = createSessionToken(fakeUser, 'access');
assert(accessToken, 'Access token should be created');

// 1. Verify token works initially
const payload = verifySessionToken(accessToken, 'access');
assert(payload && payload.id === 42, 'Valid token should be verified');
assert(!isTokenBlacklisted(accessToken), 'Token should not be blacklisted initially');

// 2. Test getAllTokensFromRequest with Bearer header
const mockReqBearer = {
    headers: {
        authorization: 'Bearer ' + accessToken
    }
};
const extracted = getAllTokensFromRequest(mockReqBearer);
assert(extracted.includes(accessToken), 'getAllTokensFromRequest should extract Bearer token');

// 3. Test revokeSession invalidates Bearer token
const mockRes = {
    setHeader: () => {}
};
revokeSession(mockReqBearer, mockRes);

assert(isTokenBlacklisted(accessToken), 'Bearer token should be blacklisted after revokeSession');
const afterPayload = verifySessionToken(accessToken, 'access');
assert(afterPayload === null, 'Blacklisted token must fail verifySessionToken');
console.log('PASSED: Logout blacklists Bearer access token');

// 4. Test revokeAllSessionsForUser (password change)
const newAccessToken = createSessionToken(fakeUser, 'access');
assert(verifySessionToken(newAccessToken, 'access') !== null, 'New token should verify');
revokeAllSessionsForUser(fakeUser.id);
const revokedPayload = verifySessionToken(newAccessToken, 'access');
assert(revokedPayload === null, 'revokeAllSessionsForUser must void previous tokens for user');
console.log('PASSED: revokeAllSessionsForUser invalidates all previous tokens');

// 5. Test CORS and Origin filtering logic
const { isOriginAllowed } = require('../src/config/cors');

assert(isOriginAllowed('https://workpilots.dpdns.org') === true, 'Own domain must be allowed');
assert(isOriginAllowed('https://leadfinder.workpilot.co.in') === true, 'Subdomain must be allowed');
assert(isOriginAllowed('https://sub.workpilot.co.in') === true, 'Any workpilot subdomain allowed');
assert(isOriginAllowed('https://enunciate-graves-dry.ngrok-free.dev') === true, 'Configured ngrok tunnel must be allowed');
assert(isOriginAllowed('https://evil-attacker.com') === false, 'Attacker domain must be blocked');
assert(isOriginAllowed('https://phishing-workpilot.com') === false, 'Phishing domain must be blocked');
assert(isOriginAllowed('http://malicious.org') === false, 'Malicious domain must be blocked');
console.log('PASSED: CORS origin validation tests');

console.log('\nALL WHATSAPP AUTOMATION SECURITY TESTS PASSED SUCCESSFULLY!');
